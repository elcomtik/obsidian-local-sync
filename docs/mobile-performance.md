# Mobile Catch-up Performance

This note records implemented and remaining optimization options for slow
remote catch-up in the Obsidian mobile plugin.

## Current Cost Model

LocalSync groups pending work by changed path. For each checkpoint batch it:

1. Persists incoming rows so journal references are durable.
2. Atomically writes an apply WAL for up to 50 paths by default.
3. Applies pending Yjs updates and writes resulting vault files.
4. Stores snapshots and processed-row markers in sql.js.
5. Exports and persists sql.js once for the completed batch.
6. Clears the journal.

Previously, steps 4-5 ran for every changed path. sql.js runs on Obsidian's
JavaScript thread and persistence exports the complete database image, so that
scaled with both path count and database size and reduced editor
responsiveness.

This must be confirmed with timings before changing persistence behavior.
Instrument relay/query delivery, Yjs application, vault writes, snapshot and
marker mutations, database export, and adapter writes separately.

## Correctness Constraints

Optimizations must preserve these properties:

- A crash or mobile suspension must not turn an already-applied remote change
  into an outgoing local echo after restart.
- Processed markers must not become durable before their vault result can be
  recovered.
- Local edits made during catch-up must not be overwritten.
- Remote deletes and Yjs delete boundaries must remain recoverable.
- Catch-up work must yield often enough to keep the Obsidian editor responsive.

## Options

### 1. WAL-backed Batched Database Checkpoints (Implemented)

Incoming rows are checkpointed before the apply WAL is written. LocalSync then
applies up to 50 paths, checkpoints the resulting snapshots and markers once,
and clears the WAL only after that checkpoint succeeds. Explicit database
persistence rejects on write failure so a failed checkpoint cannot retire the
WAL.

On restart, replay the journal using the existing path-scoped interrupted-write
recovery. This retains crash safety while avoiding a complete database export
for every path.

The batch size is configurable as **Checkpoint batch paths** in the plugin and
`LOCALSYNC_INBOX_CHECKPOINT_BATCH_PATHS` in the daemon.

### 2. Coalesce Pending Work by Path

Apply every currently available update for a path before writing its vault file
or checkpointing. Continue coalescing across saturated inbox pages when more
rows for that path are already known to be pending. This reduces repeated Yjs
materialization and vault writes for hot files.

### 3. Cooperative Catch-up Scheduling

Process bounded slices, then yield to the Obsidian event loop. Prioritize the
currently open note and potentially small files so visible content converges
quickly without long main-thread stalls. This improves perceived performance
even when total work is unchanged.

### 4. Incremental Database Storage

Longer-term, replace whole-image sql.js persistence on mobile with an
incremental storage backend, if Obsidian exposes a reliable cross-platform
option. Native SQLite, OPFS, or another platform driver could remove the export
cost, but compatibility, plugin packaging, and mobile lifecycle behavior must
be validated first.

### 5. Bound Initial Yjs History

Introduce compact state checkpoints so a new peer does not need to apply an
unbounded sequence of historical updates. Any compaction design must preserve
late peer recovery and deterministic processing-marker semantics.

## Changes Unlikely to Help Alone

- Increasing the 500-row inbox page can create longer main-thread stalls and
  higher memory use without reducing per-path database exports.
- Hashing mainly avoids unnecessary startup reconstruction; it does not remove
  remote materialization and persistence work.
- Parallel vault writes increase race risk and can worsen mobile I/O pressure.

## Recommended Sequence

1. Add phase timings and aggregate catch-up metrics.
2. Confirm the database export and adapter write contribution on a real mobile
   vault.
3. Measure the WAL-backed 50-path checkpoints on a real mobile vault.
4. Implement further path coalescing if repeated writes remain significant.
5. Add cooperative scheduling and visible-file prioritization.
6. Evaluate an incremental mobile database backend and Yjs compaction only if
   the earlier changes are insufficient.
