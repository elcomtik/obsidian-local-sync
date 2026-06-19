import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";
import { YjsEvoluHistoryEngine } from "../src-core/engine";
import { DEFAULT_LOCAL_SYNC_CONFIG } from "../src-core/pathPolicy";
import type { Database } from "../src-core/schema";
import type { VaultAdapter, VaultFile, VaultFolderListing } from "../src-core/vaultAdapter";

function makeYjsTextDoc(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, content);
  return { doc, text };
}

function makeEngine(vault: VaultAdapter): YjsEvoluHistoryEngine {
  return new YjsEvoluHistoryEngine({
    vault,
    evolu: {
      upsert() {},
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
    },
    localSyncConfig: DEFAULT_LOCAL_SYNC_CONFIG,
    logLevel: "off",
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
