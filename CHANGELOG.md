# Changelog

## 0.2.7 — 2026-06-04

### Fixed

- **Repair files with local snapshots but missing sync history**:
  startup now compares tracked vault paths and local `_fileSnapshot` rows against
  visible `fileUpdate` history.  If a vault file exists locally but has no
  present `fileUpdate`, LocalSync retransmits a deterministic full-state update
  so fresh peers can restore it.  This repairs older states where an interrupted
  run left files snapshotted locally but never advertised through Evolu history.

- **Prevent snapshots after failed outgoing flushes**:
  `flushOutgoingUpdates` now reports success/failure and keeps pending updates
  until the `fileUpdate` upsert succeeds.  LRU eviction and shutdown skip saving
  a fresh `_fileSnapshot` when outgoing sync failed, preventing local-only
  snapshots from masking unsent file updates.

- **Sync empty files correctly**:
  empty newly-created files now advertise a full empty state, and remote empty
  file updates create the missing vault file instead of being skipped as
  "unchanged".  This prevents empty-file updates from later being mistaken for
  offline deletes on the receiving peer.

### Added

- **Sync inventory diagnostics**:
  startup logs compare vault-tracked files, local snapshots, tombstones, and
  `fileUpdate` history counts at `startup-scan-done` and `history-quiet`.
  Samples of missing paths are included to make future sync-state investigations
  observable from exported Obsidian logs.

## 0.2.6 — 2026-06-02

### Changed

- **Quieter runtime logs**:
  added the `debug` log level and moved high-volume LRU cache messages out of
  normal `info` logs.  This keeps startup and sync diagnostics readable while
  still allowing detailed cache tracing when needed.

## 0.2.5 — 2026-06-02

### Changed

- **Structured log messages render inline**:
  log payloads are now formatted into the message text as JSON across the
  plugin, daemon, Evolu client, and SQLite driver.  Exported browser logs now
  preserve the important context instead of showing only a generic message with
  a detached object.

## 0.2.4 — 2026-06-02

### Added

- **Configurable path policy**:
  include extensions and exclude patterns are configurable for both the Obsidian
  plugin and standalone daemon.  Excludes support gitignore-style negation so a
  broad ignore such as `.obsidian/**` can keep selected files or folders.

- **Canvas sync by default**:
  `.canvas` files are included in the default sync policy alongside Markdown and
  text files.

- **Plugin settings for sync policy**:
  the Obsidian settings tab now exposes include extensions, exclude patterns,
  startup scan, and offline delete behavior.

### Changed

- **Plugin display name**:
  renamed the visible Obsidian plugin name to `LocalSync`.

- **More observable startup filtering**:
  startup scan logging now reports policy decisions so skipped files are easier
  to diagnose.

## 0.2.3 — 2026-05-26

### Fixed

- **Daemon owner restore reads the DB first**:
  daemon startup now prefers the owner already stored in the SQLite DB and only
  restores `LOCALSYNC_MNEMONIC` when the DB owner is missing, unreadable, or
  different.  Owner reads are bounded by `LOCALSYNC_OWNER_READ_TIMEOUT_MS`.

- **Atomic daemon DB writes**:
  DB export writes now go through a temporary file and rename, reducing the
  chance of a malformed SQLite image after interruption.

## 0.2.2 — 2026-05-26

### Fixed

- **Avoid unbounded app owner waits during daemon mnemonic startup**:
  daemon startup stopped relying on an unresolved `evolu.appOwner` promise for
  every mnemonic check.  A local owner marker was introduced so the daemon could
  restore only when needed instead of hanging before startup.

## 0.2.1 — 2026-05-26

### Fixed

- **Bound daemon owner lookup while restoring mnemonic**:
  `LOCALSYNC_MNEMONIC` startup gained a timeout around owner lookup so unresolved
  Evolu owner reads did not leave top-level await unsettled and terminate the
  daemon with exit code 13.

- **Daemon smoke coverage for mnemonic restore**:
  the daemon smoke test now starts with a generated mnemonic and verifies the
  restore path.

## 0.2.0 — 2026-05-25

### Added

- **Standalone daemon**:
  added a Node.js daemon build that can sync a vault directory outside Obsidian,
  using the shared sync core and filesystem-backed vault adapter.

- **Daemon container release pipeline**:
  added Dockerfile, GitLab CI image publishing, and a daemon runtime smoke test
  so Kubernetes sidecars can be built and verified from the same project.

### Changed

