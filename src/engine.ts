
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

/**
 * Runtime configuration for {@link YjsEvoluHistoryEngine}.
 * All values are hot-swappable via {@link YjsEvoluHistoryEngine.updateConfig}.
 */
export type EngineConfig = {
  /** Milliseconds between `evolu_history` polls for remote changes. */
  historyPollMs: number;
  /** Maximum `evolu_history` rows consumed per poll cycle. */
  historyBatchSize: number;
  /** Debounce window (ms) before flushing accumulated Yjs updates to Evolu. */
  outgoingBatchMs: number;
  /** Maximum simultaneously open Yjs docs; least-recently-used are evicted above this limit. */
  maxOpenDocs: number;
};

const dmp = new DiffMatchPatch();

/**
 * Encodes a `Uint8Array` to a base64 string.
 * Uses chunked `String.fromCharCode` to avoid call-stack overflow on large arrays.
 */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Decodes a base64 string back to a `Uint8Array`. */
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

/**
 * Core sync engine for obsidian-local-sync.
 *
 * Bridges an Obsidian Vault with Evolu's local-first database using Yjs CRDTs
 * as the source of truth for each tracked file.
 *
 * **Outgoing path** (vault → Evolu):
 * Vault modify events are diffed against the last known text, applied as Yjs
 * ops inside a transaction, then batched and flushed as `fileUpdate` rows.
 *
 * **Incoming path** (Evolu → vault):
 * A recurring poll reads new `evolu_history` rows since the stored cursor,
 * applies each Yjs update to the in-memory doc, and writes the result back to
 * the vault file.
 *
 * **Memory management**:
 * Open docs are bounded by {@link EngineConfig.maxOpenDocs} using LRU eviction.
 * Closing a doc flushes pending updates and saves a full Yjs state snapshot to
 * the local `_fileSnapshot` table before destroying the `Y.Doc`.
 *
 * Only `.md` and `.txt` files are tracked.
 */
export class YjsEvoluHistoryEngine {
  private vault: Vault;
  private evolu: Evolu<Database>;
  private deviceId: string;

  private config: EngineConfig;
  private logLevel: LogLevel;

  private states = new Map<string, FileState>();

  private pollTimer: number | null = null;
  private isPolling = false;
  /** Resolves when the current poll cycle completes. Awaited by stop(). */
  private ongoingPoll: Promise<void> = Promise.resolve();

  // Only process remote history when Obsidian is active
  private isActive = true;

  /**
   * IDs of `fileUpdate` rows written by this engine instance during the current
   * session.  Used by {@link applyFileUpdateRowById} to skip rows that we
   * produced ourselves (self-echo suppression).  Only covers the current
   * process lifetime; rows from previous sessions are still applied once.
   */
  private outgoingIds = new Set<string>();

  /**
   * Paths of vault files that the startup scan identified as having no local
   * snapshot (never seeded) but that are NOT immediately seeded from vault.
   *
   * Seeding is deferred by one poll cycle so the relay has time to deliver
   * any existing history for these files before we create a new Yjs state.
   * Without this, a reset & restore causes the scan to seed vault content
   * into an empty doc, and then when the relay delivers the pre-reset history
   * rows in the next poll, both the seeded op and the history op are applied
   * to the doc → doubled content.
   *
   * Files are removed from this set as soon as a poll touches them (history
   * arrived → no seeding needed).  The remaining files are seeded from vault
   * after one full quiet poll cycle (relay has quiesced for them).
   */
  private pendingVaultSeed = new Set<string>();

  /**
   * Paths for which a remote delete is currently being applied (i.e. we are
   * about to call `vault.trash()`).  While a path is in this set, the vault
   * `"delete"` event fired by the trash call is suppressed in
   * {@link onVaultFileDeleted} so we do not echo the delete back to the relay.
   * Mirrors the `ignoreNextVaultModify` pattern used for content updates.
   */
  private pendingRemoteDeletes = new Set<string>();

  /**
   * Set to `true` when {@link scanVaultForUnsyncedFiles} has finished
   * populating {@link pendingVaultSeed}.  Until this is true the poll loop
   * will not attempt to drain the set (it might not be fully populated yet).
   */
  private scanComplete = false;

