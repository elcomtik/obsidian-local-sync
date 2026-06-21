import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_SYNC_CONFIG,
  getTrackingDecision,
  isTrackedSettingPath,
  isTrackedVaultPath,
  type LocalSyncConfig,
} from "../src-core/pathPolicy";

test("default policy tracks Markdown, text, and canvas files", () => {
  assert.equal(isTrackedVaultPath("notes/a.md"), true);
  assert.equal(isTrackedVaultPath("notes/a.txt"), true);
  assert.equal(isTrackedVaultPath("boards/a.canvas"), true);
});

test("default policy excludes local metadata before extension checks", () => {
  assert.deepEqual(getTrackingDecision({ path: ".git/config" }), {
    tracked: false,
    reason: "excludeRule",
    rule: ".git/**",
  });
  assert.equal(isTrackedVaultPath(".git/ignored.md"), false);
  assert.equal(isTrackedVaultPath(".trash/deleted.md"), true);
  assert.deepEqual(getTrackingDecision({ path: ".obsidian/workspace.json" }), {
    tracked: false,
    reason: "extension",
    extension: "json",
  });
  assert.deepEqual(getTrackingDecision({ path: ".obsidian/plugins/obsidian-local-sync/obsidian-local-sync.db" }), {
    tracked: false,
    reason: "excludeRule",
    rule: ".obsidian/plugins/obsidian-local-sync/**",
  });
});

test("exclude rules run before extension allow-list", () => {
  const decision = getTrackingDecision({ path: ".trash/deleted.json" }, {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    includeExtensions: ["json"],
    excludeGlobs: [".trash/**"],
  });

  assert.deepEqual(decision, {
    tracked: false,
    reason: "excludeRule",
    rule: ".trash/**",
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
    reason: "excludeRule",
    rule: ".obsidian/**",
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

test("Obsidian settings sync is disabled by default", () => {
  assert.equal(isTrackedSettingPath(".obsidian/app.json"), false);
});

test("Obsidian settings policy tracks JSON settings when enabled", () => {
  const config: LocalSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    syncObsidianSettings: true,
  };

  assert.equal(isTrackedSettingPath(".obsidian/app.json", config), true);
  assert.equal(isTrackedSettingPath(".obsidian/graph.json", config), true);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/obsidian-tasks-plugin/data.json", config), true);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/obsidian-tasks-plugin/main.js", config), false);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/obsidian-tasks-plugin/styles.css", config), false);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/obsidian-local-sync/data.json", config), false);
  assert.equal(isTrackedSettingPath("notes/app.json", config), false);
});

test("Obsidian settings policy supports explicit excludes and negation", () => {
  const config: LocalSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    syncObsidianSettings: true,
    settingsExcludeGlobs: [
      ".obsidian/workspace*.json",
      ".obsidian/plugins/**",
      "!.obsidian/plugins/obsidian-tasks-plugin/data.json",
    ],
  };

  assert.equal(isTrackedSettingPath(".obsidian/app.json", config), true);
  assert.equal(isTrackedSettingPath(".obsidian/workspace.json", config), false);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/other/data.json", config), false);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/obsidian-tasks-plugin/data.json", config), true);
});

test("Obsidian settings policy can split plugin settings from installed plugin files", () => {
  const pluginSettingsOnly: LocalSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    syncObsidianSettings: true,
    settingsIncludeGlobs: [".obsidian/plugins/*/*.json"],
    settingsExcludeGlobs: [
      ".obsidian/plugins/*/manifest.json",
      ".obsidian/plugins/obsidian-local-sync/**",
    ],
  };

  assert.equal(isTrackedSettingPath(".obsidian/plugins/tasks/data.json", pluginSettingsOnly), true);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/tasks/manifest.json", pluginSettingsOnly), false);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/tasks/main.js", pluginSettingsOnly), false);

  const installedFilesOnly: LocalSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    syncObsidianSettings: true,
    settingsIncludeGlobs: [
      ".obsidian/plugins/*/main.js",
      ".obsidian/plugins/*/styles.css",
      ".obsidian/plugins/*/manifest.json",
    ],
    settingsExcludeGlobs: [
      ".obsidian/plugins/*/*.json",
      "!.obsidian/plugins/*/manifest.json",
      ".obsidian/plugins/obsidian-local-sync/**",
    ],
  };

  assert.equal(isTrackedSettingPath(".obsidian/plugins/tasks/data.json", installedFilesOnly), false);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/tasks/manifest.json", installedFilesOnly), true);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/tasks/main.js", installedFilesOnly), true);
  assert.equal(isTrackedSettingPath(".obsidian/plugins/tasks/styles.css", installedFilesOnly), true);
});
