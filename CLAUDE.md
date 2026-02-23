# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run build        # compile to dist/
npm run dev          # watch mode (incremental rebuild)
```

No test suite exists. TypeScript type-checking is the primary static validation:
```bash
npx tsc --noEmit    # type-check without emitting
```

To install into a vault for manual testing:
```bash
cp -r dist/ <vault>/.obsidian/plugins/obsidian-local-sync/
```

## Architecture

This is an **Obsidian plugin** (desktop + mobile) that provides single-user, multi-device vault sync using CRDT incremental updates. There are no tests; correctness relies on the properties of the underlying libraries.

### Data flow

```
Vault file change
  → diff-match-patch (oldText → newText)
  → Y.Doc transact (apply diff to Y.Text "content")
  → Yjs emits "update" event (Uint8Array)
  → batched by timer → merged → base64-encoded
  → evolu.upsert("fileUpdate", { path, updateBase64 })
  → Evolu WebSocket relay syncs to other devices
  → pollHistoryOnce reads evolu_history
  → fetches fileUpdate row → Y.applyUpdate
  → writeYjsToVault (Y.Text → vault file)
```

**Yjs is the source of truth.** Vault files are projections of Yjs state. Evolu is used purely as an ordered transport log and local-first storage backend.

### Source files

| File | Role |
|------|------|
| `src/main.ts` | Obsidian plugin entry point. Owns settings, UI (`LocalSyncSettingTab`), wires Evolu + engine to vault events. |
| `src/engine.ts` | `YjsEvoluHistoryEngine` — all sync logic: polling, LRU, inbound apply, outbound flush, vault writeback. |
| `src/schema.ts` | Evolu schema. `fileUpdate` syncs across devices; `_fileSnapshot` and `_historyCursor` are local-only (underscore prefix). |
| `src/evoluClient.ts` | Creates the Evolu client with WebSocket transport. |

### Key design details

**Evolu tables:**
- `fileUpdate` — synced: one row per outgoing Yjs update chunk (`{ path, updateBase64 }`)
- `_fileSnapshot` — local-only: one row per file, full Yjs state snapshot (replaced in-place via deterministic ID)
- `_historyCursor` — local-only: single row tracking the last processed `evolu_history` timestamp

**ID generation:** Snapshots and history cursor use `createIdFromString` with deterministic keys (`snapshot:${path}`, `history-cursor`), making them upsertable. Outgoing `fileUpdate` rows use a random key (`upd:${path}:${deviceId}:${Date.now()}:${Math.random()}`) to be unique per update.

**LRU memory management:** `states: Map<string, FileState>` holds open Yjs docs. Eviction calls `closeDoc` which flushes pending updates and saves a snapshot before destroying the `Y.Doc`. The limit is controlled by `maxOpenDocs` (default 50).

**Polling loop:** `pollHistoryOnce` is guarded by `isPolling` (concurrency flag) and `isActive` (paused when window loses focus). The cursor (`_historyCursor.lastTimestamp`) prevents reprocessing. Batch size is configurable (`historyBatchSize`, default 500).

**Outgoing batching:** Each Yjs `"update"` event pushes to `pendingUpdates[]` and arms a debounce timer (`outgoingBatchMs`, default 500ms). On flush, all pending updates are merged with `Y.mergeUpdates` before writing a single `fileUpdate` row.

**Loop prevention:** `ignoreNextVaultModify: boolean` on `FileState` — set before calling `vault.modify()` on a remote write, consumed on the next vault `"modify"` event for that file.

**Text files only:** `isTextFile` accepts `.md` and `.txt` only.

### Known issues tracker

Legend: ✅ resolved · ⚠ open

#### Bugs

| ID | File | Description | Status |
|----|------|-------------|--------|
| BUG-1 | `engine.ts:397` | `getOrLoadFileState` read vault twice on bootstrap (no snapshot path); `lastVaultText` could diverge from Yjs state, producing a spurious diff. | ✅ 0.0.3 |
| BUG-2 | `main.ts:175` | `deviceId` generated at module-load time was only persisted when a setting was manually changed; reloading before any setting change produced a new ID. | ✅ 0.0.3 |
| BUG-3 | `engine.ts:149` | `stop()` was synchronous; `closeDoc` calls were fire-and-forget (`void`), so flush and snapshot writes could be lost on plugin unload. | ✅ 0.0.3 |
| BUG-4 | `engine.ts` | `ensureHistoryCursorRow` upserted `lastTimestamp: null` on every startup — an explicit CRDT write that always beat the persisted value, resetting the cursor and causing full history replay every session. | ✅ 0.0.4 |
| BUG-5 | `sqliteDriver.ts` | SQLite DB not flushed to disk on plugin unload — 5-second debounce meant the history cursor and recent mutations were lost if Obsidian closed or the plugin reloaded within that window. | ✅ 0.0.4 |
| BUG-6 | `sqliteDriver.ts` | `exec()` called `db.run/exec` on a closed database after `[Symbol.dispose]` — threw `SqliteError: Database closed` on every relay message received by a stale plugin instance. | ✅ 0.0.4 |
| BUG-7 | `main.ts` | Context7 docs suggested `getAppOwner()` sync method which doesn't exist in the installed `@evolu/common`. Correct API is `await evolu.appOwner` (Promise-based property). Plugin failed to start with `TypeError: getAppOwner is not a function`. | ✅ 0.0.5 |
| BUG-8 | `main.ts` | Reveal/Copy showed stale mnemonic after reset/restore — `evolu.appOwner` is a one-shot Promise; after restoreAppOwner it still resolves to the old owner. Fixed by caching the new mnemonic in `plugin.mnemonicCache`. | ✅ 0.0.5 |
| BUG-9 | `engine.ts` / `main.ts` | History cursor not persisted on unload if a poll was in progress: cursor write arrived via microtask after `closeEvoluDb()` had already flushed. Fixed with `ongoingPoll` promise tracked in engine; `stop()` awaits it; `onunload()` chains `closeEvoluDb` after `stop()` resolves. | ✅ 0.0.5 |
| BUG-10 | `evoluClient.ts` | Sync never works after mnemonic restore/reset. `createEvolu` caches instances by name at module level; `restartEngine()` got back the stale old instance with the old relay WebSocket. Fixed by using a monotonic `_clientGeneration` counter to give each call a unique Evolu instance name (bypassing the cache) while keeping the DB file path fixed. | ✅ 0.0.5 |
| BUG-11 | `main.ts` | After restore, relay WebSocket still authenticated with the old owner's write key. `restartEngine()` now fully recreates the Evolu client (flush → new client → new relay connection) so the restored identity is used from the first sync request. | ✅ 0.0.5 |
| BUG-12 | `main.ts` | Performance settings (poll interval, batch size, etc.) fired `onChange` on every keystroke — intermediate partial values could be committed, and there was no user-visible confirmation that the change was saved. Switched to native `"change"` DOM event (fires on blur/Enter); invalid values reset the field; valid values emit a `Notice`. | ✅ 0.0.6 |
| BUG-13 | `engine.ts` | Remote file creation failing (`yjsTextLength: 0` after `Y.applyUpdate`). Root cause: `getOrLoadFileState` seeded vault content into the Yjs doc (`text.insert(0, lastVaultText)`) BEFORE registering `doc.on("update", …)`, so the seeding update was never captured in `pendingUpdates` and never sent. Remote devices only received incremental diffs without the foundational content; Yjs deferred those orphaned operations leaving `text.toString() = ""`, causing `writeYjsToVault` to skip file creation. Fixed by moving vault-seed transact to AFTER listener registration; snapshot application stays before the listener (no re-broadcast). | ✅ 0.0.6 |
| BUG-14 | `engine.ts` | Remote file creation silently failed when the file's parent folder did not exist locally: `vault.create()` threw without user-visible feedback. Fixed by creating missing parent folder with `vault.createFolder()` before `vault.create()`. Added `logInfo` at each vault-write branch for observability. | ✅ 0.0.6 |
| BUG-15 | `engine.ts` | Reset & restore caused doubled content. After reset `_fileSnapshot` is empty; the startup scan took the `snapshot === null` branch for every file and seeded vault content into a fresh Yjs doc. When the relay delivered pre-reset history rows in the next poll, the same content was applied again on top. Fixed with deferred vault seeding (`pendingVaultSeed`): no-snapshot files are only seeded from vault after at least one poll cycle has elapsed AND the relay is quiet (zero rows returned). Files the relay covers are removed from the pending set and never seeded from vault. | ✅ 0.0.6 |
| BUG-16 | `engine.ts` | LRU-evicted file re-opened on vault modify may produce spurious diff. Investigation (Test H, 0.0.6): confirmed `lastVaultText` after snapshot replay correctly matches `text.toString()` — no spurious diff or content corruption observed. Not a bug; existing behavior is correct. | ✅ 0.0.6 |
| BUG-17 | `engine.ts` | Echo loop: `Y.applyUpdate(doc, remoteUpdate)` inside the poll loop fired `doc.on("update")`, causing the device to re-queue the received update for outgoing transmission. Both sides echoed back and forth indefinitely — loop was self-sustaining and visible as repeated content insertion, especially after a rapid delete + append edit. Fixed by passing `"remote"` as transaction origin and filtering it in the listener. | ✅ 0.0.7 |
| BUG-18 | `main.ts` | Stale instance on plugin reload: `onunload()` fires `engine.stop()` void; Obsidian immediately calls `onload()` on the new instance before the old engine finishes stopping. Both instances share the vault event bus — the dying engine's vault writes trigger the new engine's `onVaultFileModified`, producing phantom outgoing updates and apparent echo loop. Disappeared only after full Obsidian restart. Also manifested under rapid consecutive restarts (plugin toggled multiple times quickly) because overwriting the module-level promise allowed later instances to start before earlier stops had completed. Fixed with module-level `_previousInstanceStop` promise that is chained (`.then()`) rather than overwritten in `onunload` — each `onload` awaits the full history of prior stops; `onunload` appends its stop to the chain tail. Also added `_unloaded` instance flag checked at each async resume point in `onload`/`startEngine` so a superseded instance bails out before registering vault event handlers. | ✅ 0.0.7 |
| BUG-19 | `engine.ts` | Startup scan retransmits all files on every plugin start: `scanVaultForUnsyncedFiles` called `retransmitCurrentState` for every snapshotted file, writing a new Evolu row each time regardless of whether content had changed. Generated N new `evolu_history` entries per startup; other devices downloaded and processed all of them on every poll. Fixed by replacing `retransmitCurrentState` in the scan with `getOrLoadFileState` — drift detection still runs (vault text ≠ Yjs text → diff queued for normal flush), but unchanged files produce zero new Evolu rows. | ✅ 0.0.7 |
| BUG-20 | `main.ts` | Catastrophic false-delete-all on startup after hard close (ALT+F4): `auditSnapshotsForOfflineDeletes` called `vault.getFiles()` from `onload()`, before Obsidian's vault index was fully populated. Empty/partial `getFiles()` caused all snapshotted paths to be treated as offline-deleted → delete rows emitted for all files → other device trashed everything; on next local restart `outgoingIds` was empty so local device processed its own delete rows and trashed its own files. Fixed by deferring `startEngine()` to `app.workspace.onLayoutReady()`, which fires only after the vault index is complete. | ✅ 0.0.7 |
| BUG-21 | `evoluClient.ts` | Leaked WebSocket per plugin reload: `Evolu[Symbol.dispose]()` throws "not yet implemented" in @evolu/common 7.4.1 — no way to shut down an Evolu instance. Each `createEvoluClient()` call created a new instance (and relay WebSocket) that could never be closed, accumulating stale reconnect loops. After multiple reloads, each network blip fired one error per live instance. Fixed by caching the Evolu client at module level in `evoluClient.ts`; normal reloads reuse the existing instance, `forceNew: true` only for reset/restore. | ✅ 0.0.7 |

#### Architecture

| ID | File | Description | Status |
|----|------|-------------|--------|
| ARCH-1 | `engine.ts` | Self-echo: own `fileUpdate` rows are fetched on every poll and re-applied via Yjs (idempotent) then snapshot is saved again — wasted work on every local write. | ✅ 0.0.4 |
| ARCH-2 | `engine.ts:260` | N+1 query: each history row triggers a separate `applyFileUpdateRowById` query. Up to `historyBatchSize` (default 500) individual DB queries per poll. A join query would collapse this to 1. | ⚠ open |
| ARCH-3 | `engine.ts` | Snapshot written after every remote update applied. A file receiving 100 updates in one batch triggers 100 full `Y.encodeStateAsUpdate` writes; should defer to end-of-batch. | ✅ 0.0.4 |
| ARCH-4 | `engine.ts` | No `rename` or `delete` vault event handlers. Renaming a file leaves the old path's Yjs doc alive until LRU evicts it; the new path starts with a fresh doc. File deletion on one device is not propagated to other devices. Fixed: `fileUpdate.type` column added; `onVaultFileDeleted`, `onVaultFileRenamed`, `auditSnapshotsForOfflineDeletes` added to engine; `delete`/`rename` vault events registered in main.ts. | ✅ 0.0.7 |
| ARCH-5 | `engine.ts` | Files pre-existing in the vault before plugin install (or before a new device joined) were never seeded into Evolu — no `modify` event ever fired for them. Fixed by `scanVaultForUnsyncedFiles()` background scan at startup: iterates all text files, skips those with a local snapshot, seeds the rest via `getOrLoadFileState`. | ✅ 0.0.6 |
| ARCH-6 | `engine.ts` / `README.md` | Concurrent conflicting operations (delete+edit or rename+edit on the same path from two devices simultaneously) have non-deterministic outcomes — a fundamental CRDT limitation with no clean fix without a central coordinator. Documented in README.md. | ⚠ open (known limitation) |

#### Quality

| ID | File | Description | Status |
|----|------|-------------|--------|
| QUAL-1 | `main.ts:59` | `evolu: any` in the plugin class — all Evolu API calls in `main.ts` (`.appOwner`, `.subscribeError`, `.restoreAppOwner`, `.resetAppOwner`) are unchecked. Engine correctly types it as `Evolu<Database>`. | ⚠ open |
| QUAL-2 | `engine.ts:276` | `applyFileUpdateRowById(fileUpdateId: any)` — parameter typed `any` instead of the appropriate Evolu ID type. | ⚠ open |

#### Performance

| ID | File | Description | Status |
|----|------|-------------|--------|
| PERF-1 | `engine.ts:34` | `toBase64` built binary string one character at a time — call-stack overflow risk on large snapshots, slower than chunked spread. | ✅ 0.0.3 |
| PERF-2 | `engine.ts:319` | LRU eviction is O(n) scan per eviction. Negligible at `maxOpenDocs=50` but would matter if the limit is raised significantly. | ⚠ open (low) |

#### Security / UX

| ID | File | Description | Status |
|----|------|-------------|--------|
| SEC-1 | `main.ts:291` | Mnemonic shown in ephemeral Notice toast — no copy button, visible to bystanders. | ✅ 0.0.2 |
| SEC-2 | `main.ts` | `relayUrl` setting accepts any string with no `wss:`/`ws:` scheme validation; malformed URL causes a failed connection with no user-facing error. | ✅ 0.0.4 |
