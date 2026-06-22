# obsidian-local-sync — Project Index

> Single-user, multi-device vault sync using Yjs CRDT + Evolu local-first DB.
> See [README.md](README.md) for architecture overview, [CLAUDE.md](CLAUDE.md) for AI assistant guidance, [CHANGELOG.md](CHANGELOG.md) for release history, and [../docs/README.md](../docs/README.md) for workspace context.

Workspace PRD: [Basic Memory LocalSync](../docs/prd/basic-memory-localsync.md)

---

## Source Files

| File | Purpose | Key exports |
|------|---------|-------------|
| [src/main.ts](src/main.ts) | Obsidian plugin entry, settings UI | `ObsidianLocalSyncPlugin`, `LocalSyncSettingTab` |
| [src/engine.ts](src/engine.ts) | Core sync logic | `YjsEvoluHistoryEngine`, `EngineConfig`, `LogLevel` |
| [src/schema.ts](src/schema.ts) | Evolu DB schema + types | `Schema`, `Database` |
| [src/evoluClient.ts](src/evoluClient.ts) | Evolu client factory | `createEvoluClient` |
| [src/sqliteDriver.ts](src/sqliteDriver.ts) | sql.js persistence layer | `createPersistentSqlJsDriver` |

---

## Symbol Reference

### `src/main.ts`

| Symbol | Kind | Description |
|--------|------|-------------|
| `ObsidianLocalSyncPlugin` | class | Plugin lifecycle (`onload` / `onunload`). Creates Evolu client and engine, registers vault `modify` and window focus/blur events. |
| `LocalSyncSettingTab` | class | Obsidian settings UI. Renders log level, performance knobs, mnemonic reveal/copy/restore/reset. |
| `PluginSettings` | type | `{ relayUrl, appName, deviceId, historyPollMs, historyBatchSize, outgoingBatchMs, maxOpenDocs, logLevel, localSync }` |
| `DEFAULT_SETTINGS` | const | Default values. `deviceId` is generated once at module-load time from `Math.random()`. Persisted on first `loadSettings` call. |
| `toEngineConfig` | fn | Maps runtime settings to `EngineConfig`. |

### `src/engine.ts`

| Symbol | Kind | Description |
|--------|------|-------------|
| `YjsEvoluHistoryEngine` | class | All sync work. See method table below. |
| `EngineConfig` | type | Runtime performance/materializer timing configuration. |
| `LogLevel` | type | `"off" \| "error" \| "warn" \| "info"` |
| `FileState` | type | Per-open-file state: `{ doc, text, lastVaultText, ignoreNextVaultModify, pendingUpdates, flushTimer, lastUsedMs }` |
| `toBase64` | fn | `Uint8Array → string` via chunked `String.fromCharCode` (8 192 B chunks) + `btoa`. |
| `fromBase64` | fn | `string → Uint8Array` via `atob`. |
| `applyBetterDiffToYText` | fn | Converts diff-match-patch output into Yjs `insert`/`delete` ops. |

**`YjsEvoluHistoryEngine` methods:**

| Method | Async | Description |
|--------|-------|-------------|
| `start()` | ✓ | Starts materializer subscriptions, quiet-cycle timer, rescan timers, and optional startup scan. |
| `stop()` | ✓ | Stops timers/subscriptions, awaits current quiet cycle, closes docs, clears state map. |
| `updateConfig()` | ✓ | Hot-swaps `config`, resets quiet-cycle timer, enforces LRU limit. |
| `setLogLevel()` | – | Updates runtime log level. |
| `setActive()` | ✓ | Resumes quiet-cycle checks (called on window `focus` / `visibilitychange`). |
| `setInactive()` | – | Pauses quiet-cycle checks (window `blur`). |
| `onVaultFileModified()` | ✓ | Vault → Yjs path. Reads file, diffs against `lastVaultText`, transacts into `Y.Doc`. |
| `refreshFileMaterializationPlans()` | ✓ (private) | Reads latest `fileUpdate` rows from history and queues paths whose remote signatures changed. |
| `runFileMaterializer()` | ✓ (private) | Applies queued remote file plans when the vault file still matches the local snapshot. |
| `enforceLruLimit()` | ✓ (private) | Evicts least-recently-used docs until `states.size ≤ maxOpenDocs`. |
| `closeDoc()` | ✓ (private) | Flushes pending updates, saves snapshot, destroys `Y.Doc`. |
| `getOrLoadFileState()` | ✓ (private) | Returns cached state or bootstraps from snapshot/vault. Registers Yjs `"update"` listener. |
| `loadLocalSnapshot()` | ✓ (private) | Queries `_fileSnapshot` by deterministic ID. |
| `saveLocalSnapshot()` | ✓ (private) | Upserts `_fileSnapshot` with full `Y.encodeStateAsUpdate`. |
| `scheduleOutgoingFlush()` | – (private) | Arms debounce timer for outgoing update batch. |
| `flushOutgoingUpdates()` | ✓ (private) | Merges `pendingUpdates` via `Y.mergeUpdates`, upserts `fileUpdate` row, saves snapshot. |
| `writeYjsToVault()` | ✓ (private) | Writes `Y.Text.toString()` to vault; sets `ignoreNextVaultModify` flag. |
| `isTextFile()` | – (private) | `true` for `.md` and `.txt` extensions. |

