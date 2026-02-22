
# Obsidian LocalSync

Single-user, multi-device file sync for Obsidian using:

- **Yjs** → CRDT document engine (source of truth)
- **Evolu** → local-first database + sync transport
- **evolu_history** → ordered mutation stream
- **LRU memory management**
- **Configurable performance settings**
- **Mnemonic-based device bootstrap**
- **Console logging** (off / error / warn / info)

This is an experimental local-first architecture for syncing Markdown files incrementally without retransmitting full file contents.

---

## 🚀 Quick Start

### Build

```bash
npm install
npm run build
```

### Install into a vault

Copy the `dist/` folder to:

```
<your-vault>/.obsidian/plugins/obsidian-local-sync/
```

Enable the plugin in Obsidian → Settings → Community Plugins.

---

## 🔑 Multi-Device Setup

This system uses Evolu’s **owner mnemonic** as your sync key.

### On Device A
1. Open plugin settings
2. Click **Reveal mnemonic**
3. Copy and store it securely

### On Device B
1. Install the plugin
2. Open settings
3. Paste mnemonic into **Restore**
4. Click Restore
5. Restart Obsidian if needed

---

## 🧠 Architecture Overview

High-level flow:

```
Obsidian Vault File
        │
        ▼
diff-match-patch (compute changes)
        │
        ▼
Yjs Document (CRDT, source of truth)
        │
        ├── Local snapshot (Evolu local table)
        │
        └── Yjs updates → Evolu fileUpdate table
                         │
                         ▼
                evolu_history (ordered log)
                         │
                         ▼
              Other devices poll history
                         │
                         ▼
                 Apply Yjs update
                         │
                         ▼
                 Write to Vault
```

---

## 🧩 Core Components

### 1) Yjs (CRDT Engine)
- Each file path has its own `Y.Doc`
- Yjs handles merge + conflict resolution
- Updates are idempotent
- Yjs is the **source of truth**

Vault files are projections of Yjs state.

### 2) Evolu (Transport + Log)
We use Evolu for:
- local-first storage
- WebSocket sync transport
- ordered mutation log (`evolu_history`)

We store incremental updates:
```
fileUpdate { id, path, updateBase64 }
```

#### Custom Platform Layer (replacing `@evolu/web`)

The standard `@evolu/web` package is designed for browser environments and is
incompatible with Obsidian's CJS plugin context. Specifically:

- `import.meta.url` is unavailable in CJS — esbuild converts it to `{}`,
  breaking WASM file resolution and Web Worker creation.
- SharedWebWorker and OPFS (Origin Private File System) are not available in
  Obsidian's Electron renderer.
- The bundled SQLite WASM module (`@evolu/sqlite-wasm`) relies on dynamic
  `import('module')` calls that fail in Obsidian.

To work around this, we provide our own platform layer using only
`@evolu/common` and `@evolu/common/local-first`:

| Concern | `@evolu/web` | Our implementation |
|---|---|---|
| SQLite engine | WASM + OPFS (`@evolu/sqlite-wasm`) | `sql.js` (asm.js build, pure JS) |
| DB worker | SharedWebWorker via `import.meta.url` | Main-thread `createDbWorkerForPlatform` |
| Persistence | OPFS (browser file system) | `fs.writeFileSync` / `fs.readFileSync` to `.db` file in plugin dir |
| WebSocket | `createWebSocket` from `@evolu/common` | Same |
| Crypto / RNG | `createRandomBytes` from `@evolu/common` | Same |
| App reload | `location.replace(url)` | No-op (not applicable in Obsidian) |

This approach follows the same pattern as `@evolu/nodejs` (which uses
`better-sqlite3` + `createDbWorkerForPlatform`), but substitutes `sql.js` to
avoid native module compilation issues in Obsidian's Electron environment.

E2EE is fully preserved — encryption is handled in `@evolu/common` at the
CRDT message level, independent of the platform layer.

### 3) evolu_history (Incremental Sync)
We poll `evolu_history` for:
- table == "fileUpdate"
- column == "updateBase64"
ordered by timestamp

A local cursor (`_historyCursor`) prevents reprocessing.

### 4) Local-Only Tables
- `_fileSnapshot`: one snapshot per file (replaced, not accumulated)
- `_historyCursor`: last processed timestamp

### 5) LRU Memory Control
We keep at most `maxOpenDocs` Yjs docs in memory.
When over limit:
- flush outgoing updates
- save snapshot
- destroy Y.Doc
- evict least-recently-used

---

## 🛡 Architecture Guarantees

- Eventual consistency across devices
- Conflict-free merging (Yjs CRDT)
- Idempotent update application
- Offline safety (catch up after long offline)
- Incremental sync (deltas, not whole files)
- Deterministic ordered replay (Evolu timestamps)
- Memory bounded by LRU

---

## 📊 PRD

### Goal
Single-user multi-device sync for large Obsidian vaults using CRDT incremental updates.

### Target user
- 2–5 devices
- vault up to ~1GB
- devices can be offline for weeks/months

### Requirements
- Incremental sync
- Offline-first
- Conflict-free
- Memory safe
- Simple bootstrap

---

## ⚠ Design Risks

- Large formatter rewrites can create large updates (still correct)
- Extremely large single files → bigger snapshots
- Relay downtime pauses sync but resumes automatically

---

## 🛣 Roadmap (Future Improvements)

Low priority enhancements:
- Conflict inspection UI (very low priority)
- Sync status indicator panel
- Rename and delete propagation improvements
- Performance instrumentation

Out of scope:
- Folder-based selective sync
- Extra encryption layer
- Background workers
- Snapshot compaction

---

## 📄 License
MIT