- **Shared sync core**:
  refactored the Obsidian plugin internals around an explicit vault adapter
  boundary so the plugin and daemon use the same reconciliation engine.

## 0.1.4 — 2026-02-25

### Changed

- **`src/engine.ts` — O(1) LRU eviction (PERF-2)**:
  LRU eviction previously scanned all open docs on every eviction to find the
  oldest entry.  JavaScript's `Map` preserves insertion order, so LRU order can
  be maintained for free: `touch(path, st)` deletes and re-inserts the entry to
  move it to the end (most-recently-used).  `enforceLruLimit` now takes the
  first entry (least-recently-used) directly — O(1) regardless of `maxOpenDocs`.
  The `lastUsedMs` timestamp field has been removed from `FileState`.

- **`src/main.ts` / `src/evoluClient.ts` — eliminate remaining `any` types (QUAL-1)**:
  `btn_restore` and `btn_reset` in the settings tab typed as `ButtonComponent`.
  `_cached.evolu` in `evoluClient.ts` typed as `Evolu<Database>`.  No functional
  change; type-checker now covers all Evolu API call sites in the plugin.

## 0.1.3 — 2026-02-25

### Changed

- **`src/engine.ts` — N+1 query reduced to 2 (ARCH-2)**:
  Previously, `pollHistoryOnce` fetched history row IDs from `evolu_history`
  and then issued a separate DB query per row to look up `path`, `updateBase64`,
  and `type` from `fileUpdate` (`applyFileUpdateRowById`).  A batch of 500
  rows produced 501 DB round-trips per poll cycle.

  A `JOIN` between the two tables was not possible: `evolu_history.id` is
  stored as a SQLite BLOB while `fileUpdate.id` is TEXT.  A BLOB/TEXT join
  predicate never matches in SQLite.

  Replaced with two queries: the original `evolu_history` query to fetch IDs
  in timestamp order, followed by one `fileUpdate WHERE id IN (...)` batch
  query to fetch all row fields at once.  `applyFileUpdateRowById` has been
  removed — its logic is now inlined in the poll loop.

  A **look-ahead pass** pre-scans the batch before processing begins.  For
  each path it records the index of the last delete row in the batch.  A
  content write (`vault.modify` / `vault.create`) is skipped only when a
  delete row for the same path appears at a **later** index — not when the
  delete is earlier (which would be a delete-then-recreate sequence).  This
  eliminates the Obsidian internal metadata race that logged spurious
  `"File does not exist"` console errors when a content update and a
  subsequent delete for the same file appeared in the same poll batch, while
  correctly syncing files that were deleted and then re-created.

## 0.1.2 — 2026-02-25

### Fixed

- **`src/engine.ts` — delete echo loop on seeding (BUG-24)**:
  When `applyFileUpdateRowById` processed a remote delete and called
  `vault.trash()`, Obsidian fired the vault `"delete"` event synchronously.
  This triggered `onVaultFileDeleted`, which emitted a new `fileUpdate { type:
  "delete" }` row back to the relay.  A device that was just seeding (receiving
  history for the first time) would echo every delete it processed — if another
  device had since re-created the file at the same path, the echo caused it to
  be deleted again.

  Same class of bug as BUG-17 (content echo loop, fixed in 0.0.7 via
  `ignoreNextVaultModify`).  Fixed by adding a `pendingRemoteDeletes:
  Set<string>` to `YjsEvoluHistoryEngine`:  the path is added before
  `vault.trash()` and removed in a `finally` block;  `onVaultFileDeleted`
  returns early without emitting if the path is present in this set.

## 0.1.1 — 2026-02-24

### Fixed

- **`src/sqliteDriver.ts`, `src/main.ts` — plugin fails to load on Android (BUG-22)**:
  `sqliteDriver.ts` imported `node:fs` and `node:path` directly; `main.ts` used
  `FileSystemAdapter.getBasePath()` combined with `path.join()` to compute the
  database path.  Android's Obsidian app runs in a WebView with no Node.js
  runtime — both imports threw `ReferenceError` on module evaluation, preventing
  the plugin from loading at all.

  Fixed by replacing all `fs`/`path` usage with a `PlatformIO` interface
  (`readFile: () => Promise<Uint8Array | null>`, `writeFile: (data: Uint8Array) =>
  Promise<void>`).  Both methods are implemented via `app.vault.adapter.readBinary`
  / `writeBinary` — Obsidian's cross-platform `DataAdapter` API, which works
  identically on desktop (backed by Node `fs` internally) and mobile (backed by
  Capacitor file access).  The `flush()` call in `sqliteDriver.ts` is now async
  and properly awaited in `restartEngine()`.

