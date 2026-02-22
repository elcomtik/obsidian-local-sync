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

### Known issues (from prior analysis)

- `getOrLoadFileState` reads the vault file twice when bootstrapping from disk (no snapshot); `lastVaultText` should reuse the first read.
- `stop()` uses `void this.closeDoc(p)` — async flush/snapshot on unload is fire-and-forget and may not complete.
- `deviceId` in `DEFAULT_SETTINGS` is generated at module load time from `Math.random()`; it is only persisted when `saveSettings()` is called, so it can change across reloads before any setting is saved.
- `evolu` in `main.ts` is typed `any`; the engine's `Evolu<Database>` typing is correct.
- Own `fileUpdate` rows are processed on every poll (idempotent via Yjs, but wasteful).
