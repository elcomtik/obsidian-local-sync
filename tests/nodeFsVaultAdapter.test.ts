import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getPathRuleDecision } from "../src-core/pathPolicy";
import { NodeFsVaultAdapter } from "../src-daemon/nodeFsVaultAdapter";

test("NodeFsVaultAdapter prunes excluded directories while listing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-local-sync-vault-"));
  try {
    await mkdir(path.join(root, ".git", "objects", "aa"), { recursive: true });
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, ".git", "objects", "aa", "ignored.md"), "ignored");
    await writeFile(path.join(root, "notes", "kept.md"), "kept");

    const adapter = new NodeFsVaultAdapter(root, (vaultPath) =>
      getPathRuleDecision(vaultPath, [".git/**"]).included,
    );

    assert.deepEqual(await adapter.listFiles(), [
      { path: "notes/kept.md", extension: "md" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
