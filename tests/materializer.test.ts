import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";
import {
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES,
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS,
  DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS,
  YjsEvoluHistoryEngine,
} from "../src-core/engine";
import { DEFAULT_LOCAL_SYNC_CONFIG } from "../src-core/pathPolicy";
import type { Database } from "../src-core/schema";
import type { VaultAdapter, VaultFile, VaultFolderListing } from "../src-core/vaultAdapter";

function makeYjsTextDoc(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, content);
  return { doc, text };
}

function makeEngine(vault: VaultAdapter, persistLocalDb?: () => Promise<void>): YjsEvoluHistoryEngine {
  return new YjsEvoluHistoryEngine({
    vault,
    evolu: {
      upsert(_table: string, _row: unknown, options?: { onComplete?: () => void }) {
        options?.onComplete?.();
        return { ok: true };
      },
      createQuery(query: unknown) {
        return query;
      },
      async loadQuery() {
        return [];
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
    },
    localSyncConfig: DEFAULT_LOCAL_SYNC_CONFIG,
    logLevel: "off",
    persistLocalDb,
  });
}

function makeVault(files: Map<string, string>, calls: { writes: string[]; deletes: string[] }): VaultAdapter {
  return {
    async listFiles(): Promise<VaultFile[]> {
      return Array.from(files.keys()).map((path) => ({ path }));
    },
    async listFolder(): Promise<VaultFolderListing | null> {
      return null;
    },
    async readText(path: string): Promise<string | null> {
      return files.get(path) ?? null;
    },
    async writeText(path: string, text: string): Promise<void> {
      calls.writes.push(path);
      files.set(path, text);
    },
    async deleteFile(path: string): Promise<void> {
      calls.deletes.push(path);
      files.delete(path);
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path);
    },
    async ensureFolder(): Promise<void> {},
  };
}

test("file materializer writes replayed history when vault still matches snapshot", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "old"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  const savedSnapshots: string[] = [];
  const savedSignatures: string[] = [];

  const privateEngine = engine as unknown as {
    materializeFilePlan(plan: { path: string; ids: string[]; signature: string; latestType: string | null }): Promise<void>;
    loadLocalSnapshotText(path: string): Promise<string | null>;
    materializeFileHistory(ids: string[]): Promise<{ doc: Y.Doc; text: Y.Text } | null>;
    saveLocalSnapshot(path: string, state: { text: Y.Text }): Promise<void>;
    saveFileMaterializationSignature(path: string, signature: string): Promise<void>;
  };

  privateEngine.loadLocalSnapshotText = async () => "old";
  privateEngine.materializeFileHistory = async () => makeYjsTextDoc("new");
  privateEngine.saveLocalSnapshot = async (_path, state) => {
    savedSnapshots.push(state.text.toString());
  };
  privateEngine.saveFileMaterializationSignature = async (_path, signature) => {
    savedSignatures.push(signature);
  };

  await privateEngine.materializeFilePlan({ path, ids: ["a", "b"], signature: "sig-1", latestType: null });

  assert.deepEqual(calls.writes, [path]);
  assert.equal(files.get(path), "new");
  assert.deepEqual(savedSnapshots, ["new"]);
  assert.deepEqual(savedSignatures, ["sig-1"]);
});

test("file materializer skips update when vault diverged from snapshot", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "local edit"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  let materialized = false;
  let savedSignature = false;

  const privateEngine = engine as unknown as {
    materializeFilePlan(plan: { path: string; ids: string[]; signature: string; latestType: string | null }): Promise<void>;
    loadLocalSnapshotText(path: string): Promise<string | null>;
    materializeFileHistory(ids: string[]): Promise<{ doc: Y.Doc; text: Y.Text } | null>;
    saveFileMaterializationSignature(path: string, signature: string): Promise<void>;
  };

  privateEngine.loadLocalSnapshotText = async () => "old";
  privateEngine.materializeFileHistory = async () => {
    materialized = true;
    return makeYjsTextDoc("remote");
  };
  privateEngine.saveFileMaterializationSignature = async () => {
    savedSignature = true;
  };

  await privateEngine.materializeFilePlan({ path, ids: ["a"], signature: "sig-1", latestType: null });

  assert.equal(materialized, false);
  assert.equal(savedSignature, false);
  assert.deepEqual(calls.writes, []);
  assert.equal(files.get(path), "local edit");
});

