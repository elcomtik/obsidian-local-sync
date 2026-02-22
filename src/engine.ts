
import { TFile, Vault } from "obsidian";
import * as Y from "yjs";
import DiffMatchPatch from "diff-match-patch";
import type { Evolu, IdBytes, TimestampBytes } from "@evolu/common";
import { createIdFromString, idBytesToId } from "@evolu/common";
import type { Database } from "./schema";

/**
 * Logging levels (simple).
 * - off: nothing
 * - error: only errors
 * - warn: warnings + errors
 * - info: normal operational logs + warnings + errors
 */
export type LogLevel = "off" | "error" | "warn" | "info";

const levelRank: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
};

export type EngineConfig = {
  historyPollMs: number;      // how often we poll evolu_history
  historyBatchSize: number;   // max history rows per poll
  outgoingBatchMs: number;    // min time between sending updates
  maxOpenDocs: number;        // LRU limit
};

const dmp = new DiffMatchPatch();

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Better diff using diff-match-patch.
 * Converts oldText -> newText into inserts/deletes and applies to Yjs.
 */
function applyBetterDiffToYText(ytext: Y.Text, oldText: string, newText: string) {
  if (oldText === newText) return;

  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  let index = 0;
  for (const [op, text] of diffs) {
    if (!text) continue;

    if (op === DiffMatchPatch.DIFF_EQUAL) {
      index += text.length;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      ytext.delete(index, text.length);
    } else if (op === DiffMatchPatch.DIFF_INSERT) {
      ytext.insert(index, text);
      index += text.length;
    }
  }
}

type FileState = {
  doc: Y.Doc;
  text: Y.Text;

  // last text seen in vault file (for diffing)
  lastVaultText: string;

  // ignore one modify event to prevent loop (remote write -> vault modify)
  ignoreNextVaultModify: boolean;

  // outgoing update batching
  pendingUpdates: Uint8Array[];
  flushTimer: number | null;

  // LRU
  lastUsedMs: number;
};

export class YjsEvoluHistoryEngine {
  private vault: Vault;
  private evolu: Evolu<Database>;
  private deviceId: string;

  private config: EngineConfig;
  private logLevel: LogLevel;

  private states = new Map<string, FileState>();

  private pollTimer: number | null = null;
  private isPolling = false;

  // Only process remote history when Obsidian is active
  private isActive = true;

  constructor(args: {
    vault: Vault;
    evolu: Evolu<Database>;
    deviceId: string;
    config: EngineConfig;
    logLevel: LogLevel;
  }) {
    this.vault = args.vault;
    this.evolu = args.evolu;
    this.deviceId = args.deviceId;
    this.config = args.config;
    this.logLevel = args.logLevel;
  }

  // ---------- logging helpers ----------

  private logInfo(message: string, data?: unknown) {
    if (levelRank[this.logLevel] < levelRank.info) return;
    console.log("[obsidian-local-sync] INFO:", message, data ?? "");
  }

  private logWarn(message: string, data?: unknown) {
    if (levelRank[this.logLevel] < levelRank.warn) return;
    console.warn("[obsidian-local-sync] WARN:", message, data ?? "");
  }

  private logError(message: string, data?: unknown) {
    if (levelRank[this.logLevel] < levelRank.error) return;
    console.error("[obsidian-local-sync] ERROR:", message, data ?? "");
  }

  // ---------- lifecycle ----------

  async start() {
    try {
      await this.ensureHistoryCursorRow();
      this.startPollingTimer();
      this.logInfo("Engine started", this.config);
      if (this.isActive) await this.pollHistoryOnce();
    } catch (e) {
      this.logError("Engine start failed", e);
    }
  }

  stop() {
    try {
      this.stopPollingTimer();
      const paths = Array.from(this.states.keys());
      for (const p of paths) void this.closeDoc(p);
      this.states.clear();
      this.logInfo("Engine stopped");
    } catch (e) {
      this.logError("Engine stop failed", e);
    }
  }

  async updateConfig(newConfig: EngineConfig) {
    try {
      this.config = newConfig;
      this.stopPollingTimer();
      this.startPollingTimer();
      await this.enforceLruLimit();
      this.logInfo("Engine config updated", this.config);
    } catch (e) {
      this.logError("updateConfig failed", e);
    }
  }

  setLogLevel(level: LogLevel) {
    this.logLevel = level;
    this.logInfo("Log level set", level);
  }

  async setActive() {
    this.isActive = true;
    this.logInfo("App active");
    await this.pollHistoryOnce();
  }

  setInactive() {
    this.isActive = false;
    this.logInfo("App inactive");
  }

  // ---------- vault -> yjs ----------

