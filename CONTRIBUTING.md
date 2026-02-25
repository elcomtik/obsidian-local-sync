# Contributing

Contributions are welcome. The project has no test suite — correctness relies on the
properties of Yjs and Evolu, so manual testing against a real vault is required.

## Getting started

```bash
git clone https://github.com/elcomtik/obsidian-local-sync
cd obsidian-local-sync
npm install
npm run build
```

Copy `dist/` into a test vault and enable the plugin.

## Before submitting a PR

- Run `npx tsc --noEmit` — zero type errors required.
- Run `npm run build` — zero build errors required.
- Test against a real vault with at least two devices (or two vault copies) to verify sync behaviour.
- Update `CHANGELOG.md` with a short entry under the relevant version.
- Update `CLAUDE.md` if you fix a tracked issue or introduce a new architectural decision.

## Reporting bugs

Open an issue on GitHub. Include:
- Plugin version (from `manifest.json`)
- Obsidian version and platform (desktop / Android / iOS)
- Relevant lines from the developer console (Ctrl+Shift+I → Console, filter by `[obsidian-local-sync]`)

## Code style

- TypeScript, strict mode — no `any` unless genuinely unavoidable (document why).
- Modify only what the change requires — no opportunistic cleanups in adjacent code.
- Keep the `CLAUDE.md` known issues tracker up to date.