### `src/schema.ts`

| Symbol | Kind | Description |
|--------|------|-------------|
| `Schema` | const | Evolu schema. Synced update tables plus local snapshot/materialization tables. |
| `Database` | type | `typeof Schema` — used to type the Evolu client in `engine.ts`. |
| `FileUpdateId` | const | Branded ID type for `fileUpdate` rows. |
| `FileSnapshotId` | const | Branded ID type for `_fileSnapshot` rows. |
| `FileMaterializationId` | const | Branded ID type for `_fileMaterialization` rows. |
| `SettingMaterializationId` | const | Branded ID type for `_settingMaterialization` rows. |

**Evolu tables:**

| Table | Synced | Schema | Notes |
|-------|--------|--------|-------|
| `fileUpdate` | ✓ | `id, path (≤1000 chars), updateBase64, type` | One row per outgoing Yjs update chunk or delete marker. Rows accumulate forever. |
| `settingUpdate` | ✓ | `id, path, contentBase64, contentHash, encoding, type` | Synced setting-file updates when settings sync is enabled. |
| `_fileSnapshot` | ✗ | `id, path, snapshotBase64` | One row per file path. Replaced in-place (deterministic ID: `snapshot:${path}`). Full Yjs state. |
| `_settingSnapshot` | ✗ | `id, path, contentHash` | Local setting-file snapshot hash. |
| `_fileMaterialization` | ✗ | `id, path, signature` | Last materialized remote file signature per path. |
| `_settingMaterialization` | ✗ | `id, path, signature` | Last materialized remote setting signature per path. |

### `src/evoluClient.ts`

| Symbol | Kind | Description |
|--------|------|-------------|
| `createEvoluClient` | fn | `(appName, relayUrl, dataDir) → Evolu<Database>`. Wires `createPersistentSqlJsDriver`, `createDbWorkerForPlatform`, WebSocket transport, and all `@evolu/common` primitive factories. |

### `src/sqliteDriver.ts`

| Symbol | Kind | Description |
|--------|------|-------------|
| `createPersistentSqlJsDriver` | fn | `(dataDir) → CreateSqliteDriver`. Returns a factory that opens/creates `<dataDir>/<name>.db` using `sql.js` (asm.js). |
| `getSql` | fn (private) | Singleton `initSqlJs()` promise — WASM initialised once per process. |
| `SAVE_DEBOUNCE_MS` | const | `5_000` ms — debounce window for disk writes after mutations. |

**Driver behaviour:** Loads `.db` file from disk on open (or starts fresh). Every mutation with `db.getRowsModified() > 0` arms a 5-second debounce save. `[Symbol.dispose]` cancels the timer and saves immediately, then closes the database.

---

## Configuration Reference

All settings live in Obsidian's plugin data (JSON, managed by `Plugin.loadData` / `saveData`).

| Key | Default | Min | Description |
|-----|---------|-----|-------------|
| `relayUrl` | `wss://free.evoluhq.com` | — | Evolu WebSocket relay URL. |
| `appName` | `obsidian-local-sync` | — | Evolu app namespace (isolates data on shared relays). |
| `deviceId` | random hex | — | Stable per-device identifier. Persisted on first load. |
| `historyPollMs` | `1000` | `100` | Quiet-cycle interval for deferred seed and inventory checks (ms). |
| `historyBatchSize` | `500` | `10` | Legacy compatibility setting. |
| `outgoingBatchMs` | `500` | `50` | Debounce window before sending outgoing Yjs updates (ms). |
| `maxOpenDocs` | `50` | `5` | LRU cap on simultaneously open Yjs docs. |
| `logLevel` | `info` | — | Console verbosity: `off \| error \| warn \| info`. |