- **`esbuild.config.mjs` — `ReferenceError: process is not defined` on Android (BUG-23)**:
  esbuild `platform:"node"` caused it to resolve `msgpackr` to its Node.js entry
  point (`msgpackr/node-index.js`), which executes
  `process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED` at module load time —
  before any polyfill could run.  On Android `process` is not a global, so the
  bundle crashed immediately.

  A `globalThis.process` polyfill prepended to the banner was insufficient:
  the identifier `process` is emitted directly in the module scope by esbuild
  and the runtime lookup on Android did not reach `globalThis`.

  Fixed by switching esbuild to `platform:"browser"`, which causes it to resolve
  packages using their `browser` export condition.  `msgpackr` ships a dedicated
  browser entry (`./index.js`) that contains no Node globals.  All remaining node
  built-ins (`node:fs`, `node:crypto`, etc.) are explicitly marked as `external`;
  they appear only inside sql.js's `if(ca)` guard where
  `ca = globalThis.process?.versions?.node` — always falsy on Android, so those
  code paths are never executed.  The `require` surface in the bundle dropped from
  9 node built-ins to 2.

## 0.1.0 — 2026-02-23

First beta release. Core sync, delete/rename propagation, offline detection, and
CI/CD pipelines for both GitLab and GitHub are all in place.

### Added

- **`.github/workflows/release.yml` — GitHub Actions CI/CD pipeline**:
  Two-job workflow mirroring the GitLab pipeline. `build` runs on every push
  (any branch or tag); `release` runs on tag pushes only (`v*`), creating a
  GitHub Release with the plugin ZIP (`main.js`, `main.js.map`, `manifest.json`)
  attached as a downloadable asset. `GITHUB_TOKEN` is injected automatically —
  no secrets configuration required.

## 0.0.9 — 2026-02-23

### Improved

- **`.gitlab-ci.yml` — include `main.js.map` in release ZIP**:
  The sourcemap is now bundled alongside `main.js` and `manifest.json` in the
  release package. When the sourcemap is present in the plugin folder, the
  Obsidian developer console automatically maps stack frames back to the original
  TypeScript source, making bug reports significantly easier to diagnose.

## 0.0.8 — 2026-02-23

### Added

- **`.gitlab-ci.yml` — GitLab CI/CD pipeline**:
  Three-stage pipeline: `build` (every push) → `publish` + `release` (tag pushes only).
  - `build`: runs `npm ci && npm run build`; exposes `dist/main.js` and
    `dist/manifest.json` as short-lived job artifacts.
  - `publish`: zips the plugin files and uploads to the **GitLab Generic Package
    Registry** under a versioned path — permanent, downloadable link.
  - `release`: uses `release-cli` to create a **GitLab Release** entry (Deploy →
    Releases) with the ZIP download link and inline installation instructions.

  Trigger a release with: `git tag v0.0.8 && git push origin v0.0.8`. No credentials
  or CI variables need manual configuration — `CI_JOB_TOKEN`, `CI_API_V4_URL`, and
  `CI_PROJECT_ID` are injected automatically by GitLab.

## 0.0.7 — 2026-02-23

### Fixed

- **`src/evoluClient.ts` — Evolu error-level relay logs appear as console errors**:
  `createConsole()` from `@evolu/common` unconditionally calls `console.error()` for
  error-level messages — the `enableLogging` flag only gates `warn`/`log`/`debug`.
  Relay and WebSocket reconnect failures logged by Evolu via `deps.console.error`
  therefore showed up as red unhandled errors in the Obsidian developer console,
  alarming but not actionable (the relay retries automatically).

  Fixed by replacing both `createConsole()` calls in `createEvoluClient` (passed to
  `createDbWorkerForPlatform` and to `EvoluDeps`) with a custom `evoluConsole` object
  that spreads `createConsole()` but overrides `error` to call `console.warn("[evolu]",
  ...)` instead. The raw `"WebSocket connection to 'wss://...' failed"` messages emitted
  by the Electron runtime before any JS handler runs are a platform concern and cannot
  be suppressed via this mechanism.