test("file materializer does not replan unchanged signatures blocked by local drift", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "local edit"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));

  const privateEngine = engine as unknown as {
    fileMaterializationBlockedSignatures: Map<string, string>;
    collectFileMaterializationPlans(force: boolean): Promise<Array<{ path: string; ids: string[]; signature: string; latestType: string | null }>>;
    loadFileMaterializationSignature(path: string): Promise<string | null>;
    evolu: { loadQuery(query: unknown): Promise<unknown[]> };
  };

  privateEngine.evolu.loadQuery = async () => [
    { id: "row-1", path, type: null },
    { id: "row-2", path, type: null },
  ];
  privateEngine.loadFileMaterializationSignature = async () => null;

  const firstPlans = await privateEngine.collectFileMaterializationPlans(false);
  assert.equal(firstPlans.length, 1);

  privateEngine.fileMaterializationBlockedSignatures.set(path, firstPlans[0].signature);

  assert.deepEqual(await privateEngine.collectFileMaterializationPlans(false), []);
  assert.equal((await privateEngine.collectFileMaterializationPlans(true)).length, 1);
});

test("incremental inbox gates only unscanned startup paths", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));

  const privateEngine = engine as unknown as {
    localSyncConfig: typeof DEFAULT_LOCAL_SYNC_CONFIG;
    scanComplete: boolean;
    startupPathsReady: boolean;
    startupUnscannedPaths: Set<string>;
    canProcessIncomingPath(path: string): boolean;
  };

  privateEngine.localSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    startupScan: true,
  };
  privateEngine.scanComplete = false;
  privateEngine.startupPathsReady = true;
  privateEngine.startupUnscannedPaths = new Set(["existing.md"]);

  assert.equal(privateEngine.canProcessIncomingPath("existing.md"), false);
  assert.equal(privateEngine.canProcessIncomingPath("remote-new.md"), true);
  privateEngine.startupUnscannedPaths.delete("existing.md");
  assert.equal(privateEngine.canProcessIncomingPath("existing.md"), true);
  privateEngine.scanComplete = true;
  assert.equal(privateEngine.canProcessIncomingPath("any.md"), true);
});

test("incremental file inbox applies only pending content without history replay", async () => {
  const path = "remote-new.md";
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  let persists = 0;
  const engine = makeEngine(makeVault(files, calls), async () => {
    persists++;
  });
  const remote = makeYjsTextDoc("remote content");
  const updateBase64 = Buffer.from(Y.encodeStateAsUpdate(remote.doc)).toString("base64");
  remote.doc.destroy();

  const privateEngine = engine as unknown as {
    processPendingFilePath(
      path: string,
      rows: Array<{
        id: string;
        path: string;
        updateBase64: string;
        type: string | null;
        createdAt: string;
        sourceVersion: string;
      }>,
    ): Promise<boolean>;
    loadFileUpdateRowsForPath(path: string): Promise<unknown>;
  };
  privateEngine.loadFileUpdateRowsForPath = async () => {
    throw new Error("normal content updates must not replay path history");
  };

  const applied = await privateEngine.processPendingFilePath(path, [
    {
      id: "remote-1",
      path,
      updateBase64,
      type: null,
      createdAt: "2026-06-22T10:00:00.000Z",
      sourceVersion: "2026-06-22T10:00:00.000Z",
    },
  ]);

  assert.equal(applied, true);
  assert.equal(files.get(path), "remote content");
  assert.deepEqual(calls.writes, [path]);
  assert.equal(persists, 1);
});