  /**
   * Becomes `true` after the first poll cycle that runs *after* the scan is
   * complete (`scanComplete === true`).  Seeding from {@link pendingVaultSeed}
   * is only allowed once this is true AND the current poll returns zero rows
   * (relay is quiet), ensuring at least one full `historyPollMs` window for
   * relay sync before we decide a file has no remote history.
   */
  private pendingVaultSeedReady = false;

  /**
   * A minimal empty Yjs update (full state of a new empty Y.Doc), base64-encoded.
   * Used as the `updateBase64` payload for `fileUpdate` rows with `type: "delete"`.
   * Stored once at construction time to avoid creating a new Y.Doc per delete event.
   */
  private readonly emptyYjsUpdateBase64 = toBase64(Y.encodeStateAsUpdate(new Y.Doc()));

  /**
   * @param args.vault     Obsidian Vault used for reading and writing files.
   * @param args.evolu     Typed Evolu client bound to the plugin's {@link Database} schema.
   * @param args.deviceId  Stable per-device identifier embedded in outgoing update row IDs.
   * @param args.config    Initial engine configuration (hot-swappable via {@link updateConfig}).
   * @param args.logLevel  Initial console log verbosity.
   */
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

  /**
   * Initialises the engine: ensures the history cursor row exists in Evolu,
   * starts the recurring poll timer, and runs an immediate poll to catch up on
   * any changes received while the plugin was unloaded.
   *
   * Safe to call only once per engine instance.
   */
  async start() {
    try {
      await this.ensureHistoryCursorRow();
      this.startPollingTimer();
      this.logInfo("Engine started", this.config);
      // Kick off the audit, scan, and initial poll concurrently.
      // - auditSnapshotsForOfflineDeletes: detects files deleted/renamed while plugin was off.
      // - scanVaultForUnsyncedFiles: populates pendingVaultSeed (no Yjs mutations).
      // - poll: relay delivery; deferred seeding runs after relay is quiet.
      void this.auditSnapshotsForOfflineDeletes();
      void this.scanVaultForUnsyncedFiles();
      if (this.isActive) this.pollHistoryOnce();
    } catch (e) {
      this.logError("Engine start failed", e);
    }
  }

  /**
   * Background scan run once at startup.
   *
   * **Files with a local snapshot** (previously synced): load the Yjs doc to
   * detect any offline drift (vault edited while the plugin was not running).
   * If drift is found, the diff is applied inside {@link getOrLoadFileState},
   * queued in `pendingUpdates`, and flushed normally — no extra Evolu row is
   * written on startup for unchanged files.
   *
   * **Files without a snapshot** (never seeded): rather than immediately seeding
   * their vault content into an empty Yjs doc, they are placed in
   * {@link pendingVaultSeed}.  Seeding is deferred until after the first poll
   * returns zero rows, giving the relay a full `historyPollMs` window to deliver
   * any existing history for those files.  This prevents doubled content on
   * reset & restore: without the deferral the scan seeds vault content, and when
   * the relay delivers pre-reset history rows in the next poll the same text is
   * applied again on top.
   */
  private async scanVaultForUnsyncedFiles() {
    try {
      const files = this.vault.getFiles().filter((f) => this.isTextFile(f));
      this.logInfo("Startup scan: begin", { total: files.length });
      let retransmitted = 0;
      let deferred = 0;

      for (const file of files) {
        if (!this.isActive) break;
        const snapshot = await this.loadLocalSnapshot(file.path);

        if (snapshot === null) {
          // Never been seeded. Defer vault seeding until relay has had a chance
          // to deliver existing history for this file.
          this.logInfo("Startup scan: deferring new file seed", { path: file.path });
          this.pendingVaultSeed.add(file.path);
          deferred++;
        } else {
          // Has a local snapshot — load the doc to detect any offline drift
          // (vault edited while plugin was off).  If vault text ≠ Yjs text the
          // diff is applied inside getOrLoadFileState, queued in pendingUpdates,
          // and flushed normally via the debounce timer.
          //
          // We intentionally do NOT call retransmitCurrentState here. That would
          // write a new Evolu row on every startup even when nothing changed,
          // creating unnecessary evolu_history entries that every other device
          // must download and process on its next poll.  Historical rows in Evolu
          // are sufficient for late-joining devices to reconstruct state.
          await this.getOrLoadFileState(file.path);
          retransmitted++;
        }
      }

      this.logInfo("Startup scan: done", { loaded: retransmitted, deferred, total: files.length });
      this.scanComplete = true;
    } catch (e) {
      this.logError("scanVaultForUnsyncedFiles failed", e);
      this.scanComplete = true; // allow drain even if scan errored
    }
  }