- **`src/evoluClient.ts` — leaked WebSocket per plugin reload causes compounding reconnect errors**:
  `[Symbol.dispose]()` on the Evolu instance is not implemented in `@evolu/common` 7.4.1
  (throws `"Evolu instance disposal is not yet implemented"`), so there is no way to shut
  down a live Evolu instance. Every `startEngine()` call previously created a new Evolu
  instance (and new relay WebSocket) via `createEvoluClient`, leaving all previous instances
  alive — each one retrying the WebSocket connection indefinitely. After a handful of
  plugin reloads, many stale instances fired concurrent `WebSocket connection failed`
  console errors whenever the network was unavailable.

  Fixed by caching the Evolu client at module level in `evoluClient.ts`. Normal
  disable → enable reloads reuse the same instance (same WebSocket, no new VM). A
  fresh instance is created only when `restartEngine()` is called after reset/restore,
  which genuinely needs a new relay connection with the restored identity (`forceNew: true`).

- **`src/main.ts` — catastrophic false-delete-all on startup after hard close**:
  `onload()` called `startEngine()` directly. `engine.start()` immediately fires
  `auditSnapshotsForOfflineDeletes()`, which calls `vault.getFiles()` to find which
  snapshotted paths still exist. During initial Obsidian startup (including after ALT+F4
  hard close) the vault file index may not be fully populated at `onload()` time —
  `getFiles()` can return an empty or partial list. The audit then treats every
  snapshotted file as "deleted while offline" and emits a `fileUpdate { type: "delete" }`
  row for each. The other device receives those rows and trashes all its files. On the
  next restart of the originating device, `outgoingIds` is empty (new instance) so it
  processes its own delete rows and trashes its local files too.

  Fixed by deferring `startEngine()` to `this.app.workspace.onLayoutReady()` — the
  standard Obsidian API that fires only after the vault file index is fully populated.
  If the workspace is already ready (mid-session plugin reload) the callback fires
  synchronously, so there is no delay for normal restarts.

- **`src/engine.ts` — startup scan retransmits all files on every plugin start**:
  `scanVaultForUnsyncedFiles` called `retransmitCurrentState` for every previously-synced
  file on every startup. This upserted a new `fileUpdate` row for each file, generating
  `N` new `evolu_history` entries every time the plugin loaded — regardless of whether
  any content had changed. Every other device's next poll picked up and processed all
  those rows, causing unnecessary network traffic and spurious vault writes.

  Fixed by replacing `retransmitCurrentState` in the scan with `getOrLoadFileState`.
  `getOrLoadFileState` already performs offline-drift detection (vault text ≠ Yjs text
  → applies diff → queues for normal flush). For unchanged files it does nothing to
  Evolu at all. Late-joining devices reconstruct state from existing historical rows,
  which is unaffected by this change.

- **`src/main.ts` — stale instance on plugin reload causes phantom vault events**:
  Obsidian's disable → enable cycle calls `onunload()` synchronously then immediately
  calls `onload()` on the new instance. `engine.stop()` is async (awaits in-flight poll
  + flushes docs), so the old engine was still running its poll when the new engine
  started. Both instances shared the vault event bus: writes from the dying instance
  triggered the new instance's `onVaultFileModified`, producing spurious outgoing updates
  and an apparent echo loop that disappeared only after a full Obsidian restart.

  Fixed with a module-level `_previousInstanceStop` promise. `onunload()` **chains**
  (`.then()`) onto it rather than overwriting it; `onload()` awaits it before proceeding.
  Chaining is critical for rapid consecutive restarts: overwriting the promise lets a
  later instance start before an earlier stop has finished (if the intermediate instance's
  engine was never created, its `engine?.stop()` is a no-op that resolves immediately,
  breaking the serialisation). With chaining, `_previousInstanceStop` always represents
  "every prior instance has stopped" — each `onload()` is guaranteed to start into a
  fully quiesced state.

- **`src/engine.ts` — echo loop: editing a file causes both devices to loop indefinitely**:
  `Y.applyUpdate(doc, update)` in the poll loop (incoming remote update) fired the
  `doc.on("update")` listener, which pushed the received update to `pendingUpdates` and
  scheduled an outgoing flush. The device then re-transmitted the remote update back to
  the network. The other device received it, applied it, and echoed it back too — creating
  an infinite bidirectional loop that could only be stopped by restarting one device's
  plugin. The loop was most visible after a rapid succession of delete + append edits.

  Fixed by passing `"remote"` as the transaction origin to `Y.applyUpdate`:
  ```typescript
  Y.applyUpdate(st.doc, fromBase64(updateBase64), "remote");
  ```
  The `doc.on("update")` listener now checks the origin and returns early for remote
  applies, so only locally-generated ops (vault edits, seeding, drift catch-up) are
  queued for outgoing transmission.