test("incremental file inbox persists processed marker after snapshot", async () => {
  const path = "ordered.md";
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const events: string[] = [];
  const vault = makeVault(files, calls);
  const originalWrite = vault.writeText;
  vault.writeText = async (writePath, text) => {
    events.push("vault");
    await originalWrite(writePath, text);
  };
  const engine = makeEngine(vault, async () => {
    events.push("persist");
  });
  const privateEngine = engine as unknown as {
    evolu: {
      upsert(
        table: string,
        row: Record<string, unknown>,
        options?: { onComplete?: () => void },
      ): { ok: true };
    };
    processPendingFilePath(
      path: string,
      rows: Array<{
        id: string;
        path: string;
        updateBase64: string;
        type: string | null;
        createdAt: string;
        sourceVersion: string;
      }>,
    ): Promise<boolean>;
  };
  privateEngine.evolu.upsert = (table, _row, options) => {
    if (table === "_fileSnapshot") events.push("snapshot");
    if (table === "_processedFileUpdate") events.push("processed");
    options?.onComplete?.();
    return { ok: true };
  };
  const remote = makeYjsTextDoc("ordered");
  const updateBase64 = Buffer.from(Y.encodeStateAsUpdate(remote.doc)).toString("base64");
  remote.doc.destroy();

  await privateEngine.processPendingFilePath(path, [
    {
      id: "remote-ordered",
      path,
      updateBase64,
      type: null,
      createdAt: "2026-06-22T10:00:00.000Z",
      sourceVersion: "2026-06-22T10:00:00.000Z",
    },
  ]);

  assert.ok(events.indexOf("vault") < events.indexOf("snapshot"));
  assert.ok(events.indexOf("snapshot") < events.indexOf("processed"));
  assert.ok(events.indexOf("processed") < events.indexOf("persist"));
});

test("processed markers use createdAt for inserts and updatedAt for later versions", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  const markerIds: string[] = [];
  const privateEngine = engine as unknown as {
    evolu: {
      upsert(
        table: string,
        row: Record<string, unknown>,
        options?: { onComplete?: () => void },
      ): { ok: true };
    };
    markFileRowsProcessed(
      rows: Array<{ id: string; createdAt: string; updatedAt?: string }>,
    ): Promise<void>;
  };
  privateEngine.evolu.upsert = (table, row, options) => {
    if (table === "_processedFileUpdate") markerIds.push(row.id as string);
    options?.onComplete?.();
    return { ok: true };
  };

  await privateEngine.markFileRowsProcessed([
    { id: "stable-row", createdAt: "2026-06-22T10:00:00.000Z" },
    {
      id: "stable-row",
      createdAt: "2026-06-22T10:00:00.000Z",
      updatedAt: "2026-06-22T11:00:00.000Z",
    },
  ]);

  assert.equal(markerIds.length, 2);
  assert.notEqual(markerIds[0], markerIds[1]);
});

test("startup scan skips Yjs and snapshot writes when the vault hash matches", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "unchanged content"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  let loaded = false;
  let contentHash: string | null = null;
  const state = makeYjsTextDoc("unchanged content");

  const privateEngine = engine as unknown as {
    evolu: { upsert(table: string, row: Record<string, unknown>): void };
    reconcileVaultFile(path: string): Promise<string>;
    loadLocalSnapshotRecord(path: string): Promise<{ snapshotBase64: string; contentHash: string | null }>;
    getOrLoadFileState(path: string): Promise<unknown>;
    saveLocalSnapshot(path: string, state: { doc: Y.Doc; text: Y.Text }): Promise<void>;
  };

  privateEngine.evolu.upsert = (table, row) => {
    if (table === "_fileSnapshot") contentHash = row.contentHash as string;
  };
  await privateEngine.saveLocalSnapshot(path, state);
  state.doc.destroy();

  privateEngine.loadLocalSnapshotRecord = async () => ({
    snapshotBase64: "snapshot",
    contentHash,
  });
  privateEngine.getOrLoadFileState = async () => {
    loaded = true;
    return {};
  };

  assert.equal(await privateEngine.reconcileVaultFile(path), "unchanged");
  assert.equal(loaded, false);
});

