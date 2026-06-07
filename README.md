
# LocalSync

[![CI](https://github.com/elcomtik/obsidian-local-sync/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/elcomtik/obsidian-local-sync/actions/workflows/release.yml)

Single-user, multi-device file sync for Obsidian using:

- **Yjs** → CRDT document engine (source of truth)
- **Evolu** → local-first database + sync transport
- **evolu_history** → ordered mutation stream
- **LRU memory management**
- **Configurable performance settings**
- **Mnemonic-based device bootstrap**
- **Console logging** (off / error / warn / info)
- **Optional Obsidian settings sync** for allowlisted `.obsidian` JSON files

This is an experimental local-first architecture for syncing note files
incrementally without retransmitting full file contents. Optional Obsidian
settings sync uses plain full-file updates instead of Yjs because settings JSON
is configuration, not collaborative prose.

---

## 📱 Platform Support

| Platform | Status |
|----------|--------|
| macOS (desktop) | ✅ Supported |
| Linux (desktop) | ✅ Supported |
| Windows (desktop) | ✅ Supported |
| Android (mobile) | ✅ Supported |
| iOS (mobile) | 🔲 Untested |

The plugin uses Obsidian's cross-platform `DataAdapter` API for all file I/O,
so it runs on both Electron (desktop) and the mobile WebView without any
platform-specific code paths.

---

## 🚀 Quick Start

### Build

```bash
npm install
npm run build
```

### Daemon

The Node.js daemon build watches a vault directory outside Obsidian and is
intended for container/Kubernetes deployment. See [docs/daemon.md](docs/daemon.md).

### Install into a vault

Copy the `dist/` folder to:

```
<your-vault>/.obsidian/plugins/obsidian-local-sync/
```

Enable the plugin in Obsidian → Settings → Community Plugins.

The Obsidian plugin keeps the stable plugin id `obsidian-local-sync`, but its
display name is `LocalSync`.

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
4. Click Restore — wait 5 seconds, then click **Confirm restore?** to proceed
5. LocalSync deletes this device's synced local vault files listed by Obsidian's
   vault API and the local DB, restores the pasted identity, then rebuilds from
   remote history

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

When Obsidian settings sync is enabled, settings are stored separately as
plain last-writer-wins updates:

```
settingUpdate { id, path, contentBase64, contentHash, encoding }
```

Settings sync is disabled by default. When enabled, the default policy tracks
Obsidian JSON settings, themes, snippets, and community plugin JSON settings
unless excluded by settings exclude rules. Installed community plugin files
(`main.js`, `styles.css`, and `manifest.json`) can be enabled on demand with
the Installed community plugin files setting.

> [!WARNING]
> Never sync LocalSync's own plugin directory:
> `.obsidian/plugins/obsidian-local-sync/**`.
>
> LocalSync stores its own database, device identity, settings, and runtime
> plugin files there. Replicating that directory can overwrite the running
> plugin, copy device-local identity/settings between peers, corrupt or replace
> the local Evolu database, and create self-update loops that break sync across
> the vault. LocalSync excludes this directory by default; keep that exclusion
> in any custom settings policy.

Startup and rescan repair settings from existing `settingUpdate` history before
seeding local files, so a new peer should adopt already-synced settings instead
of publishing its local defaults over them. For an initialized peer, repair
preserves local settings edits made after the last snapshotted remote state and
lets the following settings scan advertise them.
Settings payloads use raw UTF-8 base64 by default and may use gzip compression
when that makes the stored payload smaller (`encoding = "gzip"`). Older raw
settings rows remain readable because missing/null `encoding` means raw text.
Because Obsidian does not reliably emit vault events for hidden `.obsidian`
files, settings sync has its own rescan interval. Enabling settings sync from
the plugin UI sets settings rescan to 30 seconds when it was disabled; vault
content rescan remains separate.

The Obsidian plugin has no vault-content exclude presets by default. Obsidian's
adapter does not expose normal dotfile internals such as `.git`, and `.obsidian`
settings are handled by the dedicated settings-sync policy. The standalone
daemon keeps filesystem-oriented default excludes because it watches raw disk
paths.

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
- table == "settingUpdate"
- column == "contentBase64"
ordered by timestamp

A local cursor (`_historyCursor`) prevents reprocessing.
The cursor is advanced only after contiguous history rows are successfully
handled; if a referenced synced row is missing or a remote write fails, the
cursor stays before that row so the next poll retries it.

### 4) Local-Only Tables
- `_fileSnapshot`: one snapshot per file (replaced, not accumulated)
- `_settingSnapshot`: one content hash per synced settings file plus tombstones
- `_historyCursor`: last processed timestamp

The plugin settings include a dangerous **Reset local sync state** action. It
deletes this device's tracked synced vault files returned by Obsidian's vault
API and the LocalSync SQLite database, restores the existing mnemonic into a
fresh local DB, and restarts sync from remote history. Use it when a local peer's
LocalSync DB is corrupted or its local cursor/state needs to be rebuilt from
remote history; wiping the local files first prevents stale vault content from
being seeded into the fresh DB. The wipe does not recursively delete dotfiles or
adapter-only `.obsidian` paths.

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

## ⚠ Known Limitations

### Intended use case

LocalSync is designed for **single-user, multi-device** workflows: one person syncing
the same vault across a laptop, desktop, and phone. It is **not** designed for
collaborative real-time editing by multiple people. The CRDT engine prevents data loss,
but simultaneous edits by different users to the same file may produce unexpected merge
results and are outside the supported use case.

### Conflicting edits to the same file

If two devices **edit the same file independently** while offline (or before one device
receives the other's updates), Yjs will CRDT-merge the changes. The result is
deterministic and lossless, but may not match either device's intent — for example,
paragraphs added on both sides will both appear in the merged file, possibly interleaved.

This is the same trade-off made by all CRDT-based sync systems. There is no "last writer
wins" or conflict prompt — both edits are preserved.

### Concurrent lifecycle + content conflicts

If two devices simultaneously perform a **lifecycle event** (delete or rename) and a
**content edit** on the same file, the outcome is non-deterministic:

- Delete + edit at the same time: the edited version may recreate the deleted file.
- Rename + edit at the same time: the old path may reappear temporarily alongside the new path.

This is a fundamental property of local-first distributed systems — without a central
coordinator there is no way to cleanly order conflicting intents. For typical single-user
workflows this never occurs. Manual cleanup may be needed if these rare conflicts arise.

### Text files only

Only `.md` and `.txt` files are synced.

---

## 🛣 Roadmap (Future Improvements)

Low priority enhancements:
- Conflict inspection UI (very low priority)
- Sync status indicator panel
- Performance instrumentation

Out of scope:
- Folder-based selective sync
- Extra encryption layer
- Background workers
- Snapshot compaction

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📄 License
MIT
