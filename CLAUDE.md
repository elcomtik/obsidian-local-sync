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

#### Architecture

| ID | File | Description | Status |
|----|------|-------------|--------|
| ARCH-1 | `engine.ts` | Self-echo: own `fileUpdate` rows are fetched on every poll and re-applied via Yjs (idempotent) then snapshot is saved again — wasted work on every local write. | ✅ 0.0.4 |
| ARCH-2 | `engine.ts:260` | N+1 query: each history row triggers a separate `applyFileUpdateRowById` query. Up to `historyBatchSize` (default 500) individual DB queries per poll. A join query would collapse this to 1. | ⚠ open |
| ARCH-3 | `engine.ts` | Snapshot written after every remote update applied. A file receiving 100 updates in one batch triggers 100 full `Y.encodeStateAsUpdate` writes; should defer to end-of-batch. | ✅ 0.0.4 |
| ARCH-4 | `engine.ts` | No `rename` or `delete` vault event handlers. Renaming a file leaves the old path's Yjs doc alive until LRU evicts it; the new path starts with a fresh doc. Acknowledged in roadmap. | ⚠ open |

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
