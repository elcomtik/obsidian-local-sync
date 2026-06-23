# LocalSync Startup and Sync Flow

LocalSync keeps the vault file, a local Yjs snapshot, and synced update rows in
agreement. Normal synchronization is incremental. Full-history reconstruction
is available only through the manual materialization repair action.

## Incremental Inbox

Each peer has local-only processed-marker tables. The subscribed query returns
only synced rows for which this peer has no marker matching `(id, row version)`.
This detects rows that replicate late even when their Evolu timestamp is older
than previously received rows.

```mermaid
flowchart LR
  A[fileUpdate replicated] --> B{originDeviceId is this peer?}
  B -- yes --> C[Ignore own row]
  B -- no --> D{Processed marker exists for id and version?}
  D -- yes --> E[No work]
  D -- no --> F[Pending inbox result]
  F --> G[Select up to 50 changed paths]
  G --> H[Persist incoming rows]
  H --> I[Write durable apply WAL]
  I --> J[Apply affected paths]
  J --> K[Save snapshots and processed markers]
  K --> L[Persist local database once]
  L --> M[Clear apply journal]
```

The marker is written after vault and snapshot work. Incoming rows are durable
before the bounded apply WAL is created, and the WAL carries the selected
pending row data needed for deterministic replay. A crash leaves the WAL in
place; startup replays it before any vault scan can classify an interrupted
remote write as local drift. The WAL is cleared only after snapshots and
processed markers are durably checkpointed.

Visible catch-up progress advances after each applied path rather than waiting
for the 50-path checkpoint. Its durable baseline advances only after the final
database persist succeeds, so retrying an interrupted batch cannot inflate the
counter.

## Startup

The daemon and desktop plugin run the local vault scan by default. The mobile
plugin disables it by default so startup can begin incremental synchronization
without reading every local file. Mobile users can enable it or run **Local
vault scan** from Maintenance when files may have changed outside Obsidian or
while LocalSync was stopped.

```mermaid
flowchart TD
  A[Start engine] --> B[Initialize inbox schema]
  B --> B2{Apply WAL exists?}
  B2 -- yes --> B3[Recover and checkpoint interrupted batch]
  B2 -- no --> C{Existing peer upgrading?}
  B3 --> C
  C -- yes --> D[Baseline visible rows as processed once]
  C -- no --> E[Leave replicated rows pending]
  D --> F[Subscribe to pending-only queries]
  E --> F
  F --> G[List initial tracked vault paths]
  G --> H[Mark initial paths unscanned]
  H --> I[Reconcile one local path against snapshot]
  I --> J[Mark path scanned]
  J --> K[Allow pending remote updates for that path]
  K --> I
  I --> L[Startup local scan complete]
```

For files with an existing local snapshot, the scan first compares the current
vault content hash with the hash stored beside the Yjs snapshot. Matching files
need no Yjs reconstruction or snapshot database write. A missing hash, as on
the first startup after upgrading, takes the full reconciliation path once and
backfills the hash.

Remote paths not present in the initial local file list can materialize as soon
as that list is known. Existing paths can materialize immediately after their
own local reconciliation completes; they do not wait for the entire vault.

The startup scan detects edits made while LocalSync was stopped. It does not
perform a global remote-history validation.

When the scan is disabled, inbox processing and path-scoped interrupted-write
recovery start immediately. Normal edits made through Obsidian are still
captured by vault events. Local edits, deletes, and renames that bypass those
events require a manual or periodic vault scan.

Obsidian reports scan progress as checked files over total tracked files.
Incremental materialization counts the complete pending file and setting
anti-joins only when either 500-row query page is full. Smaller catch-ups use
the returned page lengths directly, avoiding a full-history count during normal
sync. Materialization then reports applied rows over that backlog; large local
marker migrations report separately.

If the app is suspended after writing a remote result to the vault but before
persisting its snapshot and processed marker, the apply WAL identifies the
interrupted batch. Resume recomputes each pending result from the durable
snapshot. A matching vault file is finalized without creating an outgoing
update; genuine local drift still follows the merge path.

The apply WAL protects the vault/database durability boundary. It does not lock
notes against live editing. LocalSync reconciles edits observed before applying
a path and captures edits observed afterward, but an edit racing the final
read-to-write window still requires separate optimistic concurrency handling.
Visible remote catch-up progress therefore asks the user to avoid editing synced
notes until catch-up completes. This is a temporary mitigation, not a substitute
for closing the write race.

## Normal Local Edit

```mermaid
flowchart LR
  A[Vault modify event] --> B[Diff vault text against open Yjs state]
  B --> C[Apply local Yjs operation]
  C --> D[Debounced outgoing flush]
  D --> E[Write fileUpdate with originDeviceId]
  E --> F[Save local snapshot]
```

The originating peer filters its own row from the incoming inbox. Other peers
receive and apply it incrementally.

The durable marker version is `updatedAt ?? createdAt`: inserted Evolu rows
have no `updatedAt`, while deterministic rows gain one when changed later.

Renames cancel the old-path outgoing debounce, retarget the open Yjs state,
then send an old-path delete and a full-state update for the new path.

## Normal Remote Edit

```mermaid
flowchart LR
  A[Pending remote rows for one path] --> B[Flush any pending local edit]
  B --> C{Batch contains delete?}
  C -- no --> D[Apply only pending Yjs updates to snapshot]
  C -- yes --> E[Rebuild only this path across delete boundary]
  D --> F[Write merged vault file]
  E --> F
  F --> G[Save snapshot and processed markers]
  G --> H[Persist local database]
```

Delete boundaries require a path-scoped reconstruction because a delete resets
the Yjs document. Ordinary content updates never replay path or vault history.

## Manual Validation

The Maintenance action remains the explicit full-history repair mechanism. It
scans synced rows, reconstructs path projections, and writes only when the vault
still matches the local snapshot. It is not called automatically at startup,
on focus, on timers, or after ordinary updates.