test("saved file snapshots include the materialized content hash", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  let savedRow: Record<string, unknown> | null = null;
  const state = makeYjsTextDoc("snapshot content");

  const privateEngine = engine as unknown as {
    evolu: { upsert(table: string, row: Record<string, unknown>): void };
    saveLocalSnapshot(path: string, state: { doc: Y.Doc; text: Y.Text }): Promise<void>;
  };
  privateEngine.evolu.upsert = (table, row) => {
    if (table === "_fileSnapshot") savedRow = row;
  };

  await privateEngine.saveLocalSnapshot("notes/example.md", state);
  state.doc.destroy();

  assert.equal(typeof savedRow?.contentHash, "string");
  assert.equal((savedRow?.contentHash as string).length, 16);
});

test("startup catch-up emits deterministic updates for repeated same drift", async () => {
  const path = "addressbook/Andrej Slebodnik.md";
  const snapshotDoc = makeYjsTextDoc("old");
  const snapshotBase64 = Buffer.from(Y.encodeStateAsUpdate(snapshotDoc.doc)).toString("base64");
  snapshotDoc.doc.destroy();

  const collectCatchUp = async () => {
    const files = new Map([[path, "old plus"]]);
    const calls = { writes: [] as string[], deletes: [] as string[] };
    const fileUpdates: Array<{ id: string; path: string; updateBase64: string; originDeviceId: string }> = [];
    const engine = makeEngine(makeVault(files, calls));

    const privateEngine = engine as unknown as {
      evolu: { upsert(table: string, row: Record<string, unknown>): void };
      getOrLoadFileState(path: string): Promise<unknown>;
      closeDoc(path: string): Promise<boolean>;
      loadLocalSnapshot(path: string): Promise<string | null>;
    };

    privateEngine.evolu.upsert = (table, row) => {
      if (table === "fileUpdate") {
        fileUpdates.push({
          id: row.id as string,
          path: row.path as string,
          updateBase64: row.updateBase64 as string,
          originDeviceId: row.originDeviceId as string,
        });
      }
    };
    privateEngine.loadLocalSnapshot = async () => snapshotBase64;

    await privateEngine.getOrLoadFileState(path);
    await privateEngine.closeDoc(path);

    assert.equal(fileUpdates.length, 1);
    assert.equal(fileUpdates[0].originDeviceId, "test-device");
    return fileUpdates[0];
  };

  assert.deepEqual(await collectCatchUp(), await collectCatchUp());
});

test("startup catch-up propagates an offline edit that empties a file", async () => {
  const path = "notes/emptied.md";
  const snapshotDoc = makeYjsTextDoc("previous content");
  const snapshotBase64 = Buffer.from(Y.encodeStateAsUpdate(snapshotDoc.doc)).toString("base64");
  snapshotDoc.doc.destroy();
  const files = new Map([[path, ""]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const fileUpdates: Record<string, unknown>[] = [];
  const engine = makeEngine(makeVault(files, calls));

  const privateEngine = engine as unknown as {
    evolu: { upsert(table: string, row: Record<string, unknown>): void };
    loadLocalSnapshot(path: string): Promise<string | null>;
    getOrLoadFileState(path: string): Promise<unknown>;
    closeDoc(path: string): Promise<boolean>;
  };
  privateEngine.evolu.upsert = (table, row) => {
    if (table === "fileUpdate") fileUpdates.push(row);
  };
  privateEngine.loadLocalSnapshot = async () => snapshotBase64;

  await privateEngine.getOrLoadFileState(path);
  await privateEngine.closeDoc(path);

  assert.equal(fileUpdates.length, 1);
});

test("outgoing file flush does not force local db persist", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "old plus"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const events: string[] = [];
  const engine = makeEngine(makeVault(files, calls), async () => {
    events.push("persist");
  });

  const privateEngine = engine as unknown as {
    evolu: { upsert(table: string, row: Record<string, unknown>): void };
    loadLocalSnapshot(path: string): Promise<string | null>;
    getOrLoadFileState(path: string): Promise<unknown>;
    closeDoc(path: string): Promise<boolean>;
  };

  privateEngine.evolu.upsert = (table) => {
    events.push(table);
  };
  privateEngine.loadLocalSnapshot = async () => null;

  await privateEngine.getOrLoadFileState(path);
  await privateEngine.closeDoc(path);

  assert.deepEqual(events, ["fileUpdate", "_fileSnapshot", "_fileSnapshot"]);
});

test("file materializer persists local db after writing vault file", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "old"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  let persists = 0;
  const engine = makeEngine(makeVault(files, calls), async () => {
    persists++;
  });

  const privateEngine = engine as unknown as {
    materializeFilePlan(plan: { path: string; ids: string[]; signature: string; latestType: string | null }): Promise<void>;
    loadLocalSnapshotText(path: string): Promise<string | null>;
    materializeFileHistory(ids: string[]): Promise<{ doc: Y.Doc; text: Y.Text } | null>;
  };

  privateEngine.loadLocalSnapshotText = async () => "old";
  privateEngine.materializeFileHistory = async () => makeYjsTextDoc("remote");

  await privateEngine.materializeFilePlan({ path, ids: ["a"], signature: "sig-persist", latestType: null });

  assert.deepEqual(calls.writes, [path]);
  assert.equal(files.get(path), "remote");
  assert.equal(persists, 1);
});

