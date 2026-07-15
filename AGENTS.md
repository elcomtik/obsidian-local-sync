# AGENTS.md

This repository inherits the workspace-level guidance from `../AGENTS.md`.
This file only records LocalSync-specific overrides.

## Commands

```sh
npm install
npm test
npx tsc --noEmit
npm run smoke:daemon
npm run build:plugin
npm run build:daemon
docker build -t obsidian-local-sync:local .
```

## Release Flow

- Release/version bumps are pushed directly to `main`, then tagged as
  `vX.Y.Z`.
- Keep `package.json`, `package-lock.json`, `manifest.json`, and `CHANGELOG.md`
  in sync for every release.
- After pushing a release tag, inspect the tag pipeline and confirm package,
  Docker image, and GitLab release jobs succeed.

## CI Rules

- MR and non-main branch pipelines should run unit tests, typecheck,
  `smoke-daemon`, and the normal Node build only.
- Docker image build/push jobs should run only on `main` and/or release tags.
  Do not let Renovate or feature MRs block on Docker runners.

## Downstream Chain

After a LocalSync release is published:

1. Release the `basic-memory-stack` chart with the new LocalSync image tag.
2. Update Ansible to the new chart version through a merge request.
3. Do not trigger the Ansible deployment pipeline; the user does that manually.
