# Mobile Catch-up Performance

Status: unreleased Evolu 7 optimizations, measured on Android on 2026-11-27.
Proposed release: 0.9.0. Actual desktop Obsidian acceptance testing remains open.

## Where the time went

Relay delivery and local materialization are separate stages. During the restore,
7,051 file-update rows arrived in 40.051 seconds (about 176 rows/second), while
initial local checkpoints took several minutes for 50 paths. Network download
was not the principal measured bottleneck.

The plugin uses a custom sql.js asm.js driver because Evolu's web platform needs
browser facilities unavailable in Obsidian's CommonJS plugin runtime. See the
[platform rationale](../README.md#custom-platform-layer-replacing-evoluweb) and
[Evolu 8 migration PRD](../../docs/prd/obsidian-local-sync-evolu-8-migration.md).
This work keeps Evolu 7.4.1 and the current database format.

Persistence exports the entire database image. The measured image grew from
roughly 77 MB to 83 MB during recovery. Obsidian 1.15.1's Android binary adapter
already divides large writes into internal 1 MiB chunks, but its outer call holds
the shared vault IO queue throughout. Its byte-array/base64 conversion also
creates substantial allocation pressure. This makes both adapter contention and
query refreshes relevant; an `applyMs` timer is not a Yjs-only CPU measurement.

## Implemented behavior

### Ordered inbox queries

File and setting inboxes now have `(isDeleted, createdAt, id)` indexes. Their
ordering spans all paths, so the existing per-path indexes cannot serve it.
The actual file query previously scanned and built a temporary ordering tree.
Read-only comparison on the saved phone DB returned identical ordered row IDs
with the new index.

An isolated workstation benchmark using the same sql.js engine, 12,294 rows,
2 KiB payloads and a 500-row page measured median query time over 15 runs:
57.25 ms before, 4.01 ms after (14.3× for this query). This is not an Android
or whole-restore speedup. Later inbox positions still scan past processed rows.

### Database persistence

Automatic saves retain their five-second scheduling interval, but queued automatic
requests coalesce before exporting. An active write is never cancelled. Explicit
checkpoints cancel pending automatic work and retain their own captured snapshot
and acknowledgement. A failure rejects that caller while allowing later retries.
Flush failures now propagate; dirty disposal captures the final image before
closing SQLite.

The driver tracks mutation and successfully persisted revisions. A clean explicit
checkpoint avoids exporting or rewriting the same image. Every attempted SQL
mutation, including DDL, transaction control and failed statements, conservatively
marks the driver dirty. Edits during IO remain dirty; failed writes never advance
the durable revision. No canonical/derived autosave suppression was introduced.

Mobile writes use sequential outer adapter calls capped at 256 KiB. They write a
unique temporary file, verify its complete byte length, and only then use the
existing replacement routine. Partial/failed appends reject persistence and are
not retried in place. Desktop and adapters without `appendBinary` keep the
single-write path. sql.js still exports a full image; this is not incremental
storage. The existing remove-then-rename compatibility fallback is unchanged and
does not provide a new power-loss atomicity guarantee.

### Materialization and checkpoints

A checkpoint retains this recovery sequence:

1. Persist incoming rows before journal references can become necessary.
2. Save the apply journal for the selected paths.
3. Apply files/settings and store their snapshots.
4. Publish processed markers in bounded groups of 250 and await acknowledgements.
5. Persist the completed database state.
6. Clear the journal only after success.

Failed setting writes now leave their journal and markers pending. Restart replay,
local drift protection and remote delete boundaries retain their existing roles.
Processed-marker batching reduces mutation groups, but has no isolated measured
end-to-end speed gain.

Closing or evicting a Yjs document skips an unchanged snapshot only if that exact
encoded CRDT state and path were already acknowledged. Text equality alone is
insufficient. Pending acknowledgements, renames, tombstones and local outgoing
updates are covered by tests; the cache uses weak references to document keys.

The new checkpoint default is **100 paths**, previously 50. Plugin settings migrate
the old default once, preserving non-default values and later user choices,
including an intentional return to 50. An old explicitly chosen value of 50 is
indistinguishable from the old default and therefore migrates too. The daemon uses
100 when `LOCALSYNC_INBOX_CHECKPOINT_BATCH_PATHS` is unset; an explicitly configured
value remains unchanged. Incoming page size stays 500 and the document LRU stays
50. Larger checkpoints may replay more work after interruption.

### Progress and app lifecycle

The compact notice shows change count/percentage above a thin full-width bar,
with an approximate ETA and an open-app hint below. It distinguishes application
from saving. Displayed counts do not move backwards within a run, but restart
starts a new pending-work count rather than retaining the previous denominator.

ETA uses the last five fully saved checkpoints, needs at least two samples and
30 seconds, and includes persistence/journal time. Hidden intervals invalidate
samples so suspension does not distort the foreground estimate. Changing backlog
can change the estimate; it is not a completion guarantee.

Focus loss and document visibility no longer pause a loaded engine. Sync continues
while the host permits execution; visibility controls ETA sampling. Android/iOS can
still suspend or terminate Obsidian. This is not a native background service.
The lifecycle change is unit tested but has not yet been installed on the phone.
The approved compact stylesheet is now persisted on the phone as well as applied
live; earlier live-only previews were lost when Obsidian restarted.

## Device measurements

These are successive checkpoints during one evolving restore, not randomized
replays of identical inputs. Work mix, database growth, cache state and graph
rendering differ. Exclude intervals spanning app suspension from throughput claims.

| Build / conditions | Paths per checkpoint | Observed elapsed seconds | Interpretation |
| --- | ---: | --- | --- |
| Published baseline | 50 | 273, 305, 406, 438 | Initial multi-minute local catch-up |
| Inbox indexes | 50 | 140, 204, 268 | Encouraging; query-only gain separately verified |
| Plus automatic-save coalescing | 50 | 208, 273, 288 | No sustained isolated speed gain established |
| Plus marker batching | 50 | 318, 342, 363 | No end-to-end gain established |
| Plus 256 KiB mobile writes, graph active | 50 | 116, 147 | Faster observed batches; less sampled allocation pressure |
| Lightweight pane, graph hidden/closing | 50 | 76, 77, 79 | View rendering was relevant |
| Graph fully closed, repeat sample | 50 | 81, 86, 88 | Persistence still dominated |
| Plus clean saves, unchanged snapshots, 100 paths | 100 | 74, 79, 80, 80, 82 | Roughly twice the path throughput of the preceding 50-path samples |
| Same 100-path build after later restart | 100 | 84, 91, 98 | Incoming save remained 1 ms; work mix still varies |

The last combined trial changed checkpoint size and code together: it does not
isolate each change's contribution. Its first 174-second batch spanned backgrounding
and is excluded. Later timings support the improvement without proving a universal
ratio or a full-restore completion time.

Two especially direct observations:

- Native file sampling found consecutive byte-identical 82,522,112-byte committed
  images about 21 seconds apart. With clean-save tracking, incoming persistence
  dropped from about 17–21 seconds to **0–2 ms** in subsequent checkpoints.
- In phase-dependent CPU profiles, sampled GC fell from **28.4% to 3.1%** after
  bounded writes; binary conversion/bridge samples fell from **30.9% to 1.1%**.
  The later profile had 44% graph rendering. These windows locate costs; they
  are not comparable whole-restore CPU budgets or peak-memory measurements.

A hidden, zero-sized graph leaf still rendered. Fully detaching it removed graph
stacks from the next profile, but did not establish an additional throughput gain
over using a lightweight active pane. Closing every tab is unnecessary.

A frozen 60-second graph-free sample recorded 767 append requests and two initial
binary writes, requesting about 201 MB. Twelve Yjs content builds totalled 26 ms;
12 note writes took 2.031 seconds inclusive and 26 snapshot saves 4.183 seconds
inclusive. Nested/concurrent timers are not additive. A completed explicit save
alone took 40.089 seconds. This supports reducing full-image IO before optimizing
Yjs replay. Temporary diagnostic wrappers were removed afterward.

## Verification and release gaps

Automated tests exercise real sql.js persistence/reopen, queued writes, failure
retry, edits during IO, flush/disposal, clean barriers, DDL/rollback, chunk offsets,
short/duplicate appends, delayed acknowledgement, journal interruption/replay,
setting failures, deletes, source-version changes, snapshot acknowledgement,
100-path batches, defaults migration, progress rendering and ETA lifecycle.

Final local validation: **115 tests passed**, TypeScript checking passed, plugin
build passed, and daemon build/offline smoke passed. Code, tests, stylesheet and
documentation diffs were reviewed together before committing. The phone still
runs the earlier local performance/ETA build; the final lifecycle and defaults
migration changes are covered locally but await host acceptance testing.

Privately copied committed phone images passed SQLite `integrity_check`, retained
the restored owner and contained no updates authored by the current phone peer.
Those earlier checks did not prove complete vault convergence. The restore later
finished; path and sampled-content checks are recorded below.
No canonical history was deleted and no healthy workstation/archive DB was reset.

Before release, run one focused acceptance round on the final candidate:

- Real desktop Obsidian with isolated synthetic vaults/owner: restore, edit both
  directions, delete, unfocus/refocus, reload and reopen. Shared unit tests and
  daemon smoke tests do not substitute for the actual Electron host.
- Android: install the final lifecycle/defaults build, verify persisted styling,
  briefly switch apps, then interrupt/relaunch during a checkpoint and verify
  recovery, owner identity and absence of outgoing echoes.
- Check normal small-update latency after catch-up and preserve custom settings.

The existing read-error handling can treat a failed DB read as a missing DB in
both plugin IO and the driver. This is a separate unresolved recovery concern,
not a proven explanation for the original phone owner mismatch. Investigate it
explicitly rather than claiming the performance changes fix that incident.

## 200-path cap follow-up

A live configuration-only trial raised the cap to 200, holding LRU 50, inbox page
500 and the installed build fixed. The app remained visible. The cap is already
queue-adaptive in a simple sense: it takes up to the available eligible paths
immediately, without waiting for a batch to fill. Update rows and distinct paths
must not be conflated.

| Actual paths / rows | Incoming save | Apply | Final save | Total |
| --- | --- | --- | --- | --- |
| 107 / 500 | 1 ms | 77.394 s | 27.117 s | 104.732 s |
| 178 / 500 | 2 ms | 144.878 s | 31.844 s | 176.883 s |

Combined throughput was about 60.7 paths/minute. Two neighboring 100-path batches
(95.089 and 102.041 seconds) combined to about 60.9 paths/minute. Inputs differ,
so this is not a controlled equivalence test; it establishes no additional speed
benefit. Neither journal filled the 200 cap. The 500-row inbox pages and repeated
updates for the same notes limited the distinct-path batches. The live cap was
restored to 100; the release default remains 100.

Tests now explicitly cover both 100- and 200-path success, failure on the last
path and replay without outgoing echoes. A separate seven-path test verifies
that the 200 cap never waits for more work. Larger remote checkpoints preserve
the incoming-save/journal/final-save ordering; their main recovery tradeoff is
more replay work, not a longer autosave interval for local edits. Actual device
process-kill recovery on the final candidate is still an acceptance-test gap.

A bounded 200 ms event-loop heartbeat during the trial ran for 180.447 seconds:
570 ticks, p95 excess delay 499.6 ms, maximum 1,858.8 ms, and 29 excess delays
over 500 ms. These measure scheduling stalls, not input-to-paint latency, and
there is no matching 100-path heartbeat baseline. They do show that improved
throughput has not removed noticeable UI stalls. The sampler stopped itself and
its temporary state was removed. Final counters retained the expected owner,
no Evolu error and zero current-phone-origin updates; restore was still ongoing.

A full 12,000-update / 2,500-note fresh restore is provisionally budgeted at
**30–60 minutes**, extrapolated from varying observed path/message rates. It is
not a measured start-to-finish result for the final build. Revisited paths and
changing work mix matter. Keeping the app open should allow browsing restored
notes; reducing main-thread stalls is a separate acceptance goal from total time.

## Final catch-up, LRU trial and content verification

Catch-up completed on 2026-11-27 at approximately 22:04 Europe/Bratislava. The
engine subsequently reported `caught-up`, empty pending inboxes, no Evolu error,
the expected owner and zero file updates authored by this phone's current peer.
This restore changed builds/settings along the way; its overall wall time must
not be presented as a fresh-restore benchmark of the final candidate.

A bounded live trial raised only the document LRU from 50 to 100, keeping the
checkpoint cap at 100 and inbox page at 500. It reached 100 retained documents.
In the 29-second baseline window, 17 evictions took 30.1 ms inclusive, versus
9.536 seconds in 34 snapshot-save calls (including deduplicated close calls).
During the subsequent LRU-100 window, 30 close calls took 31.3 ms inclusive,
while 110 snapshot-save calls took 46.160 seconds. Calls overlap/nest and work
mix differs; these totals are not additive or a controlled throughput comparison.
The final checkpoint also spans the setting change. No isolated throughput gain
was established. Eviction is already cheap after unchanged-snapshot suppression,
so a larger cache is not the strongest remaining lever. The timer restored the
old limit, wrappers were removed and the retained cache was trimmed back to 50.

CPU profiles mapped with the installed phone source map showed query-refresh
stacks at 61.0% in a 26.2-second baseline window and 51.6% in a 25.3-second
LRU-100 window. Yjs was 0.3%/0.2%, GC 1.0% in both, and binary bridging 4.8%
in both. The different phases prevent interpreting those shares as a controlled
LRU improvement. SQLite/query work remains the dominant sampled activity.

Inspection of Evolu's mutation handler confirms that local snapshot mutations
reload subscribed queries, including the pending inbox queries that do not read
snapshots. A workstation benchmark on a private completed-DB copy used the same
sql.js asm.js engine. The saved image passed `integrity_check = ok`.

| Query scenario | Full inbox median | Metadata-only median |
| --- | ---: | ---: |
| Fully caught up, zero rows returned | 39.18 ms | 36.61 ms |
| Last 500 updates made pending in the in-memory copy only | 83.84 ms | 79.96 ms |

Each median uses ten measured runs after two warmups. The query plan uses the
new ordered index and processed-row covering index. Removing payload columns
alone provides little improvement in this late-history case: the anti-join still
traverses processed history. These are workstation timings, not phone timings.
The saved DB and the live phone were not modified by the benchmark.

After the phone reported caught up, a read-only comparison against the workstation
vault found **2,357 Markdown paths on each**, with no missing or extra paths.
A fresh random sample of **118 notes (5.0%)** matched byte-for-byte using SHA-256.
The workstation files were hashed before and after each comparison batch to
exclude concurrent edits; none changed. No note contents were printed or saved
in the report. This is strong sample evidence, not an exhaustive content audit.
The private report retains the random seed, sampled paths and hashes.

### Boundary reload candidate (installed, awaiting phone reset trial)

The installed local test build detaches only the pending file/settings inbox subscriptions
while applying a journal and performing its persistence barriers. Relay delivery,
canonical mutations and autosave stay active. After success or failure it restores
subscriptions and awaits both pending pages before taking more journal work.
The initial load is drained before detachment because Evolu caches load promises.
Generation guards ignore retired listeners and late load callbacks. A rejected
reload prevents `caught-up` and is retried by the existing poll timer even if the
in-memory pending map is empty. Stop prevents reattachment; configuration changes
during application take effect at the next boundary. Startup journal recovery
still occurs before subscriptions are started. Batch timing/ETA include the
boundary reload.

Tests cover callback retirement, initial and boundary load failure, vault/marker/
journal/final-save failure, stop during a checkpoint and configuration changes
while detached. An offline integration test uses real Evolu 7 and the sql.js
adapter, not a query-cache mock. It injects a newer source version, new file,
remote delete, setting update and intentional local edit while detached, verifies
fresh pending pages and final contents, and checks that only the intentional edit
produces an outgoing update. Snapshot mutations execute no subscribed inbox reads
in that test. **127 tests pass**, plus typechecking, plugin build and daemon smoke.
This establishes automated behavior, not a new real-phone throughput result.

The candidate was installed after a graceful stop/flush and private backup.
Database and settings hashes were preserved during installation. Main bundle
SHA-256: `078ea6623679f271989f8f186912e052affd0a37d67a5c48110ed6f1921141ef`.
After restart the phone retained 2,357 Markdown notes, the same owner/device,
zero phone-origin file updates, two active inbox subscriptions, empty pending
queues and `caught-up` with no Evolu error. The defaults migration recorded its
one-time marker and retained checkpoint 100, LRU 50 and inbox page 500. No reset
was triggered during installation; package/manifest remain unreleased 0.8.6.

The next phone restore should retain checkpoint cap 100, LRU 50 and inbox page
500. Compare checkpoint phase times and event-loop stalls against the recorded
baseline, then repeat path/content validation after catch-up. Publish no speedup
claim until that trial completes.

## Untried options

| Option | Expected benefit / reason to defer |
| --- | --- |
| 512 KiB vs 256 KiB chunks | Fewer bridge calls vs more encoder allocation; no controlled sweep yet. |
| LRU 200 vs 50 | LRU 100 was tried without an isolated gain; eviction is already cheap. 200 remains untested. |
| Inbox page 1,000 vs 500 | More path coalescing vs larger query payloads/stalls; not yet measured. |
| Cross-page path coalescing | Fewer repeated writes to hot files; needs delete/version-boundary tests. |
| Metadata-only inbox subscriptions | Avoid repeatedly loading large payloads; requires race-safe payload lookup. |
| Selective derived-state autosave suppression | Fewer active full-image writes; requires reliable SQL change classification and crash tests. |
| Cooperative scheduling / visible-note priority | Better responsiveness; throughput benefit not assumed. |
| Prepared statements / alternative SQLite driver | Possible query CPU reduction; validate plugin runtime compatibility. |
| Incremental storage / history checkpoints | Larger architectural projects preserving late-peer recovery. |
| Evolu 8 | Separate migration; does not automatically replace LocalSync indexes, materialization or custom storage. |
| Native background execution | Separate host/platform work; JavaScript cannot guarantee OS execution. |

The inspected DB had zero freelist pages, so vacuum is not a measured first lever.
Its largest allocations were canonical Evolu history and file-update payloads;
removing them is not a safe cache-cleaning optimization. Raising LRU limits alone
also does not remove full-image persistence.

A repeat 100-vs-200 checkpoint experiment would need identical input snapshots
and a page containing enough distinct paths to exercise the cap. Prioritize the
redundant query-refresh candidate and outstanding compatibility/recovery checks;
there is no need to delay this release for every remaining optimization.