### Added

- **`src/engine.ts` — Delete and rename propagation (ARCH-4)**:
  Deleting or renaming a file on one device now propagates to other devices.

  - `fileUpdate` table extended with a nullable `type` column (`null` = content update,
    `"delete"` = file deleted). Backward compatible — existing rows without `type` are
    treated as content updates.
  - `onVaultFileDeleted(file)`: destroys the in-memory Yjs doc, tombstones the snapshot,
    and emits a `fileUpdate { type: "delete" }` row so other devices trash the file.
  - `onVaultFileRenamed(file, oldPath)`: re-keys the in-memory doc to the new path,
    emits a delete row for the old path, and retransmits the full Yjs state under the
    new path via `retransmitCurrentState`.
  - `applyFileUpdateRowById` now fetches `type` and, for `"delete"` rows, calls
    `vault.trash(file, true)` (system trash) instead of applying a Yjs update.
  - `destroyDoc(path)`: cancels flush timer and destroys Y.Doc without flushing.
  - `tombstoneSnapshot(path)`: writes `snapshotBase64 = "DELETED"` so re-created paths
    start fresh. `loadLocalSnapshot` returns `null` for tombstoned entries.

- **`src/engine.ts` — Offline delete/rename detection**:
  `auditSnapshotsForOfflineDeletes()` runs at startup. Compares all non-tombstone
  snapshot paths against the current vault — any snapshot without a matching vault file
  was deleted or renamed while offline. A `fileUpdate { type: "delete" }` row is emitted
  and the snapshot tombstoned so the audit does not re-fire on subsequent startups.

- **`src/main.ts` — Vault delete and rename event listeners**:
  `vault.on("delete")` and `vault.on("rename")` registered in `startEngine()`.

- **`README.md` — Limitations section**:
  Documents intended single-user use case, CRDT merge behaviour for conflicting edits,
  and the fundamental limitation of concurrent lifecycle+content conflicts (ARCH-6).

## 0.0.6 — 2026-02-23

### Improved

- **`src/main.ts` — Mandatory blocking period for Reset and Restore confirmations**:
  Both destructive actions (Reset owner, Restore mnemonic) now enforce a
  mandatory 5-second wait before the confirmation click is accepted. Previously
  the second click could fire immediately after the first (cancel window, not a
  safety period). New flow: first click → button shows `"Please wait 5s…"` and
  a Notice; clicks during the wait are ignored; after 5 s the button changes to
  `"Confirm reset?"` / `"Confirm restore?"` and a second click executes the
  action. If no confirmation arrives within 10 s the button auto-reverts to its
  idle state.

### Added

- **`src/engine.ts` — Startup scan for pre-existing vault files**:
  Files that existed in the vault before the plugin was installed (or before a
  new device joined) were never seeded into Evolu because no vault `modify`
  event ever fired for them. Added `scanVaultForUnsyncedFiles()`, called once
  from `start()` in the background. It iterates all vault text files, skips any
  that already have a local `_fileSnapshot` entry (previously synced), and
  calls `getOrLoadFileState` for the rest. With the BUG-13 fix in place,
  `getOrLoadFileState` seeds the file's current content into the Yjs doc and
  schedules an outgoing flush, making the content available to other devices
  without requiring a manual edit of each file.

### Fixed

- **`src/engine.ts` — reset & restore causes doubled content (Test D)**:
  After a reset & restore the local `_fileSnapshot` table is empty (DB was
  wiped). The startup scan took the `snapshot === null` branch for every file
  and called `getOrLoadFileState` with the default `seedFromVault: true`,
  inserting vault content into a fresh Yjs doc. The relay then delivered the
  pre-reset history rows in the next poll and `Y.applyUpdate` applied the same
  content on top of the already-seeded state — resulting in doubled text.

  Fixed with a **deferred vault seeding** mechanism:
  - The scan now adds no-snapshot files to `pendingVaultSeed` instead of
    immediately seeding them.
  - Each poll cycle that touches a path removes it from `pendingVaultSeed`
    (relay delivered history → no vault seeding needed).
  - After the scan completes (`scanComplete = true`) and the relay is quiet
    (two consecutive polls with the first setting `pendingVaultSeedReady = true`
    and the second returning zero rows), `drainPendingVaultSeed` seeds only the
    files the relay never covered — genuinely new files with no remote history.
  - The `await ongoingPoll` barrier in `start()` is removed; the scan now runs
    concurrently with the initial poll (the scan only populates the pending set,
    no Yjs mutations), simplifying the startup sequencing.

