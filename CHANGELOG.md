# Changelog

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
