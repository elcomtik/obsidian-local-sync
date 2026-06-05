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
| `LOCALSYNC_LOG_LEVEL` | `info` | `off`, `error`, `warn`, `info`, or `debug`. |
| `LOCALSYNC_INCLUDE_EXTENSIONS` | `md,txt,canvas` | Comma or whitespace separated tracked extensions, without dots. |
| `LOCALSYNC_EXCLUDE_GLOBS` | built-in defaults | Comma or newline separated path rules. Later rules win; prefix a rule with `!` to re-include like gitignore. |
| `LOCALSYNC_SYNC_OBSIDIAN_SETTINGS` | `false` | Sync allowlisted `.obsidian` settings as plain last-writer-wins files. |
| `LOCALSYNC_SETTINGS_INCLUDE_GLOBS` | JSON settings, themes, snippets | Comma or newline separated settings include rules. Used only when settings sync is enabled. |
| `LOCALSYNC_SETTINGS_EXCLUDE_GLOBS` | workspace state and LocalSync plugin dir | Comma or newline separated settings exclude rules. Later rules win; prefix a rule with `!` to re-include. |
| `LOCALSYNC_HISTORY_POLL_MS` | `1000` | Remote history poll interval. |
| `LOCALSYNC_HISTORY_BATCH_SIZE` | `500` | Remote history rows consumed per poll. |
| `LOCALSYNC_OUTGOING_BATCH_MS` | `500` | Local Yjs update flush debounce. |
| `LOCALSYNC_MAX_OPEN_DOCS` | `50` | Maximum open Yjs documents. |
| `LOCALSYNC_STARTUP_SCAN` | `true` | Scan vault on startup. |
| `LOCALSYNC_SYNC_DELETES` | `true` | Propagate local deletes and run startup offline-delete audit. |
| `LOCALSYNC_PERIODIC_RESCAN_SECONDS` | `0` | Periodically rescan tracked vault files. Set to `0` to disable. |
| `LOCALSYNC_SETTINGS_RESCAN_SECONDS` | `0` | Periodically rescan `.obsidian` settings files. Set to `0` to disable. |
| `LOCALSYNC_USE_POLLING` | `false` | Force chokidar polling. Useful on some network/PVC mounts. |
| `LOCALSYNC_POLL_INTERVAL_MS` | `1000` | Chokidar polling interval when polling is enabled. |

`LOCALSYNC_PERIODIC_RESCAN_SECONDS` is disabled by default. When enabled, the
daemon repeats the same tracked-file reconciliation used at startup: existing
snapshots are checked for offline drift, files with no local snapshot are
deferred until relay history is quiet, and offline-delete auditing runs when
`LOCALSYNC_SYNC_DELETES=true`. This is useful for vaults that may be changed by
tools outside the file watcher.

`LOCALSYNC_SETTINGS_RESCAN_SECONDS` is separate because `.obsidian` settings are
not part of the normal vault-file watch/listing model. Use it when settings
should propagate even if the platform does not emit watcher events for hidden
configuration files.

## Path Policy

LocalSync first filters by `LOCALSYNC_INCLUDE_EXTENSIONS`, then applies
`LOCALSYNC_EXCLUDE_GLOBS` in order. The last matching rule wins. Rules starting
with `!` re-include paths that were excluded by an earlier rule.

The Obsidian plugin ships with no vault-content exclude presets because
Obsidian's adapter already hides normal dotfile internals such as `.git`, and
settings are handled by the separate settings-sync policy. The standalone
daemon watches raw filesystem paths, so it keeps defensive default excludes for
Git metadata, Obsidian trash, macOS metadata, and common temporary files.

Obsidian settings sync is a separate opt-in policy. It does not use Yjs. When
`LOCALSYNC_SYNC_OBSIDIAN_SETTINGS=true`, LocalSync scans `.obsidian` via the
vault adapter and syncs settings as plain full-file updates in `settingUpdate`.
The default include policy covers JSON settings plus themes and snippets:

```text
.obsidian/**/*.json
.obsidian/themes/**
.obsidian/snippets/**
```

This includes app settings, graph/backlink/bookmark/daily-notes JSON, community
plugin JSON settings such as `.obsidian/plugins/<plugin>/data.json`, plus themes
and snippets. The Obsidian plugin UI exposes community plugin JSON settings as
Community plugin settings. Installed community plugin files (`main.js`,
`styles.css`, and `manifest.json`) are a separate opt-in toggle named Installed
community plugin files, and it is disabled by default. For the daemon, add
explicit include rules such as `.obsidian/plugins/*/main.js`,
`.obsidian/plugins/*/styles.css`, and `.obsidian/plugins/*/manifest.json` if
installed community plugin files should also sync. LocalSync's own plugin
directory is excluded by default so device-local settings such as `deviceId` are
not copied between peers.

Settings payloads are stored as base64 text in `settingUpdate`. LocalSync uses
raw UTF-8 base64 for small or incompressible settings and gzip-compressed base64
when compression reduces the stored payload size. Missing/null `encoding` means
raw text, so older settings rows stay readable.

