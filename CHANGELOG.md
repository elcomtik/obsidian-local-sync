# Changelog

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
