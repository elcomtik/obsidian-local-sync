# obsidian-local-sync — Issues Tracker

Last updated: 2026-02-22 (v0.0.3)

## Resolved

| ID | Description | Version |
|----|-------------|---------|
| BUG-1 | `getOrLoadFileState` read vault twice on bootstrap — `lastVaultText` could diverge from Yjs state | 0.0.3 |
| BUG-2 | `deviceId` not persisted on first install — new random ID on every restart before any setting changed | 0.0.3 |
| BUG-3 | `stop()` synchronous, closeDoc fire-and-forget — flush/snapshot writes lost on unload | 0.0.3 |
| PERF-1 | `toBase64` character-by-character loop — call-stack risk on large snapshots | 0.0.3 |
| SEC-1 | Mnemonic shown in ephemeral Notice toast, no copy button | 0.0.2 |

## Open

### Architecture
| ID | Location | Description |
|----|----------|-------------|
| ARCH-1 | `engine.ts:260` | Self-echo: own `fileUpdate` rows re-applied each poll (Yjs idempotent, but snapshot saved unnecessarily) |
| ARCH-2 | `engine.ts:260` | N+1 query: each history row → separate `applyFileUpdateRowById` query (up to 500 per poll) |
| ARCH-3 | `engine.ts:307` | Snapshot written after every remote update applied; should defer to end-of-batch |
| ARCH-4 | `engine.ts` | No rename/delete vault event handlers (acknowledged in roadmap) |

### Quality
| ID | Location | Description |
|----|----------|-------------|
| QUAL-1 | `main.ts:59` | `evolu: any` — all Evolu API calls in main.ts unchecked |
| QUAL-2 | `engine.ts:276` | `applyFileUpdateRowById(fileUpdateId: any)` — should use Evolu ID type |

### Performance
| ID | Location | Description |
|----|----------|-------------|
| PERF-2 | `engine.ts:319` | LRU eviction O(n) scan per eviction (negligible at maxOpenDocs=50) |

### Security
| ID | Location | Description |
|----|----------|-------------|
| SEC-2 | `main.ts:33` | `relayUrl` setting accepts any string, no `wss:`/`ws:` scheme validation |