---

## Data Flow Detail

### Outgoing (local edit → relay)

```
vault "modify" event
  └─ onVaultFileModified(file)
       └─ getOrLoadFileState(path)           (bootstrap if needed)
       └─ diff-match-patch(lastVaultText, newText)
       └─ Y.Doc.transact(applyBetterDiffToYText)
            └─ Y.Doc emits "update" (Uint8Array)
                 └─ pendingUpdates.push(u)
                 └─ scheduleOutgoingFlush()  (debounce timer)
                      └─ flushOutgoingUpdates()
                           └─ Y.mergeUpdates(pendingUpdates)
                           └─ evolu.upsert("fileUpdate", { id, path, updateBase64 })
                           └─ saveLocalSnapshot()
```

### Incoming (relay → vault)

```
Evolu subscription event
  └─ scheduleFileMaterializationRefresh()
       └─ refreshFileMaterializationPlans()
            └─ load latest fileUpdate rows from evolu_history
            └─ group rows into per-path materialization plans
            └─ queue paths whose signatures changed
       └─ runFileMaterializer()
            └─ skip during startup scan until scanComplete
            └─ skip if vault content drifted from local snapshot
            └─ materialize remote Yjs state to vault
            └─ save local snapshot and materialization signature
```

### Doc bootstrap (`getOrLoadFileState`)

```
path not in states map
  └─ enforceLruLimit()                       (evict LRU docs if over cap)
  └─ new Y.Doc()
  └─ loadLocalSnapshot(path)
  └─ vault.read(file)                        (single read, reused for both Yjs seed and lastVaultText)
  └─ if snapshot: Y.applyUpdate(doc, snapshot)
     else if vaultText: doc.transact(text.insert(0, vaultText))
  └─ register doc "update" → scheduleOutgoingFlush
  └─ states.set(path, st)
```

---

## Key ID Conventions

| ID key pattern | Table | Type |
|----------------|-------|------|
| `snapshot:${path}` | `_fileSnapshot` | Deterministic (one per file, upsertable) |
| `file-materialization:${path}` | `_fileMaterialization` | Deterministic (one per file, upsertable) |
| `upd:${path}:${deviceId}:${Date.now()}:${Math.random()}` | `fileUpdate` | Unique (append-only) |

---

## Dependency Graph

```
main.ts
  ├─ engine.ts          (YjsEvoluHistoryEngine)
  │    ├─ yjs           (Y.Doc, Y.Text, Y.mergeUpdates, Y.applyUpdate, Y.encodeStateAsUpdate)
  │    ├─ diff-match-patch
  │    ├─ @evolu/common  (Evolu<Database>, createIdFromString, idBytesToId, IdBytes)
  │    └─ schema.ts
  ├─ evoluClient.ts     (createEvoluClient)
  │    ├─ @evolu/common  (createEvolu, createConsole, createRandom, createRandomBytes, createTime, createWebSocket, SimpleName, EvoluDeps)
  │    ├─ @evolu/common/local-first  (createDbWorkerForPlatform)
  │    ├─ sqliteDriver.ts
  │    └─ schema.ts
  └─ obsidian           (Plugin, PluginSettingTab, Setting, TFile, FileSystemAdapter, Notice, App)

sqliteDriver.ts
  ├─ sql.js/dist/sql-asm.js   (initSqlJs — asm.js build, no WASM file loading)
  ├─ @evolu/common            (CreateSqliteDriver)
  └─ node:fs, node:path

schema.ts
  └─ @evolu/common            (id, NonEmptyString1000, NonEmptyString, String, nullOr)
```

---

## Related Documents

- [README.md](README.md) — Architecture narrative, multi-device setup, design guarantees, roadmap
- [docs/sync-flow.md](docs/sync-flow.md) — Startup and normal sync diagrams
- [CLAUDE.md](CLAUDE.md) — Build commands, key design details, known issues tracker
- [CHANGELOG.md](CHANGELOG.md) — Version history (current: 0.0.3)