  /**
   * Seeds files from {@link pendingVaultSeed} that have not yet been touched by
   * a poll cycle (i.e. the relay has not delivered any history for them).
   *
   * Called after a poll returns zero rows once {@link pendingVaultSeedReady} is
   * true.  Files already removed from `pendingVaultSeed` by
   * {@link applyFileUpdateRowById} (history arrived → no seeding needed) are
   * skipped automatically by the set iteration.
   */
  private async drainPendingVaultSeed() {
    if (this.pendingVaultSeed.size === 0) return;
    this.logInfo("Startup scan: seeding deferred files", { count: this.pendingVaultSeed.size });
    for (const path of this.pendingVaultSeed) {
      if (!this.isActive) break;
      // Only seed if not already opened by poll (early-return in getOrLoadFileState)
      if (!this.states.has(path)) {
        this.logInfo("Startup scan: seeding new file", { path });
        await this.getOrLoadFileState(path); // seedFromVault: true (default)
      }
      this.pendingVaultSeed.delete(path);
    }
  }

  /**
   * Encodes the current in-memory Yjs doc state as a full update and upserts a
   * `fileUpdate` row with a deterministic per-file-per-device ID.
   * Called after a rename to broadcast the full file state under the new path.
   *
   * Using a fixed ID means repeated calls update the same Evolu row rather than
   * creating unbounded new rows.
   */
  private async retransmitCurrentState(path: string) {
    try {
      const st = await this.getOrLoadFileState(path);
      const updateBytes = Y.encodeStateAsUpdate(st.doc);
      const updateBase64 = toBase64(updateBytes);
      // Deterministic: one permanent row per file per device for startup full-state.
      const id = createIdFromString<"FileUpdate">(
        `startup-retransmit:${path}:${this.deviceId}`,
      );
      this.evolu.upsert("fileUpdate", { id, path, updateBase64 });
      this.outgoingIds.add(id);
      this.logInfo("Startup scan: retransmitted", { path, bytes: updateBytes.length });
    } catch (e) {
      this.logError("retransmitCurrentState failed", { path, error: e });
    }
  }

  /**
   * Shuts down the engine gracefully.
   *
   * Stops the poll timer, then for every open doc: cancels its flush timer,
   * flushes any pending Yjs updates to Evolu, saves a full state snapshot to
   * `_fileSnapshot`, and destroys the `Y.Doc`. All close operations run in
   * parallel via `Promise.all` before in-memory state is cleared.
   *
   * Called from `ObsidianLocalSyncPlugin.onunload` via `void` — the returned
   * promise is not awaited by the Obsidian plugin lifecycle.
   */
  async stop(flush = true) {
    try {
      this.stopPollingTimer();
      // Wait for any in-progress poll to finish so its cursor write is included
      // in the final DB flush.  Without this, the cursor update from the last
      // poll can arrive after closeEvoluDb() has already flushed, and the cursor
      // would revert on the next session — causing full history replay again.
      await this.ongoingPoll;
      if (flush) {
        const paths = Array.from(this.states.keys());
        await Promise.all(paths.map((p) => this.closeDoc(p)));
      } else {
        // Discard in-memory Yjs docs without writing to Evolu. Used when the
        // Evolu DB is being reset/restored and any upserts would hit a
        // partially-re-initialised DB, causing SqliteErrors.
        for (const st of this.states.values()) {
          if (st.flushTimer != null) {
            window.clearTimeout(st.flushTimer);
            st.flushTimer = null;
          }
          st.doc.destroy();
        }
      }
      this.states.clear();
      this.logInfo("Engine stopped");
    } catch (e) {
      this.logError("Engine stop failed", e);
    }
  }

  /**
   * Hot-swaps the engine configuration without requiring a restart.
   *
   * Resets the poll timer to the new interval and enforces the updated LRU
   * limit immediately, evicting docs if the new `maxOpenDocs` is smaller than
   * the current open count.
   */
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

  /** Changes the console log verbosity at runtime. Takes effect immediately. */
  setLogLevel(level: LogLevel) {
    this.logLevel = level;
    this.logInfo("Log level set", level);
  }

