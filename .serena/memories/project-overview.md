# obsidian-local-sync — Project Overview

**Type:** Obsidian plugin (TypeScript, CJS bundle via esbuild)
**Version:** 0.0.3
**Purpose:** Single-user, multi-device vault sync using Yjs CRDT + Evolu local-first DB + WebSocket relay.

## Source Files (5)

| File | Role |
|------|------|
| `src/main.ts` | Plugin entry, settings UI, wires Evolu + engine to vault events |
| `src/engine.ts` | `YjsEvoluHistoryEngine` — all sync logic (poll, apply, flush, LRU) |
| `src/schema.ts` | Evolu DB schema: `fileUpdate` (synced), `_fileSnapshot`, `_historyCursor` (local) |
| `src/evoluClient.ts` | Evolu client factory — wires sql.js driver + `@evolu/common` primitives |
| `src/sqliteDriver.ts` | Custom `CreateSqliteDriver` using sql.js (asm.js) + Node.js `fs` persistence |

## Key Architecture Points

- **Yjs is source of truth.** Vault files are projections of Yjs state.
- **Evolu is transport + storage only.** `fileUpdate` rows are an append-only ordered log.
- **`@evolu/web` was replaced** with a custom platform layer because it requires
  `import.meta.url` (unavailable in CJS), SharedWebWorker, and OPFS — none available
  in Obsidian's Electron renderer. The custom layer uses sql.js (asm.js) + Node.js `fs`.
- **Loop prevention:** `ignoreNextVaultModify` flag on `FileState` prevents self-echo
  on vault writeback from remote updates.
- **LRU:** `states: Map<string, FileState>` capped by `maxOpenDocs` (default 50).
  `closeDoc` flushes pending updates + saves snapshot before destroying `Y.Doc`.

## Build

```bash
npm install
npm run build        # produces dist/main.js (CJS)
npm run dev          # watch mode
npx tsc --noEmit     # type-check only
```

## Documents Created This Session

- `CLAUDE.md` — AI assistant guidance, architecture, known issues tracker
- `INDEX.md` — Full symbol reference, method tables, data flow diagrams, dependency graph
- `CHANGELOG.md` — Version history (0.0.1 → 0.0.3)
