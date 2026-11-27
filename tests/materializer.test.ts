import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";
import {
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES,
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS,
  DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS,
  DEFAULT_VAULT_RESCAN_WATCHDOG_MS,
  type ApplyJournalStore,
  type FatalEngineErrorHandler,
  type SyncProgress,
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

function makeEngine(
  vault: VaultAdapter,
  persistLocalDb?: () => Promise<void>,
  reportSyncProgress?: (progress: SyncProgress) => void,
  applyJournalStore?: ApplyJournalStore,
  onFatalError?: FatalEngineErrorHandler,
): YjsEvoluHistoryEngine {
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
      inboxCheckpointBatchPaths: 50,
      outgoingBatchMs: 10,
      maxOpenDocs: 10,
      vaultScanDebugProgressEveryFiles: DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES,
      vaultScanDebugProgressEveryMs: DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS,
      vaultScanInfoProgressEveryMs: DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS,
      vaultRescanWatchdogMs: DEFAULT_VAULT_RESCAN_WATCHDOG_MS,
    },
    localSyncConfig: DEFAULT_LOCAL_SYNC_CONFIG,
    logLevel: "off",
    persistLocalDb,
    reportSyncProgress,
    applyJournalStore,
    onFatalError,
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

test("startup scan reports progress through completion", async () => {
  const files = new Map(Array.from({ length: 6 }, (_, index) => [`notes/${index}.md`, "text"]));
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const progress: SyncProgress[] = [];
  const engine = makeEngine(makeVault(files, calls), undefined, (event) => progress.push(event));
  const privateEngine = engine as unknown as {
    scanVaultForUnsyncedFiles(label: string): Promise<void>;
  };

  await privateEngine.scanVaultForUnsyncedFiles("Startup scan");

  const syncing = progress.filter(
    (event): event is Extract<SyncProgress, { status: "syncing" }> => event.status === "syncing",
  );
  assert.deepEqual(syncing[0], {
    status: "syncing",
    message: "LocalSync is checking local files.",
    current: 0,
    total: 6,
  });
  assert.equal(syncing.at(-1)?.current, 6);
  assert.equal(syncing.at(-1)?.total, 6);
});

test("manual vault scan audits deletes and reports progress", async () => {
  const files = new Map([["notes/local.md", "text"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const progress: SyncProgress[] = [];
  const engine = makeEngine(makeVault(files, calls), undefined, (event) => progress.push(event));
  const privateEngine = engine as unknown as {
    auditSnapshotsForOfflineDeletes(label: string): Promise<void>;
  };
  const labels: string[] = [];
  privateEngine.auditSnapshotsForOfflineDeletes = async (label) => {
    labels.push(label);
  };

  await engine.runVaultScanNow();

  assert.deepEqual(labels, ["Manual vault scan"]);
  assert.equal(progress.find((event) => event.status === "syncing")?.message, "LocalSync is checking local files.");
  assert.deepEqual(progress.at(-1), {
    status: "caught-up",
    message: "LocalSync local vault scan complete.",
  });
});

test("periodic vault rescan watchdog reports fatal error when audit hangs", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  let fatalContext: unknown = null;
  const fatal = new Promise<Error>((resolve) => {
    const engine = makeEngine(makeVault(files, calls), undefined, undefined, undefined, (error, context) => {
      fatalContext = context;
      resolve(error);
    });
    const privateEngine = engine as unknown as {
      config: {
        vaultRescanWatchdogMs: number;
      };
      auditSnapshotsForOfflineDeletes(label: string): Promise<void>;
      runPeriodicVaultRescanWithWatchdog(): Promise<void>;
    };
    privateEngine.config.vaultRescanWatchdogMs = 10;
    privateEngine.auditSnapshotsForOfflineDeletes = async () => new Promise<void>(() => {});

    void privateEngine.runPeriodicVaultRescanWithWatchdog();
  });

  const error = await fatal;
  const context = fatalContext as { label: string; elapsedMs: number; watchdogMs: number };

  assert.match(error.message, /watchdog timeout/);
  assert.equal(context.label, "Periodic vault rescan");
  assert.equal(context.watchdogMs, 10);
  assert.ok(context.elapsedMs >= 10);
});

test("incremental inbox reports discovered and applied remote rows", async () => {
  const path = "remote-progress.md";
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const progress: SyncProgress[] = [];
  const engine = makeEngine(makeVault(files, calls), undefined, (event) => progress.push(event));
  const remote = makeYjsTextDoc("remote content");
  const updateBase64 = Buffer.from(Y.encodeStateAsUpdate(remote.doc)).toString("base64");
  remote.doc.destroy();
  const privateEngine = engine as unknown as {
    scanComplete: boolean;
    startupPathsReady: boolean;
    fileInboxInitialized: boolean;
    settingInboxInitialized: boolean;
    fileInboxPageSaturated: boolean;
    loadPendingInboxCount(): Promise<number>;
    enqueuePendingFileRows(rows: ReadonlyArray<Record<string, unknown>>): void;
    handleHistoryQuietTick(): Promise<void>;
  };
  privateEngine.scanComplete = true;
  privateEngine.startupPathsReady = true;
  privateEngine.fileInboxInitialized = true;
  privateEngine.settingInboxInitialized = true;
  privateEngine.fileInboxPageSaturated = true;
  privateEngine.loadPendingInboxCount = async () => 1200;

  privateEngine.enqueuePendingFileRows(
    Array.from({ length: 6 }, (_, index) => ({
      id: `remote-${index}`,
      path,
      updateBase64,
      type: null,
      createdAt: `2026-06-23T00:00:0${index}.000Z`,
      sourceVersion: `2026-06-23T00:00:0${index}.000Z`,
    })),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  await privateEngine.handleHistoryQuietTick();
  await privateEngine.handleHistoryQuietTick();

  assert.ok(
    progress.some(
      (event) => event.status === "syncing" && event.current === 0 && event.total === 1200,
    ),
  );
  assert.ok(
    progress.some(
      (event) => event.status === "syncing" && event.current === 6 && event.total === 1200,
    ),
  );
  assert.equal(progress.at(-1)?.status, "caught-up");
});

test("small inbox catch-ups use page lengths without a full count query", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  const privateEngine = engine as unknown as {
    fileInboxInitialized: boolean;
    settingInboxInitialized: boolean;
    fileInboxPageSaturated: boolean;
    settingInboxPageSaturated: boolean;
    inboxProgressDiscovered: number;
    inboxProgressTotal: number | null;
    loadPendingInboxCount(): Promise<number>;
    ensureInboxProgressTotal(): Promise<void>;
  };
  privateEngine.fileInboxInitialized = true;
  privateEngine.settingInboxInitialized = true;
  privateEngine.fileInboxPageSaturated = false;
  privateEngine.settingInboxPageSaturated = false;
  privateEngine.inboxProgressDiscovered = 7;
  privateEngine.loadPendingInboxCount = async () => {
    throw new Error("small catch-ups must not count full history");
  };

  await privateEngine.ensureInboxProgressTotal();

  assert.equal(privateEngine.inboxProgressTotal, 7);
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
  assert.equal(persists, 0);
});

test("interrupted remote file application resumes without an outgoing echo", async () => {
  const path = "mobile-resume.md";
  const oldState = makeYjsTextDoc("old");
  const snapshotBase64 = Buffer.from(Y.encodeStateAsUpdate(oldState.doc)).toString("base64");
  const beforeRemote = Y.encodeStateVector(oldState.doc);
  oldState.doc.transact(() => {
    oldState.text.delete(0, oldState.text.length);
    oldState.text.insert(0, "remote");
  });
  const updateBase64 = Buffer.from(Y.encodeStateAsUpdate(oldState.doc, beforeRemote)).toString("base64");
  oldState.doc.destroy();

  const files = new Map([[path, "remote"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const outgoing: Record<string, unknown>[] = [];
  let persists = 0;
  const engine = makeEngine(makeVault(files, calls), async () => {
    persists++;
  });
  const privateEngine = engine as unknown as {
    states: Map<string, { doc: Y.Doc }>;
    evolu: {
      upsert(
        table: string,
        row: Record<string, unknown>,
        options?: { onComplete?: () => void },
      ): { ok: true };
    };
    loadLocalSnapshot(path: string): Promise<string | null>;
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
  privateEngine.loadLocalSnapshot = async () => snapshotBase64;
  privateEngine.evolu.upsert = (table, row, options) => {
    if (table === "fileUpdate") outgoing.push(row);
    options?.onComplete?.();
    return { ok: true };
  };

  const applied = await privateEngine.processPendingFilePath(path, [
    {
      id: "remote-interrupted",
      path,
      updateBase64,
      type: null,
      createdAt: "2026-06-23T10:00:00.000Z",
      sourceVersion: "2026-06-23T10:00:00.000Z",
    },
  ]);

  assert.equal(applied, true);
  assert.deepEqual(outgoing, []);
  assert.equal(files.get(path), "remote");
  assert.equal(persists, 0);
  privateEngine.states.get(path)?.doc.destroy();
});

test("incremental file path stages processed marker after snapshot", async () => {
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
  assert.equal(events.includes("persist"), false);
});

test("incremental inbox checkpoints 50 paths with two database persists", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const events: string[] = [];
  const progress: number[] = [];
  let savedPaths = 0;
  const journalStore: ApplyJournalStore = {
    async load() {
      return null;
    },
    async save(journal) {
      savedPaths = journal.entries.length;
      events.push("journal");
    },
    async clear() {
      events.push("clear");
    },
  };
  const engine = makeEngine(
    makeVault(files, calls),
    async () => {
      events.push("persist");
    },
    (event) => {
      if (event.status === "syncing" && event.current !== undefined) progress.push(event.current);
    },
    journalStore,
  );
  const privateEngine = engine as unknown as {
    scanComplete: boolean;
    fileInboxInitialized: boolean;
    settingInboxInitialized: boolean;
    inboxProgressDiscovered: number;
    inboxProgressTotal: number | null;
    pendingFileInbox: Map<string, {
      id: string;
      path: string;
      updateBase64: string;
      type: string | null;
      createdAt: string;
      sourceVersion: string;
    }>;
    processPendingFilePath(path: string, rows: unknown[]): Promise<boolean>;
    runIncrementalInbox(): Promise<void>;
  };
  privateEngine.scanComplete = true;
  privateEngine.fileInboxInitialized = true;
  privateEngine.settingInboxInitialized = true;
  privateEngine.inboxProgressDiscovered = 50;
  privateEngine.inboxProgressTotal = 50;
  for (let index = 0; index < 50; index++) {
    const row = {
      id: `row-${index}`,
      path: `notes/${index}.md`,
      updateBase64: "update",
      type: null,
      createdAt: "2026-06-23T10:00:00.000Z",
      sourceVersion: "2026-06-23T10:00:00.000Z",
    };
    privateEngine.pendingFileInbox.set(`${row.id}:${row.sourceVersion}`, row);
  }
  privateEngine.processPendingFilePath = async () => {
    events.push("apply");
    return true;
  };

  await privateEngine.runIncrementalInbox();

  assert.equal(savedPaths, 50);
  assert.equal(events.filter((event) => event === "persist").length, 2);
  assert.equal(events.filter((event) => event === "apply").length, 50);
  assert.ok(events.indexOf("persist") < events.indexOf("journal"));
  assert.ok(events.lastIndexOf("persist") < events.indexOf("clear"));
  assert.equal(privateEngine.pendingFileInbox.size, 0);
  assert.deepEqual([...new Set(progress)], Array.from({ length: 51 }, (_, index) => index));
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
});

test("startup recovers a durable apply journal before clearing it", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const events: string[] = [];
  const journal = {
    version: 1 as const,
    entries: [{
      kind: "file" as const,
      path: "recovery.md",
      rows: [{
        id: "recovery-row",
        path: "recovery.md",
        updateBase64: "update",
        type: null,
        createdAt: "2026-06-23T10:00:00.000Z",
        sourceVersion: "2026-06-23T10:00:00.000Z",
      }],
    }],
  };
  const engine = makeEngine(
    makeVault(files, calls),
    async () => {
      events.push("persist");
    },
    undefined,
    {
      async load() {
        return journal;
      },
      async save() {
        throw new Error("recovery must not replace the existing journal");
      },
      async clear() {
        events.push("clear");
      },
    },
  );
  const privateEngine = engine as unknown as {
    processPendingFilePath(path: string, rows: unknown[]): Promise<boolean>;
    recoverApplyJournal(): Promise<void>;
  };
  privateEngine.processPendingFilePath = async () => {
    events.push("apply");
    return true;
  };

  await privateEngine.recoverApplyJournal();

  assert.deepEqual(events, ["apply", "persist", "clear"]);
});

test("failed final checkpoint keeps journal and pending rows", async () => {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  let persists = 0;
  let clears = 0;
  const engine = makeEngine(
    makeVault(files, calls),
    async () => {
      persists++;
      if (persists === 2) throw new Error("disk full");
    },
    undefined,
    {
      async load() {
        return null;
      },
      async save() {},
      async clear() {
        clears++;
      },
    },
  );
  const privateEngine = engine as unknown as {
    scanComplete: boolean;
    pendingFileInbox: Map<string, {
      id: string;
      path: string;
      updateBase64: string;
      type: string | null;
      createdAt: string;
      sourceVersion: string;
    }>;
    processPendingFilePath(path: string, rows: unknown[]): Promise<boolean>;
    runIncrementalInbox(): Promise<void>;
  };
  privateEngine.scanComplete = true;
  const row = {
    id: "pending-after-failure",
    path: "pending.md",
    updateBase64: "update",
    type: null,
    createdAt: "2026-06-23T10:00:00.000Z",
    sourceVersion: "2026-06-23T10:00:00.000Z",
  };
  privateEngine.pendingFileInbox.set(`${row.id}:${row.sourceVersion}`, row);
  privateEngine.processPendingFilePath = async () => true;

  await privateEngine.runIncrementalInbox();

  assert.equal(persists, 2);
  assert.equal(clears, 0);
  assert.equal(privateEngine.pendingFileInbox.size, 1);
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

function makeJournalBatchFixture(count = 3) {
  const files = new Map<string, string>();
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const vault = makeVault(files, calls);
  const snapshots = new Map<string, string>();
  const markers = new Map<string, Record<string, unknown>>();
  const outgoing: unknown[] = [];
  const mutationBatches: string[][] = [];
  let journal: any = null;
  let persists = 0, clears = 0;
  let failWrite = "", failMarker = false, failFinalPersist = false;
  const originalWrite = vault.writeText;
  vault.writeText = async (path, content) => {
    if (path === failWrite) throw new Error("synthetic vault write failure");
    await originalWrite(path, content);
  };
  const engine = makeEngine(vault, async () => {
    persists++;
    if (failFinalPersist && persists === 2) throw new Error("synthetic checkpoint failure");
  }, undefined, {
    async load() { return journal; },
    async save(next) { journal = next; },
    async clear() { clears++; journal = null; },
  });
  // This fixture exercises the real file/Yjs/journal paths, with a small
  // microtask mutation queue matching the batching contract of Evolu 7.
  const e = engine as any;
  const pending: Array<{ table: string; row: any; options?: { onComplete?: () => void } }> = [];
  e.evolu.upsert = (table: string, row: any, options?: { onComplete?: () => void }) => {
    if (failMarker && table.startsWith("_processed")) return { ok: false, error: "synthetic marker failure" };
    pending.push({ table, row, options });
    if (pending.length === 1) queueMicrotask(() => {
      const batch = pending.splice(0);
      mutationBatches.push(batch.map((item) => item.table));
      for (const item of batch) {
        if (item.table === "_fileSnapshot") snapshots.set(item.row.path, item.row.snapshotBase64);
        if (item.table.startsWith("_processed")) markers.set(item.row.id, item.row);
        if (item.table === "fileUpdate") outgoing.push(item.row);
      }
      for (const item of batch) item.options?.onComplete?.();
    });
    return { ok: true };
  };
  e.loadLocalSnapshot = async (path: string) => {
    const snapshot = snapshots.get(path);
    return snapshot === "DELETED" ? null : snapshot ?? null;
  };
  e.loadLatestFileDelete = async () => null;
  e.scanComplete = true;
  e.fileInboxInitialized = e.settingInboxInitialized = true;
  e.inboxProgressTotal = count;
  for (let i = 0; i < count; i++) {
    const state = makeYjsTextDoc(`remote ${i}`);
    const row = {
      id: `batch-${i}`, path: `batch/${i}.md`, type: null,
      updateBase64: Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString("base64"),
      createdAt: "2026-11-27T10:00:00.000Z", sourceVersion: "2026-11-27T10:00:00.000Z",
    };
    state.doc.destroy();
    e.pendingFileInbox.set(`${row.id}:${row.sourceVersion}`, row);
  }
  return {
    e, files, vault, snapshots, markers, outgoing, mutationBatches,
    get journal() { return journal; }, get persists() { return persists; }, get clears() { return clears; },
    failWrite(path: string) { failWrite = path; },
    failMarker(value: boolean) { failMarker = value; },
    failFinalPersist(value: boolean) { failFinalPersist = value; },
    destroy() { for (const state of e.states.values()) state.doc.destroy(); },
  };
}

test("journal batches markers after all files and snapshots, with one marker mutation group", async () => {
  const h = makeJournalBatchFixture(50);
  const upsert = h.e.evolu.upsert;
  h.e.evolu.upsert = (table: string, row: any, options: any) => {
    if (table === "_processedFileUpdate") {
      assert.equal(h.files.size, 50);
      assert.equal(h.snapshots.size, 50);
    }
    return upsert(table, row, options);
  };
  try {
    await h.e.runIncrementalInbox();
    const batches = h.mutationBatches.filter((batch) => batch.includes("_processedFileUpdate"));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].filter((table) => table === "_processedFileUpdate").length, 50);
    assert.equal(h.markers.size, 50);
    assert.equal(h.persists, 2); assert.equal(h.clears, 1);
    assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("mid-journal file failure leaves markers uncommitted and replay converges without echo", async () => {
  const h = makeJournalBatchFixture();
  try {
    h.failWrite("batch/1.md");
    await h.e.runIncrementalInbox();
    assert.equal(h.files.get("batch/0.md"), "remote 0");
    assert.equal(h.markers.size, 0);
    assert.equal(h.clears, 0); assert.ok(h.journal);
    assert.equal(h.e.pendingFileInbox.size, 3);
    h.failWrite("");
    await h.e.runIncrementalInbox();
    assert.deepEqual([...h.files.values()], ["remote 0", "remote 1", "remote 2"]);
    assert.equal(h.markers.size, 3); assert.equal(h.clears, 1);
    assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("marker acknowledgements gate final persistence and journal retirement", async () => {
  const h = makeJournalBatchFixture();
  const upsert = h.e.evolu.upsert;
  const acknowledgements: Array<() => void> = [];
  h.e.evolu.upsert = (table: string, row: any, options: any) => upsert(table, row,
    table.startsWith("_processed") ? { onComplete: () => acknowledgements.push(options.onComplete) } : options);
  try {
    const run = h.e.runIncrementalInbox();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(acknowledgements.length, 3);
    assert.equal(h.persists, 1); assert.equal(h.clears, 0); assert.ok(h.journal);
    for (const acknowledge of acknowledgements) acknowledge();
    await run;
    assert.equal(h.persists, 2); assert.equal(h.clears, 1);
  } finally { h.destroy(); }
});

test("marker failure retains journal and a retry completes without outgoing changes", async () => {
  const h = makeJournalBatchFixture();
  try {
    h.failMarker(true); await h.e.runIncrementalInbox();
    assert.equal(h.persists, 1); assert.equal(h.clears, 0); assert.ok(h.journal);
    h.failMarker(false); await h.e.runIncrementalInbox();
    assert.equal(h.markers.size, 3); assert.equal(h.clears, 1);
    assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("batched markers do not retire journal after a failed final save", async () => {
  const h = makeJournalBatchFixture();
  try {
    h.failFinalPersist(true); await h.e.runIncrementalInbox();
    assert.equal(h.markers.size, 3);
    assert.equal(h.clears, 0); assert.ok(h.journal);
    assert.equal(h.e.pendingFileInbox.size, 3);
    h.failFinalPersist(false); await h.e.runIncrementalInbox();
    assert.equal(h.markers.size, 3); assert.equal(h.clears, 1);
    assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("failed remote setting application cannot publish batch markers", async () => {
  const h = makeJournalBatchFixture(0);
  h.e.localSyncConfig = { ...h.e.localSyncConfig, syncObsidianSettings: true };
  h.e.loadSettingSnapshot = async () => null;
  const row = {
    id: "setting-failure", path: ".obsidian/app.json", type: null,
    contentBase64: Buffer.from("{}").toString("base64"), contentHash: "synthetic",
    encoding: "raw", createdAt: "2026-11-27T10:00:00.000Z", sourceVersion: "2026-11-27T10:00:00.000Z",
  };
  h.e.loadLatestSettingUpdateForPath = async () => row;
  h.e.pendingSettingInbox.set(`${row.id}:${row.sourceVersion}`, row);
  h.failWrite(row.path);
  try {
    await h.e.runIncrementalInbox();
    assert.equal(h.markers.size, 0); assert.equal(h.clears, 0);
    assert.ok(h.journal); assert.equal(h.e.pendingSettingInbox.size, 1);
    h.failWrite(""); await h.e.runIncrementalInbox();
    assert.equal(h.files.get(row.path), "{}");
    assert.equal(h.markers.size, 1); assert.equal(h.clears, 1);
  } finally { h.destroy(); }
});

test("a newer source version arriving during a journal remains pending for the next checkpoint", async () => {
  const h = makeJournalBatchFixture(1);
  const first = [...h.e.pendingFileInbox.values()][0] as any;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(first.updateBase64, "base64"));
  const text = doc.getText("content");
  text.delete(0, text.length); text.insert(0, "newer remote");
  const newer = { ...first, sourceVersion: "2026-11-27T10:01:00.000Z", updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") };
  doc.destroy();
  const write = h.vault.writeText;
  let delivered = false;
  h.vault.writeText = async (path, content) => {
    await write(path, content);
    if (!delivered) {
      delivered = true;
      h.e.pendingFileInbox.set(`${newer.id}:${newer.sourceVersion}`, newer);
    }
  };
  try {
    await h.e.runIncrementalInbox();
    assert.equal(h.files.get(first.path), "newer remote");
    assert.deepEqual([...h.markers.values()].map((row) => row.sourceVersion), [first.sourceVersion, newer.sourceVersion]);
    assert.equal(h.e.pendingFileInbox.size, 0);
    assert.equal(h.persists, 4); assert.equal(h.clears, 2);
    assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("successful remote delete replays safely after a later path interrupts the journal", async () => {
  const h = makeJournalBatchFixture(2);
  const [first] = [...h.e.pendingFileInbox.values()] as any[];
  first.type = "delete";
  const old = makeYjsTextDoc("old content");
  h.files.set(first.path, "old content");
  h.snapshots.set(first.path, Buffer.from(Y.encodeStateAsUpdate(old.doc)).toString("base64"));
  old.doc.destroy();
  h.e.loadFileUpdateRowsForPath = async () => [first];
  try {
    h.failWrite("batch/1.md"); await h.e.runIncrementalInbox();
    assert.equal(h.files.has(first.path), false);
    assert.equal(h.snapshots.get(first.path), "DELETED");
    assert.equal(h.markers.size, 0); assert.ok(h.journal);
    h.failWrite(""); await h.e.runIncrementalInbox();
    assert.equal(h.files.has(first.path), false);
    assert.equal(h.files.get("batch/1.md"), "remote 1");
    assert.equal(h.markers.size, 2); assert.equal(h.clears, 1);
    assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("large journal marker groups remain bounded to 250 upserts per mutation chunk", async () => {
  const h = makeJournalBatchFixture(0);
  h.e.inboxProgressTotal = 501;
  for (let i = 0; i < 501; i++) {
    const row = {
      id: `ignored-${i}`, path: "excluded.bin", updateBase64: "unused", type: null,
      createdAt: "2026-11-27T10:00:00.000Z", sourceVersion: "2026-11-27T10:00:00.000Z",
    };
    h.e.pendingFileInbox.set(`${row.id}:${row.sourceVersion}`, row);
  }
  try {
    await h.e.runIncrementalInbox();
    const sizes = h.mutationBatches.filter((batch) => batch.includes("_processedFileUpdate")).map((batch) => batch.length);
    assert.deepEqual(sizes, [250, 250, 1]);
    assert.equal(h.markers.size, 501); assert.equal(h.persists, 2);
    assert.equal(h.files.size, 0);
  } finally { h.destroy(); }
});

function makeSubscribedJournalFixture(count = 3) {
  const h = makeJournalBatchFixture(count);
  const remote = new Map([...h.e.pendingFileInbox.values()].map((row: any) => [row.id, row]));
  const settings = new Map<string, any>();
  const listeners = new Map<string, Set<() => void>>();
  const retired: Array<() => void> = [];
  const rows = new Map<string, any[]>();
  const loads: string[] = [], subscribedMutations: string[] = [];
  let failLoad = false;
  h.e.pendingFileInbox.clear();
  h.e.localSyncConfig = { ...h.e.localSyncConfig, syncObsidianSettings: true };
  h.e.createPendingFileUpdateQuery = () => "files";
  h.e.createPendingSettingUpdateQuery = () => "settings";
  h.e.createPendingFileUpdateCountQuery = () => "file-count";
  h.e.createPendingSettingUpdateCountQuery = () => "setting-count";
  const unprocessed = (source: Map<string, any>) => [...source.values()].filter((row) =>
    ![...h.markers.values()].some((marker) => marker.sourceId === row.id && marker.sourceVersion === row.sourceVersion));
  h.e.evolu.subscribeQuery = (query: string) => (listener: () => void) => {
    const group = listeners.get(query) ?? new Set(); listeners.set(query, group); group.add(listener);
    return () => { group.delete(listener); retired.push(listener); };
  };
  h.e.evolu.getQueryRows = (query: string) => rows.get(query) ?? [];
  h.e.evolu.loadQuery = async (query: string) => {
    if (query === "file-count" || query === "setting-count") {
      loads.push(query);
      return [{ count: unprocessed(query === "file-count" ? remote : settings).length }];
    }
    if (query !== "files" && query !== "settings") return [];
    loads.push(query);
    if (failLoad) { failLoad = false; throw new Error("synthetic inbox reload failure"); }
    const result = unprocessed(query === "files" ? remote : settings).slice(0, h.e.config.historyBatchSize);
    rows.set(query, result);
    return result;
  };
  const upsert = h.e.evolu.upsert;
  h.e.evolu.upsert = (table: string, row: any, options: any) => {
    if ([...listeners.values()].some((group) => group.size)) subscribedMutations.push(table);
    return upsert(table, row, options);
  };
  const originalDestroy = h.destroy;
  return {
    ...h, remote, settings, loads, retired, subscribedMutations,
    // Preserve fixture getters rather than spreading their current values.
    get journal() { return h.journal; }, get persists() { return h.persists; }, get clears() { return h.clears; },
    listenerCount: () => [...listeners.values()].reduce((sum, group) => sum + group.size, 0),
    failReload() { failLoad = true; },
    async start() {
      h.e.isActive = false;
      await h.e.startInboxSubscriptions();
      h.e.isActive = true;
    },
    destroy() { h.e.stopInboxSubscriptions(); originalDestroy(); },
  };
}

test("journal application unsubscribes inboxes and awaits one fresh page load per boundary", async () => {
  const h = makeSubscribedJournalFixture(30);
  try {
    await h.start();
    assert.equal(h.listenerCount(), 2);
    await h.e.runIncrementalInbox();
    assert.equal(h.files.size, 30); assert.equal(h.markers.size, 30);
    assert.deepEqual(h.subscribedMutations, []);
    assert.deepEqual(h.loads, ["files", "settings", "files", "settings"]);
    assert.equal(h.listenerCount(), 2); assert.equal(h.e.inboxRefreshNeeded, false);
    assert.equal(h.persists, 2); assert.equal(h.clears, 1);
  } finally { h.destroy(); }
});

test("remote changes arriving while inboxes are detached are discovered at the boundary", async () => {
  const h = makeSubscribedJournalFixture(1);
  const first = [...h.remote.values()][0] as any;
  const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(first.updateBase64, "base64"));
  doc.getText("content").insert(doc.getText("content").length, " later");
  const newer = { ...first, sourceVersion: "2026-11-27T11:00:00.000Z", updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") };
  doc.destroy();
  const write = h.vault.writeText;
  let delivered = false;
  h.vault.writeText = async (path, content) => {
    await write(path, content);
    if (!delivered) {
      delivered = true;
      assert.equal(h.listenerCount(), 0);
      h.remote.set(newer.id, newer);
      h.settings.set("late-setting", {
        id: "late-setting", path: ".obsidian/app.json", contentBase64: Buffer.from("{}").toString("base64"),
        contentHash: "synthetic", encoding: "raw", type: null,
        createdAt: "2026-11-27T11:00:00.000Z", sourceVersion: "2026-11-27T11:00:00.000Z",
      });
      h.e.loadLatestSettingUpdateForPath = async () => h.settings.get("late-setting");
    }
  };
  try {
    await h.start(); await h.e.runIncrementalInbox();
    assert.equal(h.files.get(first.path), "remote 0 later");
    assert.equal(h.files.get(".obsidian/app.json"), "{}");
    assert.equal(h.markers.size, 3); assert.equal(h.clears, 2);
    assert.equal(h.listenerCount(), 2); assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

for (const failure of ["file", "marker", "checkpoint", "journal"] as const) {
  test(`subscriptions recover after a ${failure} failure without retiring pending work`, async () => {
    const h = makeSubscribedJournalFixture();
    const save = h.e.applyJournalStore.save;
    try {
      await h.start();
      if (failure === "file") h.failWrite("batch/1.md");
      if (failure === "marker") h.failMarker(true);
      if (failure === "checkpoint") h.failFinalPersist(true);
      if (failure === "journal") h.e.applyJournalStore.save = async () => { throw new Error("journal write failed"); };
      await h.e.runIncrementalInbox();
      assert.equal(h.listenerCount(), 2); assert.equal(h.e.inboxSubscriptionsSuspended, false);
      assert.equal(h.clears, 0); assert.equal(h.e.pendingFileInbox.size, 3);
      h.failWrite(""); h.failMarker(false); h.failFinalPersist(false); h.e.applyJournalStore.save = save;
      await h.e.runIncrementalInbox();
      assert.equal(h.files.size, 3); assert.equal(h.markers.size, 3);
      assert.equal(h.clears, 1); assert.deepEqual(h.outgoing, []);
    } finally { h.destroy(); }
  });
}

test("a failed boundary reload blocks caught-up and is retried even with an empty queue", async () => {
  const h = makeSubscribedJournalFixture(1);
  const write = h.vault.writeText;
  h.vault.writeText = async (path, content) => { await write(path, content); h.failReload(); };
  const statuses: string[] = [];
  h.e.reportSyncProgress = (p: SyncProgress) => statuses.push(p.status);
  try {
    await h.start(); await h.e.runIncrementalInbox();
    assert.equal(h.e.pendingFileInbox.size, 0); assert.equal(h.e.inboxRefreshNeeded, true);
    await h.e.handleHistoryQuietTick(); await h.e.handleHistoryQuietTick();
    assert.equal(statuses.includes("caught-up"), false);
    await h.e.runIncrementalInbox();
    assert.equal(h.e.inboxRefreshNeeded, false); assert.equal(h.listenerCount(), 2);
    assert.equal(h.files.size, 1); assert.equal(h.clears, 1);
  } finally { h.destroy(); }
});

test("stopping during a journal cannot resurrect subscriptions or consume retired callbacks", async () => {
  const h = makeSubscribedJournalFixture(1);
  const write = h.vault.writeText;
  let stopped: Promise<void> | undefined;
  h.vault.writeText = async (path, content) => { await write(path, content); stopped = h.e.stop(false); };
  try {
    await h.start(); await h.e.runIncrementalInbox(); await stopped;
    assert.equal(h.listenerCount(), 0); assert.equal(h.e.inboxSubscriptionsEnabled, false);
    for (const callback of h.retired) callback();
    assert.equal(h.e.pendingFileInbox.size, 0); assert.equal(h.files.size, 1);
  } finally { h.destroy(); }
});

test("configuration changes during a journal defer subscription restart to its boundary", async () => {
  const h = makeSubscribedJournalFixture(1);
  const write = h.vault.writeText;
  h.vault.writeText = async (path, content) => {
    await write(path, content);
    await h.e.updateConfig({ ...h.e.config, historyBatchSize: 1000 });
    assert.equal(h.listenerCount(), 0);
  };
  try {
    await h.start(); await h.e.runIncrementalInbox();
    assert.equal(h.listenerCount(), 2); assert.equal(h.e.config.historyBatchSize, 1000);
  } finally { h.e.stopPollingTimer(); h.destroy(); }
});

test("late loads and retired listeners cannot requeue rows after subscription replacement", async () => {
  const h = makeSubscribedJournalFixture(1);
  const oldRows = [...h.remote.values()];
  const load = h.e.evolu.loadQuery;
  let resolveOld!: (rows: any[]) => void;
  let first = true;
  h.e.evolu.loadQuery = (query: string) => {
    if (query === "files" && first) {
      first = false;
      return new Promise<any[]>((resolve) => { resolveOld = resolve; });
    }
    return load(query);
  };
  try {
    h.e.isActive = false;
    const oldLoad = h.e.startInboxSubscriptions();
    h.e.stopInboxSubscriptions(); h.remote.clear();
    await h.e.startInboxSubscriptions();
    resolveOld(oldRows); await oldLoad;
    h.e.evolu.getQueryRows = () => oldRows;
    for (const callback of h.retired) callback();
    assert.equal(h.e.pendingFileInbox.size, 0);
    assert.equal(h.listenerCount(), 2); assert.equal(h.e.inboxRefreshNeeded, false);
  } finally { h.destroy(); }
});

test("a rejected initial load is retried without requiring another incoming mutation", async () => {
  const h = makeSubscribedJournalFixture(1);
  try {
    h.failReload();
    await assert.rejects(h.start(), /inbox reload failure/);
    h.e.isActive = true;
    await h.e.runIncrementalInbox();
    assert.equal(h.files.size, 1); assert.equal(h.clears, 1);
    assert.equal(h.e.inboxRefreshNeeded, false); assert.equal(h.listenerCount(), 2);
  } finally { h.destroy(); }
});

test("boundary refresh replaces a short initial total with the full newly arrived backlog", async () => {
  const h = makeSubscribedJournalFixture(1);
  h.e.config.historyBatchSize = 3;
  const write = h.vault.writeText;
  let delivered = false;
  h.vault.writeText = async (path, content) => {
    await write(path, content);
    if (!delivered) {
      delivered = true;
      const state = makeYjsTextDoc("later history");
      const updateBase64 = Buffer.from(Y.encodeStateAsUpdate(state.doc)).toString("base64"); state.doc.destroy();
      for (let i = 0; i < 4; i++) h.remote.set(`later-${i}`, {
        id: `later-${i}`, path: `later/${i}.md`, updateBase64, type: null,
        createdAt: "2026-11-27T12:00:00.000Z", sourceVersion: "2026-11-27T12:00:00.000Z",
      });
      h.e.isActive = false;
    }
  };
  try {
    await h.start(); assert.equal(h.e.inboxProgressTotal, 1);
    await h.e.runIncrementalInbox();
    assert.equal(h.e.inboxProgressApplied, 1);
    assert.equal(h.e.pendingFileInbox.size, 3, "only the first page is loaded");
    assert.equal(h.e.inboxProgressTotal, 5, "total includes saved work plus all pending rows, including unseen pages");
    assert.deepEqual(h.loads.filter((q) => q.endsWith("-count")), ["file-count", "setting-count"]);
    h.e.isActive = true; await h.e.runIncrementalInbox();
    assert.equal(h.files.size, 5); assert.equal(h.e.inboxProgressApplied, 5);
    assert.equal(h.e.inboxProgressTotal, 5); assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("failed full counts hide ETA and a later refresh can recover without changing inbox work", async () => {
  const h = makeSubscribedJournalFixture(1);
  const progress: any[] = [];
  h.e.reportSyncProgress = (p: SyncProgress) => progress.push(p);
  try {
    h.e.fileInboxInitialized = h.e.settingInboxInitialized = true;
    h.e.fileInboxPageSaturated = true;
    h.e.inboxProgressDiscovered = 30; h.e.inboxProgressApplied = 25;
    h.e.syncEta.complete(h.e.syncEta.begin(0), 100, 60_000);
    h.e.syncEta.complete(h.e.syncEta.begin(60_000), 100, 120_000);
    h.e.loadPendingInboxCount = async () => { throw new Error("count failed"); };
    await h.e.ensureInboxProgressTotal(true);
    assert.equal(h.e.inboxProgressTotal, null); assert.equal(progress.at(-1).etaSeconds, undefined);
    h.e.loadPendingInboxCount = async () => 100;
    await h.e.ensureInboxProgressTotal(true);
    assert.equal(h.e.inboxProgressTotal, 125);
    assert.equal(progress.at(-1).etaSeconds, 60);
    assert.equal(h.e.pendingFileInbox.size, 0); assert.equal(h.clears, 0);
  } finally { h.destroy(); }
});

test("a retired pending-count result cannot overwrite the current generation's total", async () => {
  const h = makeSubscribedJournalFixture(1);
  let resolve!: (count: number) => void;
  try {
    h.e.fileInboxInitialized = h.e.settingInboxInitialized = true;
    h.e.fileInboxPageSaturated = true;
    h.e.loadPendingInboxCount = () => new Promise<number>((done) => { resolve = done; });
    const retired = h.e.ensureInboxProgressTotal(true);
    h.e.detachInboxSubscriptions();
    resolve(999); await retired;
    assert.equal(h.e.inboxProgressTotal, 1);
    h.e.loadPendingInboxCount = async () => 10;
    await h.e.ensureInboxProgressTotal(true);
    assert.equal(h.e.inboxProgressTotal, 10);
  } finally { h.destroy(); }
});

for (const paths of [100, 200]) {
  test(`${paths}-path checkpoint keeps the same two durability barriers and one journal`, async () => {
    const h = makeJournalBatchFixture(paths);
    h.e.config.inboxCheckpointBatchPaths = paths;
    try {
      await h.e.runIncrementalInbox();
      assert.equal(h.files.size, paths); assert.equal(h.markers.size, paths);
      assert.equal(h.persists, 2); assert.equal(h.clears, 1);
      const snapshotWrites = h.mutationBatches.flat().filter((table) => table === "_fileSnapshot").length;
      assert.equal(snapshotWrites, paths, "eviction must not resave acknowledged unchanged snapshots");
      assert.deepEqual(h.outgoing, []);
    } finally { h.destroy(); }
  });

  test(`${paths}-path interrupted checkpoint retries with no skipped rows or outgoing echoes`, async () => {
    const h = makeJournalBatchFixture(paths);
    h.e.config.inboxCheckpointBatchPaths = paths;
    try {
      h.failWrite(`batch/${paths - 1}.md`); await h.e.runIncrementalInbox();
      assert.equal(h.files.size, paths - 1); assert.equal(h.markers.size, 0);
      assert.equal(h.journal.entries.length, paths); assert.equal(h.clears, 0);
      h.failWrite(""); await h.e.runIncrementalInbox();
      assert.equal(h.files.size, paths); assert.equal(h.markers.size, paths);
      assert.equal(h.clears, 1); assert.deepEqual(h.outgoing, []);
    } finally { h.destroy(); }
  });
}

test("200-path cap applies a small queue immediately without waiting to fill the batch", async () => {
  const h = makeJournalBatchFixture(7);
  h.e.config.inboxCheckpointBatchPaths = 200;
  try {
    await h.e.runIncrementalInbox();
    assert.equal(h.files.size, 7); assert.equal(h.markers.size, 7);
    assert.equal(h.persists, 2); assert.equal(h.clears, 1);
    assert.equal(h.e.pendingFileInbox.size, 0);
    assert.deepEqual(h.outgoing, []);
  } finally { h.destroy(); }
});

test("inbox display is monotonic and includes newly discovered backlog", () => {
  const updates: Array<{ current?: number; total?: number }> = [];
  const engine = makeEngine(makeVault(new Map(), { writes: [], deletes: [] }), undefined, (p) => {
    if (p.status === "syncing") updates.push(p);
  }) as any;
  engine.inboxProgressDiscovered = 100; engine.inboxProgressTotal = 100;
  engine.reportInboxProgress(10); engine.reportInboxProgress(0); engine.reportInboxProgress(9);
  engine.inboxProgressDiscovered = 200; engine.reportInboxProgress(11);
  assert.deepEqual(updates.map((p) => p.current), [10, 10, 10, 11]);
  assert.equal(updates.at(-1)?.total, 200);
});

test("ETA only records a batch after its final save and journal retirement", async (t) => {
  const h = makeJournalBatchFixture();
  const recorded = t.mock.method(h.e.syncEta, "complete");
  try {
    h.failFinalPersist(true); await h.e.runIncrementalInbox();
    assert.equal(recorded.mock.callCount(), 0);
    h.failFinalPersist(false); await h.e.runIncrementalInbox();
    assert.equal(recorded.mock.callCount(), 1); assert.equal(h.clears, 1);
  } finally { h.destroy(); }
});

test("a loaded hidden app continues applying a recoverable journal without training ETA", async () => {
  const h = makeJournalBatchFixture();
  try {
    h.e.setAppVisible(false);
    assert.equal(h.e.isActive, true);
    await h.e.runIncrementalInbox();
    assert.equal(h.files.size, 3); assert.equal(h.markers.size, 3);
    assert.equal(h.clears, 1); assert.equal(h.e.syncEta.estimateSeconds(1000), undefined);
  } finally { h.destroy(); }
});

test("focus loss while still visible preserves sync and an existing ETA sample", (t) => {
  const h = makeJournalBatchFixture(0);
  try {
    // Isolate focus handling from the independent caught-up transition, which
    // correctly clears an old restore's ETA when there is no pending work.
    t.mock.method(h.e, "handleHistoryQuietTick", async () => {});
    h.e.syncEta.complete(h.e.syncEta.begin(0), 100, 60_000);
    h.e.syncEta.complete(h.e.syncEta.begin(60_000), 100, 120_000);
    h.e.setAppVisible(true); h.e.setAppVisible(true);
    assert.equal(h.e.isActive, true);
    assert.equal(h.e.syncEta.estimateSeconds(1000), 600);
  } finally { h.destroy(); }
});

function makeSnapshotCacheFixture() {
  const path = "cached.md";
  const files = new Map([[path, "unchanged text"]]);
  const engine = makeEngine(makeVault(files, { writes: [], deletes: [] })) as any;
  const { doc, text } = makeYjsTextDoc("unchanged text");
  const state = engine.createFileStateFromDoc(path, doc, text, text.toString(), false);
  engine.states.set(path, state);
  const snapshots: any[] = [], outgoing: any[] = [], acknowledgements: Array<() => void> = [];
  let hold = false, fail = false;
  engine.evolu.upsert = (table: string, row: any, options?: { onComplete?: () => void }) => {
    if (table === "_fileSnapshot") {
      if (fail) { fail = false; return { ok: false, error: "synthetic snapshot failure" }; }
      snapshots.push(row);
      if (hold && options?.onComplete) acknowledgements.push(options.onComplete);
      else options?.onComplete?.();
    } else {
      if (table === "fileUpdate") outgoing.push(row);
      options?.onComplete?.();
    }
    return { ok: true };
  };
  return {
    engine, state, path, snapshots, outgoing, acknowledgements,
    hold(value: boolean) { hold = value; }, failNext() { fail = true; },
    destroy() { if (state.flushTimer) clearTimeout(state.flushTimer); doc.destroy(); },
  };
}

test("closing an acknowledged unchanged document skips the redundant snapshot", async () => {
  const h = makeSnapshotCacheFixture();
  try {
    await h.engine.saveLocalSnapshot(h.path, h.state);
    assert.equal(await h.engine.closeDoc(h.path), true);
    assert.equal(h.snapshots.length, 1);
  } finally { h.destroy(); }
});

test("equal text with changed Yjs history still flushes local edits and saves a new snapshot", async () => {
  const h = makeSnapshotCacheFixture();
  try {
    await h.engine.saveLocalSnapshot(h.path, h.state);
    h.state.doc.transact(() => { h.state.text.insert(0, "x"); h.state.text.delete(0, 1); });
    assert.equal(h.state.text.toString(), "unchanged text");
    assert.equal(await h.engine.closeDoc(h.path), true);
    assert.equal(h.snapshots.length, 2);
    assert.notEqual(h.snapshots[0].snapshotBase64, h.snapshots[1].snapshotBase64);
    assert.equal(h.outgoing.length, 1);
  } finally { h.destroy(); }
});

test("only the latest acknowledged snapshot permits skipping, including out-of-order callbacks", async () => {
  const h = makeSnapshotCacheFixture();
  try {
    h.hold(true);
    await h.engine.saveLocalSnapshot(h.path, h.state);
    await h.engine.saveLocalSnapshot(h.path, h.state, { skipIfUnchanged: true });
    assert.equal(h.snapshots.length, 2);
    h.acknowledgements[0]();
    await h.engine.saveLocalSnapshot(h.path, h.state, { skipIfUnchanged: true });
    assert.equal(h.snapshots.length, 3);
    h.acknowledgements[2](); h.acknowledgements[1]();
    await h.engine.saveLocalSnapshot(h.path, h.state, { skipIfUnchanged: true });
    assert.equal(h.snapshots.length, 3);
  } finally { h.destroy(); }
});

test("snapshot acknowledgement for an old path cannot suppress a renamed-path save", async () => {
  const h = makeSnapshotCacheFixture();
  try {
    await h.engine.saveLocalSnapshot(h.path, h.state);
    await h.engine.saveLocalSnapshot("renamed.md", h.state, { skipIfUnchanged: true });
    assert.deepEqual(h.snapshots.map((row) => row.path), [h.path, "renamed.md"]);
  } finally { h.destroy(); }
});

test("tombstone invalidates an old pending snapshot acknowledgement", async () => {
  const h = makeSnapshotCacheFixture();
  try {
    h.hold(true); await h.engine.saveLocalSnapshot(h.path, h.state);
    h.engine.tombstoneSnapshot(h.path); h.acknowledgements[0]();
    h.hold(false); await h.engine.saveLocalSnapshot(h.path, h.state, { skipIfUnchanged: true });
    assert.equal(h.snapshots.length, 3);
    assert.equal(h.snapshots[1].snapshotBase64, "DELETED");
    assert.notEqual(h.snapshots[2].snapshotBase64, "DELETED");
  } finally { h.destroy(); }
});

test("failed snapshot cannot become an acknowledged unchanged state", async () => {
  const h = makeSnapshotCacheFixture();
  try {
    h.failNext();
    await assert.rejects(h.engine.saveLocalSnapshot(h.path, h.state), /Failed to save/);
    await h.engine.saveLocalSnapshot(h.path, h.state, { skipIfUnchanged: true });
    assert.equal(h.snapshots.length, 1);
  } finally { h.destroy(); }
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

for (const scenario of [
  { name: "external edit", base: "before", remote: "before", vault: "after", merged: "after" },
  { name: "emptied file", base: "before", remote: "before", vault: "", merged: "" },
  {
    name: "concurrent remote edit",
    base: "Title\nBody\n",
    remote: "Remote title\nBody\n",
    vault: "Title\nEdited body\n",
    merged: "Remote title\nEdited body\n",
  },
]) {
  test(`periodic rescan reconciles cached document after ${scenario.name}`, async () => {
    const path = "notes/networking.md";
    const files = new Map([[path, scenario.vault]]);
    const calls = { writes: [] as string[], deletes: [] as string[] };
    const engine = makeEngine(makeVault(files, calls));
    const outgoing: Record<string, unknown>[] = [];
    const openDoc = makeYjsTextDoc(scenario.remote);
    const privateEngine = engine as unknown as {
      states: Map<string, { text: Y.Text; lastVaultText: string; pendingUpdates: Uint8Array[] }>;
      createFileStateFromDoc(path: string, doc: Y.Doc, text: Y.Text, lastVaultText: string, ignore: boolean): {
        text: Y.Text;
        lastVaultText: string;
        pendingUpdates: Uint8Array[];
      };
      loadLocalSnapshotRecord(path: string): Promise<{ snapshotBase64: string; contentHash: string }>;
      evolu: { upsert(table: string, row: Record<string, unknown>): void };
      closeDoc(path: string): Promise<boolean>;
    };
    privateEngine.loadLocalSnapshotRecord = async () => ({
      snapshotBase64: Buffer.from(Y.encodeStateAsUpdate(openDoc.doc)).toString("base64"),
      contentHash: "stale-snapshot-hash",
    });
    privateEngine.evolu.upsert = (table, row) => {
      if (table === "fileUpdate") outgoing.push(row);
    };
    // A missed remote-write watcher event must not suppress the external edit.
    const state = privateEngine.createFileStateFromDoc(path, openDoc.doc, openDoc.text, scenario.base, true);
    privateEngine.states.set(path, state);
    try {
      assert.equal(await engine.reconcileVaultFile(path, "Periodic vault rescan"), "loaded");
      assert.equal(state.text.toString(), scenario.merged);
      assert.equal(files.get(path), scenario.merged);
      assert.equal(state.lastVaultText, scenario.merged);
      assert.equal(state.pendingUpdates.length, 1);

      assert.equal(await engine.reconcileVaultFile(path, "Periodic vault rescan"), "unchanged");
      await engine.onVaultFileChanged(path);
      assert.equal(state.pendingUpdates.length, 1, "rescan and watcher must not duplicate the edit");
      await privateEngine.closeDoc(path);
      assert.equal(outgoing.length, 1);
      assert.equal(outgoing[0].path, path);
      assert.equal(outgoing[0].originDeviceId, "test-device");
    } finally {
      await privateEngine.closeDoc(path);
    }
  });
}

test("watcher preserves a real edit after a missed remote-write echo", async () => {
  const path = "notes/networking.md";
  const files = new Map([[path, "remote content plus local edit"]]);
  const engine = makeEngine(makeVault(files, { writes: [], deletes: [] }));
  const openDoc = makeYjsTextDoc("remote content");
  const privateEngine = engine as unknown as {
    states: Map<string, { text: Y.Text; pendingUpdates: Uint8Array[] }>;
    createFileStateFromDoc(path: string, doc: Y.Doc, text: Y.Text, lastVaultText: string, ignore: boolean): {
      text: Y.Text;
      pendingUpdates: Uint8Array[];
    };
    loadLocalSnapshot(path: string): Promise<string | null>;
    closeDoc(path: string): Promise<boolean>;
  };
  privateEngine.loadLocalSnapshot = async () => "existing-snapshot";
  const state = privateEngine.createFileStateFromDoc(path, openDoc.doc, openDoc.text, "remote content", true);
  privateEngine.states.set(path, state);
  try {
    await engine.onVaultFileChanged(path);
    assert.equal(state.text.toString(), files.get(path));
    assert.equal(state.pendingUpdates.length, 1);
    await engine.onVaultFileChanged(path);
    assert.equal(state.pendingUpdates.length, 1);
  } finally {
    await privateEngine.closeDoc(path);
  }
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

test("rename retargets pending and future outgoing updates to the new path", async () => {
  const oldPath = "notes/old.md";
  const newPath = "notes/new.md";
  const files = new Map([[newPath, "before"]]);
  const calls = { writes: [] as string[], deletes: [] as string[] };
  const engine = makeEngine(makeVault(files, calls));
  const openDoc = makeYjsTextDoc("before");
  const outgoing: Array<{ path: string; type: string | null }> = [];

  const privateEngine = engine as unknown as {
    states: Map<string, { path: string; doc: Y.Doc; text: Y.Text }>;
    evolu: { upsert(table: string, row: Record<string, unknown>): void };
    createFileStateFromDoc(
      path: string,
      doc: Y.Doc,
      text: Y.Text,
      lastVaultText: string,
      ignoreNextVaultModify: boolean,
    ): { path: string; doc: Y.Doc; text: Y.Text };
  };
  privateEngine.evolu.upsert = (table, row) => {
    if (table === "fileUpdate") {
      outgoing.push({
        path: row.path as string,
        type: (row.type as string | null) ?? null,
      });
    }
  };
  const state = privateEngine.createFileStateFromDoc(
    oldPath,
    openDoc.doc,
    openDoc.text,
    "before",
    false,
  );
  privateEngine.states.set(oldPath, state);

  await engine.onVaultFileRenamed(oldPath, newPath);
  state.text.insert(state.text.length, "!");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(state.path, newPath);
  assert.equal(privateEngine.states.has(oldPath), false);
  assert.equal(privateEngine.states.get(newPath), state);
  assert.equal(outgoing.some((row) => row.path === oldPath && row.type === null), false);
  assert.equal(outgoing.filter((row) => row.path === newPath && row.type === null).length, 2);
  state.doc.destroy();
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