  /**
   * Resumes remote-history polling.
   *
   * Called when the Obsidian window regains focus (`window focus` or
   * `visibilitychange` → visible). Triggers an immediate poll to catch up on
   * changes received while the engine was inactive.
   */
  async setActive() {
    this.isActive = true;
    this.logInfo("App active");
    this.pollHistoryOnce();
  }

  /**
   * Pauses remote-history polling.
   *
   * Called when the Obsidian window loses focus (`window blur` or
   * `visibilitychange` → hidden). The recurring timer keeps running but each
   * tick is a no-op while `isActive` is false.
   */
  setInactive() {
    this.isActive = false;
    this.logInfo("App inactive");
  }

  // ---------- vault -> yjs ----------

  /**
   * Handles a vault `"modify"` event for a text file.
   *
   * Reads the new file content, diffs it against the last known text using
   * diff-match-patch, and applies minimal insert/delete operations to the
   * file's `Y.Text` inside a single Yjs transaction. The `"update"` event
   * emitted by the transaction is queued in `pendingUpdates` and a debounce
   * flush is scheduled.
   *
   * Skips one modify event after each remote write-back (via
   * `ignoreNextVaultModify`) to prevent a self-echo loop.
   *
   * Non-text files (extensions other than `.md` / `.txt`) are silently ignored.
   *
   * @param file The modified vault file.
   */
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

