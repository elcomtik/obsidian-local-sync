import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_SYNC_CONFIG,
  getTrackingDecision,
  isTrackedVaultPath,
  type LocalSyncConfig,
} from "../src-core/pathPolicy";

test("default policy tracks Markdown, text, and canvas files", () => {
  assert.equal(isTrackedVaultPath("notes/a.md"), true);
  assert.equal(isTrackedVaultPath("notes/a.txt"), true);
  assert.equal(isTrackedVaultPath("boards/a.canvas"), true);
});

test("default policy excludes Git, trash, workspace, and LocalSync database files", () => {
  assert.deepEqual(getTrackingDecision({ path: ".git/config" }), {
    tracked: false,
    reason: "extension",
    extension: "",
  });
  assert.deepEqual(getTrackingDecision({ path: ".git/ignored.md" }), {
    tracked: false,
    reason: "excludeRule",
    rule: ".git/**",
  });
  assert.deepEqual(getTrackingDecision({ path: ".trash/deleted.md" }), {
    tracked: false,
    reason: "excludeRule",
    rule: ".trash/**",
  });
  assert.deepEqual(getTrackingDecision({ path: ".obsidian/workspace.json" }), {
    tracked: false,
    reason: "extension",
    extension: "json",
  });
  assert.deepEqual(getTrackingDecision({ path: ".obsidian/plugins/obsidian-local-sync/obsidian-local-sync.db" }), {
    tracked: false,
    reason: "extension",
    extension: "db",
  });
});

test("extension allow-list runs before exclude rules", () => {
  const decision = getTrackingDecision({ path: ".obsidian/workspace.json" }, {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    includeExtensions: ["json"],
  });

  assert.deepEqual(decision, {
    tracked: false,
    reason: "excludeRule",
    rule: ".obsidian/workspace*.json",
  });
});

test("later negated exclude rules re-include matching paths", () => {
  const config: LocalSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    excludeGlobs: [
      ".obsidian/**",
      "!.obsidian/app.json",
      "!.obsidian/snippets/**",
    ],
    includeExtensions: ["css", "json", "md"],
  };

  assert.deepEqual(getTrackingDecision({ path: ".obsidian/plugins/plugin/main.js" }, config), {
    tracked: false,
    reason: "extension",
    extension: "js",
  });
  assert.equal(isTrackedVaultPath(".obsidian/appearance.json", config), false);
  assert.equal(isTrackedVaultPath(".obsidian/app.json", config), true);
  assert.equal(isTrackedVaultPath(".obsidian/snippets/theme.css", config), true);
});

test("last matching rule wins for repeated include and exclude decisions", () => {
  const config: LocalSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    excludeGlobs: [
      "archive/**",
      "!archive/keep/**",
      "archive/keep/private/**",
    ],
  };

  assert.equal(isTrackedVaultPath("archive/drop.md", config), false);
  assert.equal(isTrackedVaultPath("archive/keep/public.md", config), true);
  assert.equal(isTrackedVaultPath("archive/keep/private/secret.md", config), false);
});