test("periodic settings rescan waits for startup vault scan", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  const privateEngine = engine as unknown as {
    localSyncConfig: typeof DEFAULT_LOCAL_SYNC_CONFIG;
    scanComplete: boolean;
    runPeriodicSettingsRescan(): Promise<void>;
    scanSettingsForUnsyncedFiles(label: string): Promise<void>;
  };
  let scans = 0;

  privateEngine.localSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    syncObsidianSettings: true,
    startupScan: true,
  };
  privateEngine.scanComplete = false;
  privateEngine.scanSettingsForUnsyncedFiles = async () => {
    scans++;
  };

  await privateEngine.runPeriodicSettingsRescan();

  assert.equal(scans, 0);
});

test("settings scans do not overlap", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  const privateEngine = engine as unknown as {
    localSyncConfig: typeof DEFAULT_LOCAL_SYNC_CONFIG;
    scanSettingsForUnsyncedFiles(label: string): Promise<void>;
    listTrackedSettingPaths(): Promise<string[]>;
  };
  let listings = 0;
  let releaseFirstScan!: () => void;
  const firstScanStarted = new Promise<void>((resolve) => {
    privateEngine.listTrackedSettingPaths = async () => {
      listings++;
      resolve();
      await new Promise<void>((release) => {
        releaseFirstScan = release;
      });
      return [];
    };
  });

  privateEngine.localSyncConfig = {
    ...DEFAULT_LOCAL_SYNC_CONFIG,
    syncObsidianSettings: true,
  };
  const firstScan = privateEngine.scanSettingsForUnsyncedFiles("first");
  await firstScanStarted;
  await privateEngine.scanSettingsForUnsyncedFiles("second");
  releaseFirstScan();
  await firstScan;

  assert.equal(listings, 1);
});

test("file materializer materializes clean open doc and keeps local update listener", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "old"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  const openDoc = makeYjsTextDoc("old");
  const savedSignatures: string[] = [];

  const privateEngine = engine as unknown as {
    states: Map<string, { doc: Y.Doc; text: Y.Text; pendingUpdates: Uint8Array[] }>;
    createFileStateFromDoc(path: string, doc: Y.Doc, text: Y.Text, lastVaultText: string, ignoreNextVaultModify: boolean): unknown;
    materializeFilePlan(plan: { path: string; ids: string[]; signature: string; latestType: string | null }): Promise<void>;
    loadLocalSnapshotText(path: string): Promise<string | null>;
    materializeFileHistory(ids: string[]): Promise<{ doc: Y.Doc; text: Y.Text } | null>;
    saveLocalSnapshot(path: string, state: { text: Y.Text }): Promise<void>;
    saveFileMaterializationSignature(path: string, signature: string): Promise<void>;
  };

  privateEngine.states.set(
    path,
    privateEngine.createFileStateFromDoc(path, openDoc.doc, openDoc.text, "old", false) as {
      doc: Y.Doc;
      text: Y.Text;
      pendingUpdates: Uint8Array[];
    },
  );
  privateEngine.loadLocalSnapshotText = async () => "old";
  privateEngine.materializeFileHistory = async () => makeYjsTextDoc("new");
  privateEngine.saveLocalSnapshot = async () => {};
  privateEngine.saveFileMaterializationSignature = async (_path, signature) => {
    savedSignatures.push(signature);
  };

  await privateEngine.materializeFilePlan({ path, ids: ["a"], signature: "sig-open", latestType: null });

  assert.deepEqual(calls.writes, [path]);
  assert.equal(files.get(path), "new");
  assert.deepEqual(savedSignatures, ["sig-open"]);

  const materializedState = privateEngine.states.get(path);
  assert.ok(materializedState, "materialized state should remain open");
  materializedState.doc.transact(() => materializedState.text.insert(materializedState.text.length, "!"));
  assert.equal(materializedState.pendingUpdates.length, 1, "future local edits must still enqueue outgoing updates");
});