  private pollHistoryOnce() {
    if (!this.isActive || this.isPolling) return;
    this.isPolling = true;
    this.ongoingPoll = (async () => {
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

        const touchedPaths = new Set<string>();
        for (const h of rows) {
          const id = idBytesToId(h.id as unknown as IdBytes);
          const path = await this.applyFileUpdateRowById(id);
          if (path !== null) {
            touchedPaths.add(path);
            // History arrived for this path — no need to seed from vault.
            this.pendingVaultSeed.delete(path);
          }
        }

        // Save one snapshot per touched file rather than one per update row.
        for (const p of touchedPaths) {
          const st = this.states.get(p);
          if (st) await this.saveLocalSnapshot(p, st);
        }

        if (rows.length > 0) {
          const lastTs = rows[rows.length - 1].timestamp as unknown as TimestampBytes;
          await this.saveHistoryCursor(lastTs);
        }

        // Deferred vault seeding: once the scan has finished populating
        // pendingVaultSeed (scanComplete) and at least one subsequent poll
        // cycle has elapsed (pendingVaultSeedReady), seed any files the relay
        // did not deliver history for.  We only drain when the current batch
        // is empty (relay is quiet) so we don't seed a file mid-stream while
        // its history rows are still arriving.
        if (this.scanComplete) {
          if (!this.pendingVaultSeedReady) {
            this.pendingVaultSeedReady = true;
          } else if (rows.length === 0) {
            await this.drainPendingVaultSeed();
          }
        }
      } catch (e) {
        this.logError("pollHistoryOnce failed", e);
      } finally {
        this.isPolling = false;
      }
    })();
  }

  private async applyFileUpdateRowById(fileUpdateId: any): Promise<string | null> {
    // Skip rows we produced ourselves — no need to re-apply our own updates.
    if (this.outgoingIds.has(fileUpdateId)) {
      this.logInfo("Skipped own fileUpdate row", { fileUpdateId });
      return null;
    }

    try {
      const q = this.evolu.createQuery((db) =>
        db
          .selectFrom("fileUpdate")
          .select(["path", "updateBase64", "type"])
          .where("id", "=", fileUpdateId)
          .where("isDeleted", "is", null)
          .limit(1),
      );

      const rows = await this.evolu.loadQuery(q);
      if (rows.length === 0) {
        this.logWarn("History referenced missing fileUpdate row", { fileUpdateId });
        return null;
      }

      const { path, updateBase64, type } = rows[0];
      if (!path || !updateBase64) {
        this.logWarn("fileUpdate row missing fields", { fileUpdateId, path, hasUpdate: !!updateBase64 });
        return null;
      }

      // Handle remote delete.
      if (type === "delete") {
        this.destroyDoc(path);
        this.pendingVaultSeed.delete(path);
        this.tombstoneSnapshot(path);
        const f = this.vault.getAbstractFileByPath(path);
        if (f) {
          this.pendingRemoteDeletes.add(path);
          try {
            await this.vault.trash(f, true);
          } finally {
            this.pendingRemoteDeletes.delete(path);
          }
        }
        this.logInfo("Applied remote delete", { path });
        return path;
      }

      // Skip our own startup-retransmit rows from previous sessions.
      //
      // startup-retransmit uses a deterministic ID so Evolu upserts the same row
      // each startup.  outgoingIds only suppresses rows written in the *current*
      // session; in the next session the row's history timestamp falls after the
      // saved cursor, so the poll would re-apply it — reverting any vault edits
      // made while the plugin was paused between sessions.
      const myRetransmitId = createIdFromString<"FileUpdate">(
        `startup-retransmit:${path}:${this.deviceId}`,
      );
      if (fileUpdateId === myRetransmitId) {
        this.logInfo("Skipped own startup-retransmit row", { path });
        return null;
      }

      // Don't seed from vault — history replay provides the content.
      // Seeding here would cause doubled content after reset & restore.
      const st = await this.getOrLoadFileState(path, { seedFromVault: false });
      this.touch(st);

      // Pass "remote" as the transaction origin so the doc.on("update") listener
      // can distinguish this apply from a local edit and skip re-queuing it for
      // outgoing transmission (which would create an echo loop between devices).
      Y.applyUpdate(st.doc, fromBase64(updateBase64), "remote");

      const textAfterApply = st.text.toString();
      this.logInfo("Applied remote update", {
        path,
        yjsTextLength: textAfterApply.length,
        lastVaultTextLength: st.lastVaultText.length,
      });

      await this.writeYjsToVault(path, st);
      return path;
    } catch (e) {
      this.logError("applyFileUpdateRowById failed", e);
      return null;
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

  /**
   * Cancels any pending flush timer and destroys the Y.Doc for `path` without
   * flushing pending updates or saving a snapshot.
   *
   * Used when the file is being deleted or renamed — we do not want to
   * retransmit stale content or write a snapshot for a path that no longer
   * exists in the vault.
   */
  private destroyDoc(path: string) {
    const st = this.states.get(path);
    if (!st) return;
    if (st.flushTimer != null) {
      window.clearTimeout(st.flushTimer);
      st.flushTimer = null;
    }
    st.doc.destroy();
    this.states.delete(path);
  }

  // ---------- history cursor ----------

  private async ensureHistoryCursorRow() {
    const cursorId = createIdFromString<"HistoryCursor">("history-cursor");
    // Do NOT pass lastTimestamp here — omitting it preserves any existing value.
    // Passing `null` would be a newer CRDT write and would reset the cursor on
    // every startup, causing the full history to be replayed each session.
    this.evolu.upsert("_historyCursor", { id: cursorId });
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

  private async getOrLoadFileState(
    path: string,
    { seedFromVault = true }: { seedFromVault?: boolean } = {},
  ): Promise<FileState> {
    const existing = this.states.get(path);
    if (existing) return existing;

    await this.enforceLruLimit();

    const doc = new Y.Doc();
    const text = doc.getText("content");

    const snapshotBase64 = await this.loadLocalSnapshot(path);

    let lastVaultText = "";
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      lastVaultText = await this.vault.read(f);
    }

    // Apply snapshot BEFORE registering the update listener so the restored
    // state is not re-broadcast to other devices (they already have it).
    if (snapshotBase64) {
      Y.applyUpdate(doc, fromBase64(snapshotBase64));
    }

    const st: FileState = {
      doc,
      text,
      lastVaultText,
      ignoreNextVaultModify: false,
      pendingUpdates: [],
      flushTimer: null,
      lastUsedMs: Date.now(),
    };

    doc.on("update", (u: Uint8Array, origin: unknown) => {
      // Skip updates applied from the poll loop — those are remote updates that
      // must not be echoed back to the network.  Only locally-generated ops
      // (vault edits, vault seeding, drift catch-up) should be transmitted.
      if (origin === "remote") return;
      st.pendingUpdates.push(u);
      this.scheduleOutgoingFlush(path, st);
    });

    // After the listener is registered, reconcile vault state with Yjs state.
    //
    // Case 1 — snapshot exists but vault was edited while the plugin was not
    // running ("paused" state): the restored Yjs doc has the old content while
    // the vault file has newer edits.  Apply the diff so the catch-up edit is
    // captured in pendingUpdates and transmitted to other devices.
    //
    // Case 2 — no snapshot: the file has never been seeded into Yjs.  Insert
    // the full vault content so it becomes the founding Yjs state and is
    // transmitted to other devices.  Only done when seedFromVault is true
    // (false when called from poll context to avoid doubling content with
    // history replay).
    if (snapshotBase64 && lastVaultText) {
      const yjsText = text.toString();
      if (yjsText !== lastVaultText) {
        this.logInfo("getOrLoadFileState: vault drifted from snapshot, applying catch-up diff", {
          path,
          yjsLen: yjsText.length,
          vaultLen: lastVaultText.length,
        });
        doc.transact(() => {
          applyBetterDiffToYText(text, yjsText, lastVaultText);
        });
      }
    } else if (!snapshotBase64 && lastVaultText && seedFromVault) {
      doc.transact(() => text.insert(0, lastVaultText));
    }

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
    const val = rows[0].snapshotBase64 ?? null;
    // "DELETED" is a tombstone written by the delete/rename handlers and the
    // offline-delete audit.  Treat it as no snapshot so the path is handled
    // as a brand-new file if it is ever re-created.
    if (val === "DELETED") return null;
    return val;
  }

  private async saveLocalSnapshot(path: string, st: FileState) {
    const snapshotBytes = Y.encodeStateAsUpdate(st.doc);
    const snapshotBase64 = toBase64(snapshotBytes);
    const id = createIdFromString<"FileSnapshot">(`snapshot:${path}`);
    this.evolu.upsert("_fileSnapshot", { id, path, snapshotBase64 });
  }

  /**
   * Writes a tombstone marker to the snapshot row for `path`.
   *
   * `loadLocalSnapshot` treats `"DELETED"` as `null`, so if the path is
   * re-created later it starts fresh without the old Yjs history interfering.
   * The tombstone also prevents the offline-delete audit from re-emitting a
   * delete row on every subsequent startup.
   */
  private tombstoneSnapshot(path: string) {
    const id = createIdFromString<"FileSnapshot">(`snapshot:${path}`);
    this.evolu.upsert("_fileSnapshot", { id, path, snapshotBase64: "DELETED" });
  }

  // ---------- writeback ----------

  private async writeYjsToVault(path: string, st: FileState) {
    try {
      const newText = st.text.toString();
      this.logInfo("writeYjsToVault: enter", {
        path,
        newTextLen: newText.length,
        lastVaultTextLen: st.lastVaultText.length,
        unchanged: newText === st.lastVaultText,
      });
      if (newText === st.lastVaultText) {
        this.logInfo("writeYjsToVault: no change, skipping", { path });
        return;
      }

      let f = this.vault.getAbstractFileByPath(path);
      this.logInfo("writeYjsToVault: vault lookup", { path, fileFound: f instanceof TFile });

      if (!(f instanceof TFile)) {
        // Create parent folder(s) if the path contains a directory component
        // that doesn't exist on this device yet.
        const slashIdx = path.lastIndexOf("/");
        if (slashIdx > 0) {
          const folderPath = path.substring(0, slashIdx);
          if (!this.vault.getAbstractFileByPath(folderPath)) {
            this.logInfo("writeYjsToVault: creating folder", { folderPath });
            await this.vault.createFolder(folderPath);
          }
        }

        this.logInfo("writeYjsToVault: creating file", { path, chars: newText.length });
        await this.vault.create(path, newText);
        st.lastVaultText = newText;
        this.logInfo("writeYjsToVault: file created", { path });
        return;
      }

      this.logInfo("writeYjsToVault: modifying file", { path, chars: newText.length });
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
      this.outgoingIds.add(id);

      this.logInfo("Sent outgoing update", { path, bytes: merged.length });

      await this.saveLocalSnapshot(path, st);
    } catch (e) {
      this.logError("flushOutgoingUpdates failed", { path, error: e });
    }
  }

  private isTextFile(file: TFile): boolean {
    return file.extension === "md" || file.extension === "txt";
  }

  private isTextPath(path: string): boolean {
    return path.endsWith(".md") || path.endsWith(".txt");
  }

  // ---------- delete / rename handlers ----------

  /**
   * Called when the vault fires a `"delete"` event for a text file.
   *
   * Destroys the in-memory Yjs doc, tombstones the snapshot so the path is
   * treated as fresh if re-created, and emits a `fileUpdate { type: "delete" }`
   * row so other devices trash the file.
   */
  async onVaultFileDeleted(file: TFile) {
    if (!this.isTextFile(file)) return;
    const path = file.path;
    if (this.pendingRemoteDeletes.has(path)) return; // remote-initiated trash — suppress echo
    try {
      this.destroyDoc(path);
      this.pendingVaultSeed.delete(path);
      this.tombstoneSnapshot(path);

      const id = createIdFromString<"FileUpdate">(
        `del:${path}:${this.deviceId}:${Date.now()}:${Math.random()}`,
      );
      this.evolu.upsert("fileUpdate", {
        id,
        path,
        updateBase64: this.emptyYjsUpdateBase64,
        type: "delete",
      });
      this.outgoingIds.add(id);
      this.logInfo("Vault file deleted, propagating", { path });
    } catch (e) {
      this.logError("onVaultFileDeleted failed", { path, error: e });
    }
  }

  /**
   * Called when the vault fires a `"rename"` event for a text file.
   *
   * Propagated as a delete of the old path + a full-state retransmit of the
   * new path.  The in-memory doc state is re-keyed to the new path so edits
   * made immediately after the rename are diff'd against the correct baseline.
   */
  async onVaultFileRenamed(file: TFile, oldPath: string) {
    const newPath = file.path;
    if (!this.isTextPath(oldPath) && !this.isTextPath(newPath)) return;
    try {
      // Re-key in-memory state to the new path.
      const st = this.states.get(oldPath);
      if (st) {
        this.states.delete(oldPath);
        this.states.set(newPath, st);
        await this.saveLocalSnapshot(newPath, st);
      }

      this.pendingVaultSeed.delete(oldPath);
      this.tombstoneSnapshot(oldPath);

      // Propagate the deletion of the old path.
      const delId = createIdFromString<"FileUpdate">(
        `del:${oldPath}:${this.deviceId}:${Date.now()}:${Math.random()}`,
      );
      this.evolu.upsert("fileUpdate", {
        id: delId,
        path: oldPath,
        updateBase64: this.emptyYjsUpdateBase64,
        type: "delete",
      });
      this.outgoingIds.add(delId);

      // Broadcast full state under the new path.
      await this.retransmitCurrentState(newPath);

      this.logInfo("Vault file renamed, propagating", { oldPath, newPath });
    } catch (e) {
      this.logError("onVaultFileRenamed failed", { oldPath, newPath, error: e });
    }
  }

  // ---------- offline delete audit ----------

  /**
   * Startup audit: detects files that were deleted or renamed while the plugin
   * was disabled by comparing all non-tombstone snapshots against the current
   * vault file list.
   *
   * Any snapshot path that has no matching vault file is treated as an offline
   * delete.  A `fileUpdate { type: "delete" }` row is emitted so other devices
   * trash the file, and the snapshot is tombstoned to prevent re-auditing on
   * the next startup.
   *
   * Called concurrently from `start()` alongside `scanVaultForUnsyncedFiles`.
   */
  private async auditSnapshotsForOfflineDeletes() {
    try {
      const q = this.evolu.createQuery((db) =>
        db
          .selectFrom("_fileSnapshot")
          .select(["path", "snapshotBase64"])
          .where("isDeleted", "is", null),
      );
      const rows = await this.evolu.loadQuery(q);
      if (rows.length === 0) return;

      const vaultPaths = new Set(
        this.vault.getFiles().filter((f) => this.isTextFile(f)).map((f) => f.path),
      );

      let audited = 0;
      for (const row of rows) {
        const path = row.path;
        if (!path) continue;
        // Skip already-tombstoned snapshots.
        if (row.snapshotBase64 === "DELETED") continue;
        // If the file still exists in the vault, nothing to do.
        if (vaultPaths.has(path)) continue;

        this.logInfo("Startup audit: offline delete detected", { path });
        this.destroyDoc(path);
        this.pendingVaultSeed.delete(path);
        this.tombstoneSnapshot(path);

        const id = createIdFromString<"FileUpdate">(
          `del:${path}:${this.deviceId}:${Date.now()}:${Math.random()}`,
        );
        this.evolu.upsert("fileUpdate", {
          id,
          path,
          updateBase64: this.emptyYjsUpdateBase64,
          type: "delete",
        });
        this.outgoingIds.add(id);
        audited++;
      }

      if (audited > 0) {
        this.logInfo("Startup audit: done", { offlineDeletes: audited });
      }
    } catch (e) {
      this.logError("auditSnapshotsForOfflineDeletes failed", e);
    }
  }
}