- **`src/main.ts` — Performance settings not persisting display on reopen**:
  The `onChange` callback fires on every keystroke, so intermediate values
  (e.g. the empty string while editing "50" → "10") could pass numeric
  validation and be committed to disk. More critically, the committed value
  was never confirmed to the user — closing and reopening the settings panel
  showed whatever was last fully saved, which could look like the old value.
  Switched all four numeric performance settings from `onChange` to a native
  `"change"` DOM event listener that fires only on blur/Enter. Invalid values
  now reset the text field to the current saved value and show a `Notice`.
  Valid values are saved and confirmed with a `Notice` so the user can see the
  change was applied.

- **`src/engine.ts` — Remote file creation failing: Yjs text empty after applying remote update**:
  `getOrLoadFileState` seeded a new Yjs doc from vault content via
  `doc.transact(() => text.insert(0, lastVaultText))` **before** registering
  the `doc.on("update", …)` listener. The seeding update was therefore never
  captured in `pendingUpdates` and never sent to Evolu. Remote devices only
  received incremental diffs (e.g. "insert ' world' at position 5") without
  the foundational content ("hello" at positions 0–4). Yjs correctly deferred
  those orphaned operations, leaving `text.toString()` as `""` on the receiving
  side — which caused `writeYjsToVault` to hit the `newText === lastVaultText`
  early-return and never write the file.

  Fixed by restructuring `getOrLoadFileState`:
  1. Apply snapshot **before** the listener (snapshot must not be re-broadcast).
  2. Register `doc.on("update", …)`.
  3. Seed initial vault content **after** the listener so the seeding update is
     captured and transmitted. Remote devices receive the full content first,
     then subsequent incremental updates integrate correctly.

- **`src/engine.ts` — Remote file creation silently failing when parent folder absent**:
  If the synced file path contained a subfolder that did not exist on the local
  device, `vault.create` threw and the error was caught silently. Fixed by
  creating the missing folder via `vault.createFolder(folderPath)` before
  `vault.create`. Added `logInfo` at each vault-write branch for observability.

- **`src/engine.ts` — spurious `await` on `void` return of `pollHistoryOnce`**:
  Two call sites used `await this.pollHistoryOnce()` but `pollHistoryOnce`
  returns `void`, not a `Promise`, so the `await` was a no-op. Removed the
  superfluous `await` to eliminate the TypeScript hint 80007 and clarify intent.

## 0.0.5 — 2026-02-23

### Fixed

- **`src/main.ts` — `TypeError: getAppOwner is not a function` on plugin start**:
  A previous fix introduced `this.evolu.getAppOwner()` based on Context7
  documentation that described a newer Evolu API version. The installed
  `@evolu/common` 7.4.1 does not have this method — the correct API is
  `await evolu.appOwner`, a `Promise<AppOwner>` property. Fixed in all three
  call sites: the startup owner log in `startEngine`, the Reveal button handler,
  and the Copy button handler.

- **`src/main.ts` — stale mnemonic shown in Reveal/Copy after reset or restore**:
  `evolu.appOwner` is a `Promise.withResolvers()` promise that resolves only
  once — after reset/restore it still holds the old owner's mnemonic. Added a
  `mnemonicCache: string | null` field to the plugin class. The Restore and Reset
  handlers now store the new mnemonic in the cache; Reveal and Copy buttons read
  `mnemonicCache ?? evolu.appOwner.mnemonic` so they always reflect the current
  identity.

- **`src/engine.ts` — history cursor not saved on plugin unload, causing full
  replay on every restart after restore**: `onunload()` called `closeEvoluDb()`
  independently of `engine.stop()`. If a poll was in progress, its cursor write
  arrived via Evolu's `queueMicrotask` path after the DB had already been flushed
  to disk — so the cursor reverted and the full history was replayed next session.

  Fixed with two changes:
  1. `pollHistoryOnce()` is refactored from `async` to a sync wrapper that stores
     the running poll's `Promise` in `this.ongoingPoll`.
  2. `stop()` now `await`s `this.ongoingPoll` before flushing, ensuring the
     cursor write from any in-flight poll is committed to the in-memory DB before
     `closeEvoluDb()` saves it to disk.
  3. `onunload()` chains `closeEvoluDb` after `stop()` resolves:
     `void this.engine?.stop().then(() => this.closeEvoluDb?.())`.

