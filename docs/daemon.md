# Local Sync Daemon

The daemon runs the shared LocalSync engine outside Obsidian. It watches one
vault directory on disk and syncs tracked text files through the same Evolu/Yjs
pipeline as the Obsidian plugin.

## Build

```bash
npm ci
npm run build:daemon
```

The daemon bundle is written to `dist-daemon/main.js`.

## Required Environment

| Variable | Description |
| --- | --- |
| `VAULT_NAME` | Logical vault name. Used in defaults and device id generation. |

`LOCALSYNC_MNEMONIC` is optional for local smoke tests, but required for a real
deployment that must join an existing sync owner.

## Optional Environment

| Variable | Default | Description |
| --- | --- | --- |
| `VAULT_ROOT` | `/vaults/${VAULT_NAME}` | Absolute path to the vault directory. |
| `LOCALSYNC_DB_PATH` | `${VAULT_ROOT}/.obsidian/plugins/obsidian-local-sync/obsidian-local-sync.db` | Local Evolu/sql.js database path. |
| `LOCALSYNC_MNEMONIC` | unset | Existing Evolu owner mnemonic to restore before syncing. |
| `LOCALSYNC_APP_NAME` | `obsidian-local-sync` | Evolu app name. |
| `DEVICE_ID` | `k8s-${VAULT_NAME}` | Stable daemon device id used in outgoing update ids. |
| `EVOLU_RELAY_URL` | `wss://free.evoluhq.com` | Evolu relay WebSocket URL. |
| `LOCALSYNC_LOG_LEVEL` | `info` | `off`, `error`, `warn`, or `info`. |
| `LOCALSYNC_INCLUDE_EXTENSIONS` | `md,txt,canvas` | Comma or whitespace separated tracked extensions, without dots. |
| `LOCALSYNC_EXCLUDE_GLOBS` | built-in defaults | Comma or newline separated path rules. Later rules win; prefix a rule with `!` to re-include like gitignore. |
| `LOCALSYNC_HISTORY_POLL_MS` | `1000` | Remote history poll interval. |
| `LOCALSYNC_HISTORY_BATCH_SIZE` | `500` | Remote history rows consumed per poll. |
| `LOCALSYNC_OUTGOING_BATCH_MS` | `500` | Local Yjs update flush debounce. |
| `LOCALSYNC_MAX_OPEN_DOCS` | `50` | Maximum open Yjs documents. |
| `LOCALSYNC_STARTUP_SCAN` | `true` | Scan vault on startup. |
| `LOCALSYNC_SYNC_DELETES` | `true` | Propagate local deletes and run startup offline-delete audit. |
| `LOCALSYNC_USE_POLLING` | `false` | Force chokidar polling. Useful on some network/PVC mounts. |
| `LOCALSYNC_POLL_INTERVAL_MS` | `1000` | Chokidar polling interval when polling is enabled. |

## Path Policy

LocalSync first filters by `LOCALSYNC_INCLUDE_EXTENSIONS`, then applies
`LOCALSYNC_EXCLUDE_GLOBS` in order. The last matching rule wins. Rules starting
with `!` re-include paths that were excluded by an earlier rule.

Default tracked extensions:

```text
md
txt
canvas
```

Default exclude rules:

```text
.git/**
.trash/**
.obsidian/workspace*.json
.obsidian/cache/**
.obsidian/plugins/obsidian-local-sync/*.db
.obsidian/plugins/obsidian-local-sync/*.db-shm
.obsidian/plugins/obsidian-local-sync/*.db-wal
.DS_Store
*.tmp
*.swp
```

Example:

```bash
LOCALSYNC_INCLUDE_EXTENSIONS=md,txt,canvas
LOCALSYNC_EXCLUDE_GLOBS='.obsidian/**
!.obsidian/app.json
!.obsidian/appearance.json
.git/**'
```

## Local Run

```bash
VAULT_NAME=test \
VAULT_ROOT=/tmp/obsidian-local-sync-vault \
node dist-daemon/main.js
```

For an existing owner, add `LOCALSYNC_MNEMONIC`.

## Docker Run

```bash
docker run --rm \
  -e VAULT_NAME=test \
  -e LOCALSYNC_MNEMONIC="$LOCALSYNC_MNEMONIC" \
  -v /path/to/vault:/vaults/test \
  registry.example/obsidian-local-sync:latest
```

## Smoke Test

```bash
npm run smoke:daemon
```

The smoke test creates a temporary vault, starts the daemon, writes and deletes
a tracked Markdown file, confirms the local database is persisted, and shuts the
process down cleanly.

## Scope

The daemon uses the same path policy model as the plugin. One daemon process is
intended to manage one vault.