test("file materializer applies delete when vault still matches snapshot", async () => {
  const path = "reviews/weekly-review-template.md";
  const files = new Map([[path, "old"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  let tombstoned = false;
  const savedSignatures: string[] = [];

  const privateEngine = engine as unknown as {
    materializeFilePlan(plan: { path: string; ids: string[]; signature: string; latestType: string | null }): Promise<void>;
    loadLocalSnapshotText(path: string): Promise<string | null>;
    tombstoneSnapshot(path: string): void;
    saveFileMaterializationSignature(path: string, signature: string): Promise<void>;
  };

  privateEngine.loadLocalSnapshotText = async () => "old";
  privateEngine.tombstoneSnapshot = () => {
    tombstoned = true;
  };
  privateEngine.saveFileMaterializationSignature = async (_path, signature) => {
    savedSignatures.push(signature);
  };

  await privateEngine.materializeFilePlan({ path, ids: ["delete"], signature: "sig-delete", latestType: "delete" });

  assert.equal(tombstoned, true);
  assert.deepEqual(calls.deletes, [path]);
  assert.equal(files.has(path), false);
  assert.deepEqual(savedSignatures, ["sig-delete"]);
});

test("manual materialization repair forces file and setting plans and reports counts", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));

  const privateEngine = engine as unknown as {
    runMaterializationRepairNow(label?: string): Promise<{
      files: { planned: number; written: number; deleted: number; unchanged: number; skippedLocalDrift: number; failed: number };
      settings: { planned: number; written: number; deleted: number; unchanged: number; skippedLocalDrift: number; failed: number };
    }>;
    collectFileMaterializationPlans(force: boolean): Promise<Array<{ path: string; ids: string[]; signature: string; latestType: string | null }>>;
    collectSettingMaterializationPlans(force: boolean): Promise<Array<{ path: string; id: string; signature: string; row: unknown }>>;
    materializeFilePlan(plan: unknown): Promise<"written" | "deleted" | "unchanged" | "skipped-local-drift" | "failed">;
    materializeSettingPlan(plan: unknown): Promise<"written" | "deleted" | "unchanged" | "skipped-local-drift" | "failed">;
  };

  const forceFlags: boolean[] = [];
  privateEngine.collectFileMaterializationPlans = async (force) => {
    forceFlags.push(force);
    return [
      { path: "a.md", ids: ["a"], signature: "a", latestType: null },
      { path: "b.md", ids: ["b"], signature: "b", latestType: null },
    ];
  };
  privateEngine.collectSettingMaterializationPlans = async (force) => {
    forceFlags.push(force);
    return [{ path: ".obsidian/app.json", id: "s", signature: "s", row: {} }];
  };
  privateEngine.materializeFilePlan = async (plan) =>
    (plan as { path: string }).path === "a.md" ? "written" : "skipped-local-drift";
  privateEngine.materializeSettingPlan = async () => "unchanged";

  const result = await privateEngine.runMaterializationRepairNow();

  assert.deepEqual(forceFlags, [true, true]);
  assert.deepEqual(result.files, {
    planned: 2,
    written: 1,
    deleted: 0,
    unchanged: 0,
    skippedLocalDrift: 1,
    failed: 0,
  });
  assert.deepEqual(result.settings, {
    planned: 1,
    written: 0,
    deleted: 0,
    unchanged: 1,
    skippedLocalDrift: 0,
    failed: 0,
  });
});