- **`src/evoluClient.ts` — sync never works after mnemonic restore**:
  `createEvolu` keeps a module-level `Map` of instances keyed by app name. When
  `restartEngine()` called `createEvoluClient(appName, ...)` a second time, Evolu
  returned the **cached stale instance** — still wired to the old owner's relay
  WebSocket. The new sql.js driver (reading the restored DB) was created but
  never used, so the correct owner identity was never registered with the sync
  layer and relay messages were silently dropped.

  Fixed by introducing a module-level `_clientGeneration` counter in
  `evoluClient.ts`. Each call to `createEvoluClient` appends the generation to
  the Evolu instance name (e.g. `obsidian-local-sync-1`), guaranteeing a cache
  miss and a truly fresh Evolu client. The sql.js driver still opens the fixed
  `appName.db` file regardless of the session-unique instance name, so the
  restored DB state is always read correctly.

- **`src/main.ts` — relay WebSocket retains old owner identity after restore**:
  `restartEngine()` previously only replaced the engine while reusing the
  existing Evolu client. After `restoreAppOwner` the in-memory DB held the new
  owner but the relay WebSocket session still authenticated with the old write
  key, so sync never completed. `restartEngine()` now fully tears down and
  recreates the Evolu client (flush → new `createEvoluClient` → new relay
  connection) before starting the new engine.

## 0.0.4 — 2026-02-22

### Fixed

- **`src/engine.ts` — history cursor reset on every startup**: `ensureHistoryCursorRow`
  called `evolu.upsert("_historyCursor", { id, lastTimestamp: null })` on every
  plugin load. In Evolu's CRDT model this is an explicit write with a current
  wall-clock timestamp, so it always won over the previously saved cursor value
  and reset it to null — causing the full `evolu_history` to be replayed from
  scratch on every session. Fixed by omitting `lastTimestamp` from the upsert so
  the existing value is preserved on subsequent startups.

- **`src/engine.ts` — self-echo on every poll**: `pollHistoryOnce` previously
  fetched and re-applied every `fileUpdate` row including those written by this
  device in the current session. An in-memory `outgoingIds` set now tracks IDs
  inserted by `flushOutgoingUpdates`; rows found in the set are skipped
  immediately in `applyFileUpdateRowById`, eliminating redundant `Y.applyUpdate`
  calls and vault write-backs for our own updates.

- **`src/engine.ts` — N snapshot writes per poll batch**: `applyFileUpdateRowById`
  previously called `saveLocalSnapshot` after every individual update row,
  meaning a file that received 100 updates in one poll batch triggered 100 full
  `Y.encodeStateAsUpdate` + upsert cycles. Snapshot writes are now deferred to
  the end of the poll loop in `pollHistoryOnce`, saving at most one snapshot per
  touched file per batch.

### Added

- **`src/main.ts` — relay URL setting with validation**: A new "Relay URL" text
  field under the "Sync" section lets users configure the WebSocket relay
  endpoint at runtime. Input is validated to require a `wss://` or `ws://`
  scheme prefix; invalid values are rejected with a `Notice` and the setting is
  not saved.

## 0.0.3 — 2026-02-22

### Fixed

- **`src/engine.ts` — double vault read on doc bootstrap**: `getOrLoadFileState`
  previously read the vault file twice when no snapshot existed — once to seed
  the Yjs doc and again to initialise `lastVaultText`. If the file changed
  between the two reads, `lastVaultText` would diverge from the Yjs state,
  producing a spurious diff on the next modification. Now read once and reused.

- **`src/engine.ts` — fire-and-forget flush on plugin unload**: `stop()` was
  synchronous and fired all `closeDoc` calls with `void`, meaning pending Yjs
  update flushes and snapshot writes could be abandoned before they completed.
  `stop()` is now `async` and uses `Promise.all` so all outstanding flushes and
  snapshots are awaited before the in-memory state is cleared.

- **`src/main.ts` — unstable `deviceId` on first install**: `DEFAULT_SETTINGS`
  generates a random `deviceId` at module-evaluation time. Settings were only
  persisted when the user manually changed a value, so a restart before any
  setting was touched would produce a new `deviceId`. `loadSettings` now saves
  immediately after the first load when no stored `deviceId` is found.

### Improved

- **`src/engine.ts` — `toBase64` chunk size**: The character-by-character loop
  building the binary string was replaced with a chunked
  `String.fromCharCode(...subarray)` approach (8 192 bytes per chunk). This
  avoids call-stack overflow when encoding large Yjs snapshots and is
  measurably faster for typical vault file sizes.