  async onVaultFileModified(file: TFile) {
    if (!this.isTextFile(file)) return;

    const path = file.path;

    try {
      const newVaultText = await this.vault.read(file);
      const st = await this.getOrLoadFileState(path);
      this.touch(st);

      if (st.ignoreNextVaultModify) {
        st.ignoreNextVaultModify = false;
        st.lastVaultText = newVaultText;
        return;
      }

      st.doc.transact(() => {
        applyBetterDiffToYText(st.text, st.lastVaultText, newVaultText);
      });

      st.lastVaultText = newVaultText;
      // No per-keystroke logs; flush logs happen in flushOutgoingUpdates.
    } catch (e) {
      this.logError("onVaultFileModified failed", { path, error: e });
    }
  }

  // ---------- polling ----------

  private startPollingTimer() {
    this.pollTimer = window.setInterval(() => {
      if (this.isActive) void this.pollHistoryOnce();
    }, this.config.historyPollMs);
  }

  private stopPollingTimer() {
    if (this.pollTimer != null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollHistoryOnce() {
    if (!this.isActive) return;
    if (this.isPolling) return;

    this.isPolling = true;

    try {
      const cursor = await this.loadHistoryCursor();

      const q = this.evolu.createQuery((db) => {
        let qb = db
          .selectFrom("evolu_history")
          .select(["table", "id", "column", "timestamp"])
          .where("table", "==", "fileUpdate")
          .where("column", "==", "updateBase64");

        if (cursor != null) qb = qb.where("timestamp", ">", cursor);

        return qb.orderBy("timestamp", "asc").limit(this.config.historyBatchSize);
      });

      const rows = await this.evolu.loadQuery(q);

      // Log only if something happened.
      if (rows.length > 0) {
        this.logInfo("History poll fetched rows", { count: rows.length });
      }

      for (const h of rows) {
        const id = idBytesToId(h.id as unknown as IdBytes);
        await this.applyFileUpdateRowById(id);
      }

      if (rows.length > 0) {
        const lastTs = rows[rows.length - 1].timestamp as unknown as TimestampBytes;
        await this.saveHistoryCursor(lastTs);
      }
    } catch (e) {
      this.logError("pollHistoryOnce failed", e);
    } finally {
      this.isPolling = false;
    }
  }

  private async applyFileUpdateRowById(fileUpdateId: any) {
    try {
      const q = this.evolu.createQuery((db) =>
        db
          .selectFrom("fileUpdate")
          .select(["path", "updateBase64"])
          .where("id", "=", fileUpdateId)
          .where("isDeleted", "is", null)
          .limit(1),
      );

      const rows = await this.evolu.loadQuery(q);
      if (rows.length === 0) {
        this.logWarn("History referenced missing fileUpdate row", { fileUpdateId });
        return;
      }

      const { path, updateBase64 } = rows[0];
      if (!path || !updateBase64) {
        this.logWarn("fileUpdate row missing fields", { fileUpdateId, path, hasUpdate: !!updateBase64 });
        return;
      }

      const st = await this.getOrLoadFileState(path);
      this.touch(st);

      Y.applyUpdate(st.doc, fromBase64(updateBase64));

      this.logInfo("Applied remote update", { path });

      await this.writeYjsToVault(path, st);
      await this.saveLocalSnapshot(path, st);
    } catch (e) {
      this.logError("applyFileUpdateRowById failed", e);
    }
  }

  // ---------- LRU ----------

  private touch(st: FileState) {
    st.lastUsedMs = Date.now();
  }

  private async enforceLruLimit() {
    while (this.states.size > this.config.maxOpenDocs) {
      let oldestPath: string | null = null;
      let oldestMs = Infinity;

      for (const [path, st] of this.states.entries()) {
        if (st.lastUsedMs < oldestMs) {
          oldestMs = st.lastUsedMs;
          oldestPath = path;
        }
      }

      if (!oldestPath) return;

      await this.closeDoc(oldestPath);
      this.states.delete(oldestPath);
      this.logInfo("LRU evicted doc", { path: oldestPath, openDocs: this.states.size });
    }
  }

  private async closeDoc(path: string) {
    const st = this.states.get(path);
    if (!st) return;

    try {
      if (st.flushTimer != null) {
        window.clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }

      await this.flushOutgoingUpdates(path, st);
      await this.saveLocalSnapshot(path, st);

      st.doc.destroy();
    } catch (e) {
      this.logError("closeDoc failed", { path, error: e });
    }
  }

  // ---------- history cursor ----------

  private async ensureHistoryCursorRow() {
    const cursorId = createIdFromString<"HistoryCursor">("history-cursor");
    this.evolu.upsert("_historyCursor", { id: cursorId, lastTimestamp: null });
  }

  private async loadHistoryCursor(): Promise<TimestampBytes | null> {
    const cursorId = createIdFromString<"HistoryCursor">("history-cursor");

    const q = this.evolu.createQuery((db) =>
      db
        .selectFrom("_historyCursor")
        .select(["lastTimestamp"])
        .where("id", "=", cursorId)
        .where("isDeleted", "is", null)
        .limit(1),
    );

    const rows = await this.evolu.loadQuery(q);
    if (rows.length === 0) return null;
    return rows[0].lastTimestamp ?? null;
  }

  private async saveHistoryCursor(ts: TimestampBytes) {
    const cursorId = createIdFromString<"HistoryCursor">("history-cursor");
    this.evolu.upsert("_historyCursor", { id: cursorId, lastTimestamp: ts });
  }

  // ---------- snapshots ----------

  private async getOrLoadFileState(path: string): Promise<FileState> {
    const existing = this.states.get(path);
    if (existing) return existing;

    await this.enforceLruLimit();

    const doc = new Y.Doc();
    const text = doc.getText("content");

    const snapshotBase64 = await this.loadLocalSnapshot(path);
    if (snapshotBase64) {
      Y.applyUpdate(doc, fromBase64(snapshotBase64));
    } else {
      const f = this.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        const vaultText = await this.vault.read(f);
        doc.transact(() => text.insert(0, vaultText));
      }
    }

    let lastVaultText = "";
    const f2 = this.vault.getAbstractFileByPath(path);
    if (f2 instanceof TFile) lastVaultText = await this.vault.read(f2);

    const st: FileState = {
      doc,
      text,
      lastVaultText,
      ignoreNextVaultModify: false,
      pendingUpdates: [],
      flushTimer: null,
      lastUsedMs: Date.now(),
    };

    doc.on("update", (u: Uint8Array) => {
      st.pendingUpdates.push(u);
      this.scheduleOutgoingFlush(path, st);
    });

    this.states.set(path, st);
    return st;
  }

  private async loadLocalSnapshot(path: string): Promise<string | null> {
    const id = createIdFromString<"FileSnapshot">(`snapshot:${path}`);

    const q = this.evolu.createQuery((db) =>
      db
        .selectFrom("_fileSnapshot")
        .select(["snapshotBase64"])
        .where("id", "=", id)
        .where("isDeleted", "is", null)
        .limit(1),
    );

    const rows = await this.evolu.loadQuery(q);
    if (rows.length === 0) return null;
    return rows[0].snapshotBase64 ?? null;
  }

  private async saveLocalSnapshot(path: string, st: FileState) {
    const snapshotBytes = Y.encodeStateAsUpdate(st.doc);
    const snapshotBase64 = toBase64(snapshotBytes);
    const id = createIdFromString<"FileSnapshot">(`snapshot:${path}`);
    this.evolu.upsert("_fileSnapshot", { id, path, snapshotBase64 });
  }

  // ---------- writeback ----------

  private async writeYjsToVault(path: string, st: FileState) {
    try {
      const newText = st.text.toString();
      if (newText === st.lastVaultText) return;

      let f = this.vault.getAbstractFileByPath(path);

      if (!(f instanceof TFile)) {
        await this.vault.create(path, newText);
        st.lastVaultText = newText;
        return;
      }

      st.ignoreNextVaultModify = true;
      await this.vault.modify(f, newText);
      st.lastVaultText = newText;
    } catch (e) {
      this.logError("writeYjsToVault failed", { path, error: e });
    }
  }

  // ---------- outgoing batching ----------

  private scheduleOutgoingFlush(path: string, st: FileState) {
    if (st.flushTimer != null) return;

    st.flushTimer = window.setTimeout(async () => {
      st.flushTimer = null;
      await this.flushOutgoingUpdates(path, st);
    }, this.config.outgoingBatchMs);
  }

  private async flushOutgoingUpdates(path: string, st: FileState) {
    try {
      if (st.pendingUpdates.length === 0) return;

      const merged = Y.mergeUpdates(st.pendingUpdates);
      st.pendingUpdates = [];

      const updateBase64 = toBase64(merged);
      const id = createIdFromString<"FileUpdate">(
        `upd:${path}:${this.deviceId}:${Date.now()}:${Math.random()}`,
      );

      this.evolu.upsert("fileUpdate", { id, path, updateBase64 });

      this.logInfo("Sent outgoing update", { path, bytes: merged.length });

      await this.saveLocalSnapshot(path, st);
    } catch (e) {
      this.logError("flushOutgoingUpdates failed", { path, error: e });
    }
  }

  private isTextFile(file: TFile): boolean {
    return file.extension === "md" || file.extension === "txt";
  }
}
