import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MATERIALIZER_REFRESH_DEBOUNCE_MS,
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES,
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS,
  DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS,
  YjsEvoluHistoryEngine,
} from "../src-core/engine";
import { DEFAULT_LOCAL_SYNC_CONFIG } from "../src-core/pathPolicy";
import type { Database } from "../src-core/schema";
import type { VaultAdapter, VaultFile, VaultFolderListing } from "../src-core/vaultAdapter";

type UpsertCall = {
  table: string;
  row: Record<string, unknown>;
};

test("settings repair preserves local edits already based on remote snapshot", async () => {
  const settingPath = ".obsidian/plugins/obsidian-importer/manifest.json";
  const remoteContent = JSON.stringify({ version: "1.0.0" });
  const localContent = JSON.stringify({ version: "1.1.0" });
  const remoteHash = "old-remote-hash";
  const upserts: UpsertCall[] = [];
  let writes = 0;

  const vault: VaultAdapter = {
    async listFiles(): Promise<VaultFile[]> {
      return [];
    },
    async listFolder(path: string): Promise<VaultFolderListing | null> {
      if (path === ".obsidian") return { files: [], folders: [".obsidian/plugins"] };
      if (path === ".obsidian/plugins") return { files: [], folders: [".obsidian/plugins/obsidian-importer"] };
      if (path === ".obsidian/plugins/obsidian-importer") return { files: [settingPath], folders: [] };
      return null;
    },
    async readText(path: string): Promise<string | null> {
      return path === settingPath ? localContent : null;
    },
    async writeText(): Promise<void> {
      writes++;
    },
    async deleteFile(): Promise<void> {},
    async fileExists(path: string): Promise<boolean> {
      return path === settingPath;
    },
    async ensureFolder(): Promise<void> {},
  };

  const engine = new YjsEvoluHistoryEngine({
    vault,
    evolu: {
      upsert(table: string, row: Record<string, unknown>) {
        upserts.push({ table, row });
      },
    } as unknown as import("@evolu/common").Evolu<Database>,
    deviceId: "test-device",
    config: {
      historyPollMs: 1000,
      historyBatchSize: 500,
      outgoingBatchMs: 10,
      maxOpenDocs: 10,
      vaultScanDebugProgressEveryFiles: DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES,
      vaultScanDebugProgressEveryMs: DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS,
      vaultScanInfoProgressEveryMs: DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS,
      materializerRefreshDebounceMs: DEFAULT_MATERIALIZER_REFRESH_DEBOUNCE_MS,
    },
    localSyncConfig: {
      ...DEFAULT_LOCAL_SYNC_CONFIG,
      syncObsidianSettings: true,
      settingsIncludeGlobs: [".obsidian/plugins/*/manifest.json"],
      settingsExcludeGlobs: [],
    },
    logLevel: "off",
  });

  const privateEngine = engine as unknown as {
    scanSettingsForUnsyncedFiles(label: string): Promise<void>;
    loadLatestSettingUpdatesFromHistory(): Promise<Map<string, { path: string; contentBase64: string; contentHash: string; encoding: null; type: null; id: string }>>;
    loadSettingSnapshot(path: string): Promise<{ contentHash: string; deleted: boolean } | null>;
  };

  privateEngine.loadLatestSettingUpdatesFromHistory = async () =>
    new Map([
      [
        settingPath,
        {
          id: "remote-setting",
          path: settingPath,
          contentBase64: btoa(remoteContent),
          contentHash: remoteHash,
          encoding: null,
          type: null,
        },
      ],
    ]);
  privateEngine.loadSettingSnapshot = async () => ({ contentHash: remoteHash, deleted: false });

  await privateEngine.scanSettingsForUnsyncedFiles("Regression settings scan");

  assert.equal(writes, 0, "repair must not rewrite the local setting back to old remote content");
  const settingUpserts = upserts.filter((call) => call.table === "settingUpdate");
  assert.equal(settingUpserts.length, 1, "scan should advertise the local setting edit");
  assert.equal(settingUpserts[0].row.path, settingPath);
  assert.notEqual(settingUpserts[0].row.contentHash, remoteHash);
});