## 0.0.2 — 2026-02-22

### Fixed

- **`.gitignore`**: Each pattern now on its own line (was invalid — multiple
  patterns per line separated by spaces). Added `#` comment prefixes to section
  headers. Added `main.js` to ignore the esbuild output at project root.

- **`tsconfig.json`**: Removed redundant `allowSyntheticDefaultImports` (already
  implied by `esModuleInterop: true`).

- **`package.json`**: Added missing `@types/node` (referenced in
  `tsconfig.json` `types` but not installed). Added missing `obsidian` as dev
  dependency (imported in source but not installed).

- **`src/engine.ts`**: Removed unsafe `as unknown as TimestampBytes` double-cast
  on `loadHistoryCursor` return — the query type already infers correctly. Added
  brand type parameters to all `createIdFromString` calls (`<"HistoryCursor">`,
  `<"FileSnapshot">`, `<"FileUpdate">`) to match schema-branded ID types.

- **`src/schema.ts`**: Fixed `Evolu.TimestampBytes` — the runtime value is not
  exported from `@evolu/common`'s public API. Imported `TimestampBytes` from
  `@evolu/common/local-first` instead.

- **`src/main.ts`**: Moved `addSettingTab()` before engine startup so the
  settings UI is always visible even if `onload()` fails. Extracted engine init
  into `startEngine()` wrapped in try/catch. Replaced non-existent
  `this.evolu.subscribe()` with `this.evolu.subscribeError()` (the actual Evolu
  API).

### Changed

- **Replaced `@evolu/web` with custom Obsidian-compatible platform layer.**
  `@evolu/web` is incompatible with Obsidian's CJS plugin context due to
  `import.meta.url` (unavailable in CJS), SharedWebWorker (unavailable in
  Electron), OPFS storage, and dynamic `import('module')` calls.

  New platform layer uses:
  - `sql.js` (asm.js build) for SQLite — pure JS, no WASM file loading issues
  - `createDbWorkerForPlatform` from `@evolu/common/local-first` on the main
    thread instead of a Web Worker
  - File-based persistence via Node.js `fs` (read on startup, debounced writes
    after mutations, immediate save on dispose)
  - `createWebSocket`, `createRandom`, `createRandomBytes`, `createTime` from
    `@evolu/common` (same as before)
  - No-op `reloadApp` (not applicable in Obsidian)

  This follows the same architecture as `@evolu/nodejs` (which uses
  `better-sqlite3` + `createDbWorkerForPlatform`), substituting `sql.js` to
  avoid native module compilation in Electron.

  E2EE is fully preserved — encryption is in `@evolu/common`, independent of
  the platform layer.

- **`esbuild.config.mjs`**: Added `banner`/`footer` to suppress the Yjs
  duplicate import warning. Obsidian bundles Yjs internally; the banner
  temporarily clears the global `__ $YJS$ __` flag before the plugin bundle
  initializes, then the footer restores it.

### Improved

- **Mnemonic settings UX**: Reveal now shows the mnemonic inline in a read-only
  monospace input with a toggle (Reveal/Hide). Added a Copy button that writes
  to clipboard without needing to reveal. Restore textarea and button are now on
  the same row with placeholder text. Reset uses a two-click confirmation with a
  5-second timeout before reverting.

### Added

- **`src/sqliteDriver.ts`**: New file implementing `CreateSqliteDriver` using
  `sql.js` with file-based persistence. Database is loaded from disk on startup
  and saved via debounced writes (5s) after mutations plus an immediate save on
  dispose.

- **`sql.js`** and **`@types/sql.js`** dependencies.

- **`CLAUDE.md`**: AI assistant project context file.

- **`.serena/`**: Serena project configuration.

### Removed

- **`@evolu/web`** dependency (replaced by custom platform layer).

## 0.0.1 — 2026-02-22

Initial release.

- Yjs CRDT engine for conflict-free file sync
- Evolu local-first database with WebSocket sync transport
- Incremental sync via `evolu_history` ordered mutation stream
- LRU memory management for open Yjs documents
- Local-only tables for file snapshots and history cursor
- diff-match-patch for computing vault file changes
- Mnemonic-based multi-device identity (reveal, restore, reset)
- Configurable settings UI (log level, poll interval, batch size, etc.)
- esbuild bundler with CJS output for Obsidian plugin compatibility