Hidden `.obsidian` paths may not reliably emit file watcher events on every
platform. Startup scan always checks settings when settings sync is enabled; set
`LOCALSYNC_SETTINGS_RESCAN_SECONDS` above `0` when settings should propagate
while the daemon is running.

On startup/rescan, LocalSync repairs settings from already-replicated
`settingUpdate` history before it seeds local settings. That makes new peers
remote-first for settings: if a setting already exists in sync state, the local
file is replaced with the synced value; local files are advertised only when no
remote setting state exists for that path. Once a peer has a local snapshot for
the remote setting state, later local edits are preserved and advertised by the
settings scan instead of being repaired back to the old remote value.

## Daemon Policy Recipes

The daemon and plugin share the same engine, but the daemon is configured with
environment variables instead of plugin toggles.

### Plugin Default Equivalent

This matches a fresh plugin install before settings sync is enabled: sync normal
vault files only (`.md`, `.txt`, `.canvas`) and do not sync `.obsidian`
settings.

```bash
LOCALSYNC_INCLUDE_EXTENSIONS=md,txt,canvas
LOCALSYNC_SYNC_OBSIDIAN_SETTINGS=false
LOCALSYNC_SETTINGS_RESCAN_SECONDS=0
```

No `LOCALSYNC_SETTINGS_INCLUDE_GLOBS` or
`LOCALSYNC_SETTINGS_EXCLUDE_GLOBS` value is needed because settings sync is off.

### Plugin Defaults With Settings Sync Enabled

This matches enabling **Sync Obsidian settings** in the plugin UI while keeping
the default category toggles:

- main settings
- appearance settings, themes, and snippets
- hotkeys
- active core plugin list
- core plugin settings
- active community plugin list
- community plugin JSON settings
- installed community plugin files disabled

```bash
LOCALSYNC_SYNC_OBSIDIAN_SETTINGS=true
LOCALSYNC_SETTINGS_RESCAN_SECONDS=30
LOCALSYNC_SETTINGS_INCLUDE_GLOBS='.obsidian/app.json
.obsidian/backlink.json
.obsidian/bookmarks.json
.obsidian/daily-notes.json
.obsidian/graph.json
.obsidian/types.json
.obsidian/appearance.json
.obsidian/themes/**
.obsidian/snippets/**
.obsidian/hotkeys.json
.obsidian/core-plugins.json
.obsidian/*.json
.obsidian/community-plugins.json
.obsidian/plugins/*/*.json'
LOCALSYNC_SETTINGS_EXCLUDE_GLOBS='.obsidian/workspace*.json
.obsidian/plugins/*/manifest.json
.obsidian/plugins/obsidian-local-sync/**'
```

The `manifest.json` exclusion is what keeps community plugin settings such as
`data.json` synced while leaving installed plugin package metadata disabled.

### Settings Sync With Installed Plugin Files Enabled

Use this when the daemon should also sync installed community plugin source and
metadata, matching the plugin UI with **Installed community plugin files**
enabled.

```bash
LOCALSYNC_SYNC_OBSIDIAN_SETTINGS=true
LOCALSYNC_SETTINGS_RESCAN_SECONDS=30
LOCALSYNC_SETTINGS_INCLUDE_GLOBS='.obsidian/app.json
.obsidian/backlink.json
.obsidian/bookmarks.json
.obsidian/daily-notes.json
.obsidian/graph.json
.obsidian/types.json
.obsidian/appearance.json
.obsidian/themes/**
.obsidian/snippets/**
.obsidian/hotkeys.json
.obsidian/core-plugins.json
.obsidian/*.json
.obsidian/community-plugins.json
.obsidian/plugins/*/*.json
.obsidian/plugins/*/main.js
.obsidian/plugins/*/styles.css
.obsidian/plugins/*/manifest.json'
LOCALSYNC_SETTINGS_EXCLUDE_GLOBS='.obsidian/workspace*.json
.obsidian/plugins/obsidian-local-sync/**'
```

Large plugin files are still stored through the settings pipeline, not Yjs.
LocalSync compresses settings payloads with gzip when that reduces the stored
size.

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
.DS_Store
*.tmp
*.swp
```

`.obsidian` is handled by the separate settings-sync policy when
`LOCALSYNC_SYNC_OBSIDIAN_SETTINGS=true`; vault-content excludes intentionally do
not list individual Obsidian settings paths.

Example:

```bash
LOCALSYNC_INCLUDE_EXTENSIONS=md,txt,canvas
LOCALSYNC_EXCLUDE_GLOBS='archive/**
!archive/keep/**'
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

## Tests

```bash
npm test
```

The unit test suite currently covers the shared path policy, including default
tracked extensions, default excludes, and gitignore-style negation behavior.

## Smoke Test

```bash
npm run smoke:daemon
```

The smoke test creates a temporary vault, starts the daemon, writes and deletes
a tracked Markdown file, verifies empty-file advertisement, confirms the local
database is persisted, and shuts the process down cleanly.

## Scope

The daemon uses the same path policy model as the plugin. One daemon process is
intended to manage one vault.
