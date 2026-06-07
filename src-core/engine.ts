import * as Y from "yjs";
import DiffMatchPatch from "diff-match-patch";
import type { Evolu, IdBytes, TimestampBytes } from "@evolu/common";
import { createIdFromString, idBytesToId } from "@evolu/common";
import type { Database } from "./schema";
import type { LocalSyncConfig } from "./pathPolicy";
import {
  DEFAULT_LOCAL_SYNC_CONFIG,
  getTrackingDecision,
  isTrackedVaultFile,
  isTrackedSettingPath,
  isTrackedVaultPath,
} from "./pathPolicy";
import { formatLogLine, type LogFormatter } from "./logFormat";
import type { VaultAdapter, VaultFile } from "./vaultAdapter";

/**
 * Logging levels (simple).
 * - off: nothing
 * - error: only errors
 * - warn: warnings + errors
 * - info: normal operational logs + warnings + errors
 * - debug: verbose per-file/cache internals
 */
export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

const levelRank: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
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

export type SyncProgress =
  | {
      status: "syncing";
      message: string;
      current?: number;
      total?: number;
    }
  | {
      status: "caught-up";
      message: string;
    }
  | {
      status: "blocked";
      message: string;
    };

export type SyncProgressReporter = (progress: SyncProgress) => void;

export type ReconcileResult = "loaded" | "deferred" | "skipped";

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

function base64ToText(b64: string): string {
  return new TextDecoder().decode(fromBase64(b64));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function hashText(text: string): string {
  // FNV-1a 64-bit. This is a change detector, not a security boundary.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

async function encodeSettingContent(text: string): Promise<{
  contentBase64: string;
  encoding: string | null;
  rawBytes: number;
  storedBytes: number;
}> {
  const rawBytes = new TextEncoder().encode(text);
  const gzipBytes = await gzipBytesIfAvailable(rawBytes);

  if (gzipBytes && gzipBytes.length < rawBytes.length) {
    return {
      contentBase64: toBase64(gzipBytes),
      encoding: "gzip",
      rawBytes: rawBytes.length,
      storedBytes: gzipBytes.length,
    };
  }

  return {
    contentBase64: toBase64(rawBytes),
    encoding: null,
    rawBytes: rawBytes.length,
    storedBytes: rawBytes.length,
  };
}

async function decodeSettingContent(row: SettingUpdateRow): Promise<string> {
  if (row.encoding === "gzip") {
    return new TextDecoder().decode(await gunzipBytes(fromBase64(row.contentBase64)));
  }
  return base64ToText(row.contentBase64);
}

async function gzipBytesIfAvailable(bytes: Uint8Array): Promise<Uint8Array | null> {
  type CompressionStreamConstructor = new (format: "gzip") => TransformStream<Uint8Array, Uint8Array>;
  const CompressionStreamCtor = (globalThis as { CompressionStream?: CompressionStreamConstructor }).CompressionStream;
  if (!CompressionStreamCtor) return null;

  try {
    const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStreamCtor("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  type DecompressionStreamConstructor = new (format: "gzip") => TransformStream<Uint8Array, Uint8Array>;
  const DecompressionStreamCtor = (globalThis as { DecompressionStream?: DecompressionStreamConstructor }).DecompressionStream;
  if (!DecompressionStreamCtor) {
    throw new Error("Cannot decode gzip setting payload: DecompressionStream is not available");
  }
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStreamCtor("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

export type RebasedTextChange = {
  text: string;
  patchResults: boolean[];
};

/**
 * Rebase a local text change onto the current Yjs text.
 *
 * `oldText -> newText` is the change observed in the vault file. `currentText`
 * is the current replicated Yjs content, which may already include remote edits
 * not present in `oldText`. Applying a positional diff from `oldText` directly
 * to Yjs is only valid when `currentText === oldText`; otherwise indexes can
 * point at the wrong content. Patches are fuzzier and can usually apply the
 * local edit onto the current replicated text.
 */
export function rebaseTextChange(
  oldText: string,
  currentText: string,
  newText: string,
): RebasedTextChange {
  if (oldText === newText) return { text: currentText, patchResults: [] };
  if (oldText === currentText) return { text: newText, patchResults: [] };

  const patches = dmp.patch_make(oldText, newText);
  const [text, patchResults] = dmp.patch_apply(patches, currentText) as [string, boolean[]];
  return { text, patchResults };
}

function applyRebasedTextChangeToYText(
  ytext: Y.Text,
  oldText: string,
  newText: string,
): RebasedTextChange {
  const currentText = ytext.toString();
  const result = rebaseTextChange(oldText, currentText, newText);
  applyBetterDiffToYText(ytext, currentText, result.text);
  return result;
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
  flushTimer: ReturnType<typeof setTimeout> | null;

};

type SyncInventory = {
  vaultPathsMissingFileUpdate: string[];
  snapshotPathsMissingFileUpdate: string[];
};

type SettingSnapshot = {
  contentHash: string;
  deleted: boolean;
};

type SettingUpdateRow = {
  path: string;
  contentBase64: string;
  contentHash: string;
  encoding: string | null;
  type: string | null;
};

type SettingUpdateWithId = SettingUpdateRow & { id: string };

/**
 * Core sync engine for obsidian-local-sync.
 *
 * Bridges a vault adapter with Evolu's local-first database using Yjs CRDTs
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
  private vault: VaultAdapter;
  private evolu: Evolu<Database>;
  private deviceId: string;

  private config: EngineConfig;
  private localSyncConfig: LocalSyncConfig;
  private logLevel: LogLevel;
  private formatLogLine: LogFormatter = formatLogLine;
  private reportSyncProgress?: SyncProgressReporter;

  private states = new Map<string, FileState>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private vaultRescanTimer: ReturnType<typeof setInterval> | null = null;
  private settingsRescanTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private isScanningVault = false;
  private isStopped = false;
  /** Resolves when the current poll cycle completes. Awaited by stop(). */
  private ongoingPoll: Promise<void> = Promise.resolve();

  // Only process remote history when Obsidian is active
  private isActive = true;

  /**
   * IDs of `fileUpdate` rows written by this engine instance during the current
   * session.  Used by {@link pollHistoryOnce} to skip rows that we produced
   * ourselves (self-echo suppression).  Only covers the current
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
  private pendingSettingSeed = new Set<string>();

  /**
   * Paths for which a remote delete is currently being applied (i.e. we are
   * about to call `vault.trash()`).  While a path is in this set, the vault
   * `"delete"` event fired by the trash call is suppressed in
   * {@link onVaultFileDeleted} so we do not echo the delete back to the relay.
   * Mirrors the `ignoreNextVaultModify` pattern used for content updates.
   */
  private pendingRemoteDeletes = new Set<string>();
  private pendingRemoteSettingWrites = new Set<string>();
  private pendingRemoteSettingDeletes = new Set<string>();

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
  private hasLoggedQuietSyncInventory = false;

  /**
   * A minimal empty Yjs update (full state of a new empty Y.Doc), base64-encoded.
   * Used as the `updateBase64` payload for `fileUpdate` rows with `type: "delete"`.
   * Stored once at construction time to avoid creating a new Y.Doc per delete event.
   */
  private readonly emptyYjsUpdateBase64 = toBase64(Y.encodeStateAsUpdate(new Y.Doc()));

  /**
   * @param args.vault     Runtime vault adapter used for reading and writing files.
   * @param args.evolu     Typed Evolu client bound to the plugin's {@link Database} schema.
   * @param args.deviceId  Stable per-device identifier embedded in outgoing update row IDs.
   * @param args.config    Initial engine configuration (hot-swappable via {@link updateConfig}).
   * @param args.logLevel  Initial console log verbosity.
   */
  constructor(args: {
    vault: VaultAdapter;
    evolu: Evolu<Database>;
    deviceId: string;
    config: EngineConfig;
    localSyncConfig?: LocalSyncConfig;
    logLevel: LogLevel;
    logFormatter?: LogFormatter;
    reportSyncProgress?: SyncProgressReporter;
  }) {
    this.vault = args.vault;
    this.evolu = args.evolu;
    this.deviceId = args.deviceId;
    this.config = args.config;
    this.localSyncConfig = args.localSyncConfig ?? DEFAULT_LOCAL_SYNC_CONFIG;
    this.logLevel = args.logLevel;
    this.formatLogLine = args.logFormatter ?? formatLogLine;
    this.reportSyncProgress = args.reportSyncProgress;
  }

  // ---------- logging helpers ----------

  private logInfo(message: string, data?: unknown) {
    if (levelRank[this.logLevel] < levelRank.info) return;
    console.log(this.formatLogLine("INFO", message, data));
  }

  private logDebug(message: string, data?: unknown) {
    if (levelRank[this.logLevel] < levelRank.debug) return;
    console.log(this.formatLogLine("DEBUG", message, data));
  }

  private logWarn(message: string, data?: unknown) {
    if (levelRank[this.logLevel] < levelRank.warn) return;
    console.warn(this.formatLogLine("WARN", message, data));
  }

  private logError(message: string, data?: unknown) {
    if (levelRank[this.logLevel] < levelRank.error) return;
    console.error(this.formatLogLine("ERROR", message, data));
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
      this.isStopped = false;
      await this.ensureHistoryCursorRow();
      this.startPollingTimer();
      this.startRescanTimer();
      this.logInfo("Engine started", this.config);
      // Kick off the audit, scan, and initial poll concurrently.
      // - auditSnapshotsForOfflineDeletes: detects files deleted/renamed while plugin was off.
      // - scanVaultForUnsyncedFiles: populates pendingVaultSeed (no Yjs mutations).
      // - poll: relay delivery; deferred seeding runs after relay is quiet.
      if (this.localSyncConfig.startupScan) {
        void this.auditSnapshotsForOfflineDeletes("Startup scan");
        void this.scanVaultForUnsyncedFiles("Startup scan");
        void this.auditSettingSnapshotsForOfflineDeletes("Startup settings scan");
        void this.scanSettingsForUnsyncedFiles("Startup settings scan");
      } else {
        this.scanComplete = true;
      }
      if (this.isActive) this.pollHistoryOnce();
    } catch (e) {
      this.logError("Engine start failed", e);
    }
  }

  /**
   * Background scan run at startup and, when configured, periodically.
   *
   * Uses {@link reconcileVaultFile} rather than pretending every vault file was
   * modified. Files with snapshots are loaded to detect offline drift; files
   * without snapshots are deferred until after the relay has gone quiet.
   */
  private async scanVaultForUnsyncedFiles(label: string) {
    if (this.isStopped) return;
    if (this.isScanningVault) {
      this.logInfo(`${label}: already running, skipping`);
      return;
    }

    this.isScanningVault = true;
    try {
      const allFiles = await this.vault.listFiles();
      const files: VaultFile[] = [];
      const skippedByExtension = new Map<string, number>();
      const skippedByRule = new Map<string, number>();

      for (const file of allFiles) {
        const decision = getTrackingDecision(file, this.localSyncConfig);
        if (decision.tracked) {
          files.push(file);
          continue;
        }

        if (decision.reason === "extension") {
          const key = decision.extension || "(none)";
          skippedByExtension.set(key, (skippedByExtension.get(key) ?? 0) + 1);
          if (label === "Startup scan") this.logInfo(`${label}: skipped file`, {
            path: file.path,
            reason: decision.reason,
            extension: key,
          });
        } else {
          skippedByRule.set(decision.rule, (skippedByRule.get(decision.rule) ?? 0) + 1);
          if (label === "Startup scan") this.logInfo(`${label}: skipped file`, {
            path: file.path,
            reason: decision.reason,
            rule: decision.rule,
          });
        }
      }

      this.logInfo(`${label}: begin`, {
        adapterFiles: allFiles.length,
        trackedFiles: files.length,
        skippedByExtension: Object.fromEntries(skippedByExtension),
        skippedByRule: Object.fromEntries(skippedByRule),
      });
      let loaded = 0;
      let deferred = 0;

      for (const file of files) {
        if (!this.isActive || this.isStopped) break;
        const result = await this.reconcileVaultFile(file.path, label);

        if (result === "deferred") {
          deferred++;
        } else if (result === "loaded") {
          loaded++;
        }
      }

      this.logInfo(`${label}: done`, {
        loaded,
        deferred,
        trackedFiles: files.length,
        adapterFiles: allFiles.length,
      });
      await this.logSyncInventory(label === "Startup scan" ? "startup-scan-done" : "periodic-rescan-done", files);
      this.scanComplete = true;
    } catch (e) {
      this.logError(`${label}: scanVaultForUnsyncedFiles failed`, e);
      this.scanComplete = true; // allow drain even if scan errored
    } finally {
      this.isScanningVault = false;
    }
  }

  private async scanSettingsForUnsyncedFiles(label: string) {
    if (this.isStopped) return;
    if (!this.localSyncConfig.syncObsidianSettings) return;

    try {
      await this.repairSettingsFromRemoteState(`${label}: remote settings repair`);

      const paths = await this.listTrackedSettingPaths();
      this.logInfo(`${label}: begin`, { trackedSettings: paths.length });

      let advertised = 0;
      let deferred = 0;
      let unchanged = 0;

      for (const path of paths) {
        if (!this.isActive || this.isStopped) break;
        const result = await this.reconcileSettingFile(path, label);
        if (result === "deferred") deferred++;
        else if (result === "advertised") advertised++;
        else if (result === "unchanged") unchanged++;
      }

      this.logInfo(`${label}: done`, {
        trackedSettings: paths.length,
        advertised,
        deferred,
        unchanged,
      });
    } catch (e) {
      this.logError(`${label}: scanSettingsForUnsyncedFiles failed`, e);
    }
  }

  private async listTrackedSettingPaths(): Promise<string[]> {
    if (!this.localSyncConfig.syncObsidianSettings) return [];

    const discovered = new Set<string>();
    await this.collectSettingPaths(".obsidian", discovered);
    return Array.from(discovered)
      .filter((path) => isTrackedSettingPath(path, this.localSyncConfig))
      .sort();
  }

  private async collectSettingPaths(folder: string, discovered: Set<string>): Promise<void> {
    if (this.isStopped) return;
    const listing = await this.vault.listFolder(folder);
    if (!listing) return;

    for (const filePath of listing.files) discovered.add(filePath);
    for (const folderPath of listing.folders) {
      await this.collectSettingPaths(folderPath, discovered);
    }
  }

  private async reconcileSettingFile(path: string, label: string): Promise<"advertised" | "deferred" | "unchanged" | "skipped"> {
    if (this.isStopped) return "skipped";
    if (!isTrackedSettingPath(path, this.localSyncConfig)) return "skipped";

    const content = await this.vault.readText(path);
    if (content === null) return "skipped";

    const snapshot = await this.loadSettingSnapshot(path);
    if (snapshot === null || snapshot.deleted) {
      this.pendingSettingSeed.add(path);
      this.logInfo(`${label}: deferring new setting seed`, { path });
      return "deferred";
    }

    const contentHash = hashText(content);
    if (snapshot.contentHash === contentHash) return "unchanged";

    await this.advertiseSettingContent(path, content, contentHash, `${label}: setting changed`);
    return "advertised";
  }

  /**
   * Reconciles one vault file during startup without treating it as a fresh
   * modify event.
   *
   * **Existing snapshot:** load the Yjs doc and compare its text with vault
   * content. If vault content drifted while the engine was stopped, the diff is
   * applied inside {@link getOrLoadFileState} and flushed normally.
   *
   * **No snapshot:** defer seeding until after a quiet relay poll so existing
   * remote history has a chance to arrive first.
   */
  async reconcileVaultFile(path: string, label = "Startup scan"): Promise<ReconcileResult> {
    if (this.isStopped) return "skipped";
    if (!isTrackedVaultPath(path, this.localSyncConfig)) return "skipped";

    const snapshot = await this.loadLocalSnapshot(path);
    if (snapshot === null) {
      this.logInfo(`${label}: deferring new file seed`, { path });
      this.pendingVaultSeed.add(path);
      return "deferred";
    }

    await this.getOrLoadFileState(path);
    return "loaded";
  }

  /**
   * Seeds files from {@link pendingVaultSeed} that have not yet been touched by
   * a poll cycle (i.e. the relay has not delivered any history for them).
   *
   * Called after a poll returns zero rows once {@link pendingVaultSeedReady} is
   * true.  Files already removed from `pendingVaultSeed` by
   * {@link pollHistoryOnce} (history arrived → no seeding needed) are
   * skipped automatically by the set iteration.
  */
  private async drainPendingVaultSeed() {
    if (this.isStopped) return;
    if (this.pendingVaultSeed.size === 0) return;
    this.logInfo("Deferred seed: seeding files", { count: this.pendingVaultSeed.size });
    for (const path of this.pendingVaultSeed) {
      if (!this.isActive || this.isStopped) break;
      // Only seed if not already opened by poll (early-return in getOrLoadFileState)
      if (!this.states.has(path)) {
        this.logInfo("Deferred seed: seeding new file", { path });
        await this.getOrLoadFileState(path); // seedFromVault: true (default)
      } else {
        this.logInfo("Deferred seed: file already opened, skipping seed", { path });
      }
      this.pendingVaultSeed.delete(path);
    }
  }

  private async drainPendingSettingSeed() {
    if (this.isStopped) return;
    if (!this.localSyncConfig.syncObsidianSettings || this.pendingSettingSeed.size === 0) return;

    const remoteSettings = await this.loadLatestSettingUpdatesFromHistory();
    this.logInfo("Deferred settings seed: seeding files", { count: this.pendingSettingSeed.size });
    for (const path of this.pendingSettingSeed) {
      if (!this.isActive || this.isStopped) break;
      if (!isTrackedSettingPath(path, this.localSyncConfig)) {
        this.pendingSettingSeed.delete(path);
        continue;
      }

      const remote = remoteSettings.get(path);
      if (remote) {
        await this.applyRemoteSettingUpdate(remote);
        this.pendingSettingSeed.delete(path);
        this.logInfo("Deferred settings seed: remote state exists, skipped local seed", { path });
        continue;
      }

      const content = await this.vault.readText(path);
      if (content === null) {
        this.pendingSettingSeed.delete(path);
        continue;
      }

      await this.advertiseSettingContent(path, content, hashText(content), "Deferred settings seed: seeding new setting");
      this.pendingSettingSeed.delete(path);
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
  private async retransmitCurrentState(path: string): Promise<boolean> {
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
      await this.saveLocalSnapshot(path, st);
      this.logInfo("Startup scan: retransmitted", { path, bytes: updateBytes.length });
      return true;
    } catch (e) {
      this.logError("retransmitCurrentState failed", { path, error: e });
      return false;
    }
  }

  private async advertiseSettingContent(
    path: string,
    content: string,
    contentHash = hashText(content),
    message = "Sent outgoing setting update",
  ): Promise<void> {
    const id = createIdFromString<"SettingUpdate">(
      `setting:${path}:${this.deviceId}:${Date.now()}:${Math.random()}`,
    );
    const encoded = await encodeSettingContent(content);
    this.evolu.upsert("settingUpdate", {
      id,
      path,
      contentBase64: encoded.contentBase64,
      contentHash,
      encoding: encoded.encoding,
    });
    this.outgoingIds.add(id);
    this.saveSettingSnapshot(path, contentHash);
    this.logInfo(message, {
      path,
      chars: content.length,
      contentHash,
      encoding: encoded.encoding ?? "raw",
      rawBytes: encoded.rawBytes,
      storedBytes: encoded.storedBytes,
    });
  }

  private async advertiseSettingDelete(path: string, message = "Setting deleted, propagating"): Promise<void> {
    const id = createIdFromString<"SettingUpdate">(
      `setting-del:${path}:${this.deviceId}:${Date.now()}:${Math.random()}`,
    );
    this.evolu.upsert("settingUpdate", {
      id,
      path,
      contentBase64: "",
      contentHash: "DELETED",
      encoding: null,
      type: "delete",
    });
    this.outgoingIds.add(id);
    this.tombstoneSettingSnapshot(path);
    this.logInfo(message, { path });
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
      this.isStopped = true;
      this.stopPollingTimer();
      this.stopRescanTimer();
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
            clearTimeout(st.flushTimer);
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

  /** Updates path policy used by scans, vault events, and remote write/delete handling. */
  updateLocalSyncConfig(config: LocalSyncConfig) {
    this.localSyncConfig = config;
    this.stopRescanTimer();
    this.startRescanTimer();
    this.logInfo("Local sync path policy updated", config);
  }

  /**
   * Resumes remote-history polling.
   *
   * Called when the Obsidian window regains focus (`window focus` or
   * `visibilitychange` → visible). Triggers an immediate poll to catch up on
   * changes received while the engine was inactive.
   */
  async setActive() {
    if (this.isStopped) return;
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
   * @param path The modified vault file path.
   */
  async onVaultFileChanged(path: string) {
    if (this.isStopped) return;
    if (isTrackedSettingPath(path, this.localSyncConfig)) {
      if (this.pendingRemoteSettingWrites.has(path)) {
        this.pendingRemoteSettingWrites.delete(path);
        return;
      }
      const content = await this.vault.readText(path);
      if (content === null) return;
      await this.advertiseSettingContent(path, content, hashText(content), "Setting file changed, propagating");
      return;
    }

    if (!isTrackedVaultPath(path, this.localSyncConfig)) return;

    try {
      const newVaultText = await this.vault.readText(path);
      if (newVaultText === null) return;
      const hadSnapshot = (await this.loadLocalSnapshot(path)) !== null;
      const st = await this.getOrLoadFileState(path);
      this.touch(path, st);

      if (st.ignoreNextVaultModify) {
        st.ignoreNextVaultModify = false;
        st.lastVaultText = newVaultText;
        return;
      }

      let patchResults: boolean[] = [];
      st.doc.transact(() => {
        patchResults = applyRebasedTextChangeToYText(st.text, st.lastVaultText, newVaultText).patchResults;
      });

      if (patchResults.some((ok) => !ok)) {
        this.logWarn("Vault file changed: local patch did not apply cleanly", {
          path,
          patchResults,
        });
      }

      const mergedText = st.text.toString();
      if (mergedText !== newVaultText) {
        this.logInfo("Vault file changed: writing rebased content back to vault", {
          path,
          vaultLen: newVaultText.length,
          mergedLen: mergedText.length,
        });
        st.ignoreNextVaultModify = true;
        await this.vault.writeText(path, mergedText);
      }
      st.lastVaultText = mergedText;
      if (!hadSnapshot && newVaultText.length === 0 && st.pendingUpdates.length === 0) {
        this.logInfo("Vault file changed: advertising empty new file", { path });
        await this.retransmitCurrentState(path);
      }
      // No per-keystroke logs; flush logs happen in flushOutgoingUpdates.
    } catch (e) {
      this.logError("onVaultFileChanged failed", { path, error: e });
    }
  }

  // ---------- polling ----------

  private startPollingTimer() {
    this.pollTimer = setInterval(() => {
      if (this.isActive) void this.pollHistoryOnce();
    }, this.config.historyPollMs);
  }

  private stopPollingTimer() {
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private startRescanTimer() {
    this.stopRescanTimer();

    const vaultIntervalSeconds = this.localSyncConfig.periodicRescanSeconds;
    if (Number.isFinite(vaultIntervalSeconds) && vaultIntervalSeconds > 0) {
      this.vaultRescanTimer = setInterval(() => {
        if (this.isActive) void this.runPeriodicVaultRescan();
      }, vaultIntervalSeconds * 1000);
      this.logInfo("Periodic vault rescan enabled", { intervalSeconds: vaultIntervalSeconds });
    }

    const settingsIntervalSeconds = this.localSyncConfig.settingsRescanSeconds;
    if (
      this.localSyncConfig.syncObsidianSettings &&
      Number.isFinite(settingsIntervalSeconds) &&
      settingsIntervalSeconds > 0
    ) {
      this.settingsRescanTimer = setInterval(() => {
        if (this.isActive) void this.runPeriodicSettingsRescan();
      }, settingsIntervalSeconds * 1000);
      this.logInfo("Periodic settings rescan enabled", { intervalSeconds: settingsIntervalSeconds });
    }
  }

  private stopRescanTimer() {
    if (this.vaultRescanTimer != null) clearInterval(this.vaultRescanTimer);
    if (this.settingsRescanTimer != null) clearInterval(this.settingsRescanTimer);
    this.vaultRescanTimer = null;
    this.settingsRescanTimer = null;
  }

  private async runPeriodicVaultRescan() {
    if (!this.isActive) return;
    this.logInfo("Periodic vault rescan: tick");
    if (this.localSyncConfig.syncDeletes) {
      await this.auditSnapshotsForOfflineDeletes("Periodic vault rescan");
    }
    await this.scanVaultForUnsyncedFiles("Periodic vault rescan");
  }

  private async runPeriodicSettingsRescan() {
    if (!this.isActive || !this.localSyncConfig.syncObsidianSettings) return;
    this.logInfo("Periodic settings rescan: tick");
    if (this.localSyncConfig.syncDeletes) {
      await this.auditSettingSnapshotsForOfflineDeletes("Periodic settings rescan");
    }
    await this.scanSettingsForUnsyncedFiles("Periodic settings rescan");
  }

  private pollHistoryOnce() {
    if (this.isStopped || !this.isActive || this.isPolling) return;
    this.isPolling = true;
    this.ongoingPoll = (async () => {
      try {
        const cursor = await this.loadHistoryCursor();

        // Step 1: Fetch history row IDs in timestamp order.
        // Must use the original "==" operator for evolu_history columns
        // (Evolu's internal convention) and keep the two-step id lookup:
        // evolu_history.id is stored as BLOB, while synced table IDs are TEXT,
        // so a direct JOIN would never match — we convert bytes→string first.
        const histQ = this.evolu.createQuery((db) => {
          let qb = db
            .selectFrom("evolu_history")
            .select(["id", "timestamp", "table"])
            .where("table", "in", ["fileUpdate", "settingUpdate"] as any)
            .where("column", "in", ["updateBase64", "contentBase64"] as any);

          if (cursor != null) qb = qb.where("timestamp", ">", cursor);

          return qb.orderBy("timestamp", "asc").limit(this.config.historyBatchSize);
        });

        const histRows = await this.evolu.loadQuery(histQ);

        if (histRows.length === 0) {
          this.reportSyncProgress?.({
            status: "caught-up",
            message: "LocalSync is caught up.",
          });
          // Deferred vault seeding (relay is quiet).
          if (this.scanComplete) {
            if (!this.pendingVaultSeedReady) {
              this.pendingVaultSeedReady = true;
            } else {
              if (this.pendingSettingSeed.size > 0) {
                await this.repairSettingsFromRemoteState("History quiet settings repair");
              }
              await this.drainPendingVaultSeed();
              await this.drainPendingSettingSeed();
            }
            if (!this.hasLoggedQuietSyncInventory) {
              this.hasLoggedQuietSyncInventory = true;
              const inventory = await this.logSyncInventory("history-quiet");
              await this.repairMissingFileUpdates(inventory.vaultPathsMissingFileUpdate);
            }
          }
          return;
        }

        this.logInfo("History poll fetched rows", { count: histRows.length });
        this.reportSyncProgress?.({
          status: "syncing",
          message: "LocalSync is applying remote changes. Avoid edits until it catches up.",
          current: 0,
          total: histRows.length,
        });

        // Step 2: Convert blob IDs to string IDs and batch-fetch synced rows.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fileUpdateIds = histRows
          .filter((h) => h.table === "fileUpdate")
          .map((h) => idBytesToId(h.id as unknown as IdBytes));
        const settingUpdateIds = histRows
          .filter((h) => h.table === "settingUpdate")
          .map((h) => idBytesToId(h.id as unknown as IdBytes));

        const fileUpdateRows = fileUpdateIds.length === 0
          ? []
          : await this.loadFileUpdateContentRows(fileUpdateIds);
        const rowMap = new Map<string, { path: string; updateBase64: string; type: string | null }>(
          fileUpdateRows
            .filter((r) => r.id && r.path && r.updateBase64)
            .map((r) => [r.id as string, { path: r.path as string, updateBase64: r.updateBase64 as string, type: (r.type as string | null) ?? null }]),
        );
        const settingRows = await this.loadSettingUpdateRows(settingUpdateIds);
        const settingRowMap = new Map<string, SettingUpdateRow>(
          settingRows.map((row) => [row.id, row]),
        );

        // Step 3: Look-ahead — for each path, record the index of its LAST
        // delete row in the batch.  Content writes are skipped only when a
        // delete appears at a LATER index (avoids suppressing writes for files
        // that were deleted and then re-created in the same batch).
        const lastDeleteIdx = new Map<string, number>();
        histRows.forEach((h, idx) => {
          const r = rowMap.get(idBytesToId(h.id as unknown as IdBytes));
          if (r?.type === "delete") lastDeleteIdx.set(r.path, idx);
        });

        // Step 4: Process rows in timestamp order.
        const touchedPaths = new Set<string>();
        let lastHandledTimestamp: TimestampBytes | null = null;
        let stoppedAtMissingRow = false;

        for (const [rowIdx, h] of histRows.entries()) {
          const id = idBytesToId(h.id as unknown as IdBytes);
          const timestamp = h.timestamp as unknown as TimestampBytes;
          const current = rowIdx + 1;

          // Skip rows we produced ourselves in this session.
          if (this.outgoingIds.has(id)) {
            this.logInfo("Skipped own history row", { id, table: h.table });
            lastHandledTimestamp = timestamp;
            this.reportSyncProgress?.({
              status: "syncing",
              message: "LocalSync is applying remote changes. Avoid edits until it catches up.",
              current,
              total: histRows.length,
            });
            continue;
          }

          if (h.table === "settingUpdate") {
            const setting = settingRowMap.get(id);
            if (!setting) {
              this.logWarn("History referenced missing settingUpdate row; cursor not advanced past it", { id });
              stoppedAtMissingRow = true;
              break;
            }

            const applied = await this.applyRemoteSettingUpdate(setting);
            if (!applied) {
              this.logWarn("Remote setting update failed; cursor not advanced past it", { id, path: setting.path });
              stoppedAtMissingRow = true;
              break;
            }
            touchedPaths.add(setting.path);
            if (this.pendingSettingSeed.delete(setting.path)) {
              this.logInfo("Deferred settings seed: remote history covered setting", { path: setting.path });
            }
            lastHandledTimestamp = timestamp;
            this.reportSyncProgress?.({
              status: "syncing",
              message: "LocalSync is applying remote changes. Avoid edits until it catches up.",
              current,
              total: histRows.length,
            });
            continue;
          }

          const r = rowMap.get(id);
          if (!r) {
            this.logWarn("History referenced missing fileUpdate row; cursor not advanced past it", { id });
            stoppedAtMissingRow = true;
            break;
          }

          const { path, updateBase64, type } = r;

          // ── Delete row ──────────────────────────────────────────────────
          if (type === "delete") {
            this.destroyDoc(path);
            this.pendingVaultSeed.delete(path);
            this.tombstoneSnapshot(path);
            if (await this.vault.fileExists(path)) {
              this.pendingRemoteDeletes.add(path);
              try {
                await this.vault.deleteFile(path);
              } finally {
                this.pendingRemoteDeletes.delete(path);
              }
            }
            this.logInfo("Applied remote delete", { path });
            touchedPaths.add(path);
            lastHandledTimestamp = timestamp;
            this.reportSyncProgress?.({
              status: "syncing",
              message: "LocalSync is applying remote changes. Avoid edits until it catches up.",
              current,
              total: histRows.length,
            });
            continue;
          }

          // ── Content update ───────────────────────────────────────────────
          // Skip our own startup-retransmit rows from previous sessions.
          // outgoingIds only covers the current session; retransmit rows use a
          // deterministic ID that persists across restarts.
          const myRetransmitId = createIdFromString<"FileUpdate">(
            `startup-retransmit:${path}:${this.deviceId}`,
          );
          if (id === myRetransmitId) {
            this.logInfo("Skipped own startup-retransmit row", { path });
            lastHandledTimestamp = timestamp;
            this.reportSyncProgress?.({
              status: "syncing",
              message: "LocalSync is applying remote changes. Avoid edits until it catches up.",
              current,
              total: histRows.length,
            });
            continue;
          }

          const st = await this.getOrLoadFileState(path, { seedFromVault: false });
          this.touch(path, st);

          // Pass "remote" as origin so doc.on("update") skips re-queuing this
          // for outgoing transmission (echo-loop prevention).
          Y.applyUpdate(st.doc, fromBase64(updateBase64), "remote");

          this.logInfo("Applied remote update", {
            path,
            yjsTextLength: st.text.toString().length,
            lastVaultTextLength: st.lastVaultText.length,
          });

          if ((lastDeleteIdx.get(path) ?? -1) > rowIdx) {
            // A delete for this path appears at a later position in the batch —
            // skip the vault write to avoid the Obsidian metadata-race (ARCH-2).
            this.logInfo("Skipping vault write, delete follows in batch", { path });
          } else {
            const written = await this.writeYjsToVault(path, st);
            if (!written) {
              this.logWarn("Remote file update failed to write to vault; cursor not advanced past it", { id, path });
              stoppedAtMissingRow = true;
              break;
            }
          }

          touchedPaths.add(path);
          if (this.pendingVaultSeed.delete(path)) {
            this.logInfo("Deferred seed: remote history covered file", { path });
          }
          lastHandledTimestamp = timestamp;
          this.reportSyncProgress?.({
            status: "syncing",
            message: "LocalSync is applying remote changes. Avoid edits until it catches up.",
            current,
            total: histRows.length,
          });
        }

        // Save one snapshot per touched file rather than one per update row.
        for (const p of touchedPaths) {
          const st = this.states.get(p);
          if (st) await this.saveLocalSnapshot(p, st);
        }

        if (lastHandledTimestamp != null) {
          await this.saveHistoryCursor(lastHandledTimestamp);
        }
        if (stoppedAtMissingRow) {
          this.reportSyncProgress?.({
            status: "blocked",
            message: "LocalSync paused: a remote row could not be applied. Check console before editing.",
          });
          return;
        }

        // Deferred vault seeding: drain only when the relay is quiet.
        if (this.scanComplete) {
          if (!this.pendingVaultSeedReady) {
            this.pendingVaultSeedReady = true;
          }
          // (rows.length > 0, so we don't drain this cycle)
        }
      } catch (e) {
        this.logError("pollHistoryOnce failed", e);
      } finally {
        this.isPolling = false;
      }
    })();
  }

  // ---------- LRU ----------

  private touch(path: string, st: FileState) {
    // Re-insert at end of Map so iteration order = LRU → MRU.
    this.states.delete(path);
    this.states.set(path, st);
  }

  private async enforceLruLimit() {
    while (this.states.size > this.config.maxOpenDocs) {
      // First entry is the least-recently-used.
      const oldestPath = this.states.keys().next().value as string | undefined;
      if (!oldestPath) return;

      const closed = await this.closeDoc(oldestPath);
      if (!closed) return;
      this.states.delete(oldestPath);
      this.logDebug("LRU evicted doc", { path: oldestPath, openDocs: this.states.size });
    }
  }

  private async closeDoc(path: string): Promise<boolean> {
    const st = this.states.get(path);
    if (!st) return true;

    try {
      if (st.flushTimer != null) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }

      const flushed = await this.flushOutgoingUpdates(path, st);
      if (!flushed) {
        this.logWarn("closeDoc: skipping snapshot after failed outgoing flush", { path });
        return false;
      }

      await this.saveLocalSnapshot(path, st);

      st.doc.destroy();
      return true;
    } catch (e) {
      this.logError("closeDoc failed", { path, error: e });
      return false;
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
      clearTimeout(st.flushTimer);
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

  private async logSyncInventory(
    stage: string,
    trackedFiles?: VaultFile[],
  ): Promise<SyncInventory> {
    try {
      const files =
        trackedFiles ??
        (await this.vault.listFiles()).filter((file) =>
          isTrackedVaultFile(file, this.localSyncConfig),
        );
      const vaultPaths = new Set(files.map((file) => file.path));

      const snapshotQ = this.evolu.createQuery((db) =>
        db
          .selectFrom("_fileSnapshot")
          .select(["path", "snapshotBase64"])
          .where("isDeleted", "is", null),
      );
      const snapshotRows = await this.evolu.loadQuery(snapshotQ);
      const snapshotPaths = new Set<string>();
      const tombstonePaths = new Set<string>();
      for (const row of snapshotRows) {
        if (!row.path) continue;
        if (row.snapshotBase64 === "DELETED") {
          tombstonePaths.add(row.path);
        } else {
          snapshotPaths.add(row.path);
        }
      }

      // fileUpdate rows are the sync-history representation that other peers
      // can learn from once Evolu has replicated them. _fileSnapshot rows are
      // local-only cache and must be counted separately.
      const historyQ = this.evolu.createQuery((db) =>
        db
          .selectFrom("evolu_history")
          .select(["id", "timestamp"])
          .where("table", "==", "fileUpdate")
          .where("column", "==", "updateBase64")
          .orderBy("timestamp", "asc")
          .limit(100000),
      );
      const historyRows = await this.evolu.loadQuery(historyQ);
      const ids = historyRows.map((row) => idBytesToId(row.id as unknown as IdBytes));
      const fileUpdateRows = await this.loadFileUpdateRows(ids);
      const rowsById = new Map(
        fileUpdateRows
          .filter((row) => row.id && row.path)
          .map((row) => [
            row.id,
            { path: row.path, type: row.type ?? null },
          ]),
      );

      const latestTypeByPath = new Map<string, string | null>();
      let visibleHistoryRows = 0;
      for (const row of historyRows) {
        const id = idBytesToId(row.id as unknown as IdBytes);
        const fileUpdate = rowsById.get(id);
        if (!fileUpdate) continue;
        visibleHistoryRows++;
        latestTypeByPath.set(fileUpdate.path, fileUpdate.type);
      }

      const fileUpdatePaths = new Set(latestTypeByPath.keys());
      const fileUpdatePresentPaths = new Set(
        Array.from(latestTypeByPath.entries())
          .filter(([, type]) => type !== "delete")
          .map(([path]) => path),
      );
      const fileUpdateDeletedPaths = new Set(
        Array.from(latestTypeByPath.entries())
          .filter(([, type]) => type === "delete")
          .map(([path]) => path),
      );

      const missingFileUpdatePaths = Array.from(vaultPaths)
        .filter((path) => !fileUpdatePresentPaths.has(path))
        .sort();
      const snapshotOnlyPaths = Array.from(snapshotPaths)
        .filter((path) => !fileUpdatePresentPaths.has(path))
        .sort();

      this.logInfo("Sync inventory", {
        stage,
        vaultTrackedFiles: vaultPaths.size,
        localSnapshotPaths: snapshotPaths.size,
        localSnapshotTombstones: tombstonePaths.size,
        fileUpdateHistoryRows: historyRows.length,
        visibleFileUpdateRows: visibleHistoryRows,
        fileUpdatePaths: fileUpdatePaths.size,
        fileUpdatePresentPaths: fileUpdatePresentPaths.size,
        fileUpdateDeletedPaths: fileUpdateDeletedPaths.size,
        vaultPathsMissingFileUpdate: missingFileUpdatePaths.length,
        snapshotPathsMissingFileUpdate: snapshotOnlyPaths.length,
        sampleVaultPathsMissingFileUpdate: missingFileUpdatePaths.slice(0, 20),
        sampleSnapshotPathsMissingFileUpdate: snapshotOnlyPaths.slice(0, 20),
      });
      return {
        vaultPathsMissingFileUpdate: missingFileUpdatePaths,
        snapshotPathsMissingFileUpdate: snapshotOnlyPaths,
      };
    } catch (e) {
      this.logError("logSyncInventory failed", { stage, error: e });
      return { vaultPathsMissingFileUpdate: [], snapshotPathsMissingFileUpdate: [] };
    }
  }

  private async repairMissingFileUpdates(paths: string[]) {
    if (paths.length === 0) return;

    this.logInfo("Sync inventory repair: retransmitting missing fileUpdate paths", {
      count: paths.length,
      sample: paths.slice(0, 20),
    });

    let repaired = 0;
    for (const path of paths) {
      if (!this.isActive) break;
      if (!(await this.vault.fileExists(path))) continue;
      if (!isTrackedVaultPath(path, this.localSyncConfig)) continue;

      const ok = await this.retransmitCurrentState(path);
      if (ok) repaired++;
    }

    this.logInfo("Sync inventory repair: done", {
      requested: paths.length,
      repaired,
    });
  }

  private async repairSettingsFromRemoteState(label: string) {
    if (!this.localSyncConfig.syncObsidianSettings) return;

    try {
      const remoteSettings = await this.loadLatestSettingUpdatesFromHistory();
      if (remoteSettings.size === 0) {
        this.logInfo(label, { remoteSettings: 0, applied: 0, unchanged: 0, skipped: 0 });
        return;
      }

      let applied = 0;
      let unchanged = 0;
      let skipped = 0;

      for (const [path, remote] of remoteSettings) {
        if (!isTrackedSettingPath(path, this.localSyncConfig)) {
          skipped++;
          continue;
        }

        const snapshot = await this.loadSettingSnapshot(path);
        if (remote.type === "delete") {
          const exists = await this.vault.fileExists(path);
          if (snapshot?.deleted && !exists) {
            this.pendingSettingSeed.delete(path);
            unchanged++;
            continue;
          }

          await this.applyRemoteSettingUpdate(remote);
          applied++;
          continue;
        }

        const current = await this.vault.readText(path);
        const currentHash = current === null ? null : hashText(current);
        const currentMatches = currentHash === remote.contentHash;
        if (snapshot?.contentHash === remote.contentHash && currentHash !== null && currentHash !== remote.contentHash) {
          // We have already seen this remote setting state, but the local file
          // has changed since our last local snapshot. Do not repair it back to
          // the old remote value; the following settings scan will advertise
          // the local change instead.
          this.logInfo(`${label}: keeping local setting change`, {
            path,
            snapshotHash: snapshot.contentHash,
            remoteHash: remote.contentHash,
            currentHash,
          });
          unchanged++;
          continue;
        }

        if (snapshot?.contentHash === remote.contentHash && currentMatches) {
          this.pendingSettingSeed.delete(path);
          unchanged++;
          continue;
        }

        await this.applyRemoteSettingUpdate(remote);
        applied++;
      }

      this.logInfo(label, {
        remoteSettings: remoteSettings.size,
        applied,
        unchanged,
        skipped,
      });
    } catch (e) {
      this.logError(`${label}: repairSettingsFromRemoteState failed`, e);
    }
  }

  private async loadLatestSettingUpdatesFromHistory(): Promise<Map<string, SettingUpdateWithId>> {
    const historyQ = this.evolu.createQuery((db) =>
      db
        .selectFrom("evolu_history")
        .select(["id", "timestamp"])
        .where("table", "==", "settingUpdate")
        .where("column", "==", "contentBase64")
        .orderBy("timestamp", "asc")
        .limit(100000),
    );
    const historyRows = await this.evolu.loadQuery(historyQ);
    if (historyRows.length === 0) return new Map();

    const ids = historyRows.map((row) => idBytesToId(row.id as unknown as IdBytes));
    const settingRows = await this.loadSettingUpdateRows(ids);
    const rowsById = new Map(settingRows.map((row) => [row.id, row]));
    const latestByPath = new Map<string, SettingUpdateWithId>();

    for (const historyRow of historyRows) {
      const id = idBytesToId(historyRow.id as unknown as IdBytes);
      const setting = rowsById.get(id);
      if (!setting) continue;
      latestByPath.set(setting.path, setting);
    }

    return latestByPath;
  }

  private async loadFileUpdateContentRows(ids: string[]) {
    if (ids.length === 0) return [];

    const fileUpdateQ = this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("fileUpdate")
        .select(["id", "path", "updateBase64", "type"])
        .where("id", "in", ids as any)
        .where("isDeleted", "is", null),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await this.evolu.loadQuery(fileUpdateQ)) as ReadonlyArray<any>;
  }

  private async loadSettingUpdateRows(ids: string[]): Promise<Array<SettingUpdateRow & { id: string }>> {
    const rows: Array<SettingUpdateRow & { id: string }> = [];
    const batchSize = 500;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      if (batch.length === 0) continue;

      const settingUpdateQ = this.evolu.createQuery((db) =>
        (db as any)
          .selectFrom("settingUpdate")
          .select(["id", "path", "contentBase64", "contentHash", "encoding", "type"])
          .where("id", "in", batch as any)
          .where("isDeleted", "is", null),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batchRows = (await this.evolu.loadQuery(settingUpdateQ)) as ReadonlyArray<any>;
      rows.push(
        ...batchRows
          .filter((row) => row.id && row.path && row.contentHash)
          .map((row) => ({
            id: row.id as string,
            path: row.path as string,
            contentBase64: (row.contentBase64 as string | null) ?? "",
            contentHash: row.contentHash as string,
            encoding: (row.encoding as string | null) ?? null,
            type: (row.type as string | null) ?? null,
          })),
      );
    }

    return rows;
  }

  private async applyRemoteSettingUpdate(row: SettingUpdateRow): Promise<boolean> {
    const path = row.path;
    try {
      if (!isTrackedSettingPath(path, this.localSyncConfig)) {
        this.logInfo("Skipped remote setting update, path not tracked", { path });
        return true;
      }

      if (row.type === "delete") {
        this.pendingSettingSeed.delete(path);
        this.tombstoneSettingSnapshot(path);
        if (await this.vault.fileExists(path)) {
          this.pendingRemoteSettingDeletes.add(path);
          try {
            await this.vault.deleteFile(path);
          } finally {
            this.pendingRemoteSettingDeletes.delete(path);
          }
        }
        this.logInfo("Applied remote setting delete", { path });
        return true;
      }

      const content = await decodeSettingContent(row);
      const current = await this.vault.readText(path);
      if (current !== content) {
        this.pendingRemoteSettingWrites.add(path);
        try {
          await this.vault.writeText(path, content);
        } finally {
          this.pendingRemoteSettingWrites.delete(path);
        }
      }
      this.saveSettingSnapshot(path, row.contentHash);
      this.logInfo("Applied remote setting update", {
        path,
        chars: content.length,
        contentHash: row.contentHash,
        encoding: row.encoding ?? "raw",
        changed: current !== content,
      });
      return true;
    } catch (error) {
      this.pendingRemoteSettingWrites.delete(path);
      this.pendingRemoteSettingDeletes.delete(path);
      this.logError("applyRemoteSettingUpdate failed", { path, type: row.type, error });
      return false;
    }
  }

  private async loadFileUpdateRows(ids: string[]) {
    const rows: Array<{ id: string; path: string; type: string | null }> = [];
    const batchSize = 500;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      if (batch.length === 0) continue;
      const fileUpdateQ = this.evolu.createQuery((db) =>
        (db as any)
          .selectFrom("fileUpdate")
          .select(["id", "path", "type"])
          .where("id", "in", batch as any)
          .where("isDeleted", "is", null),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batchRows = (await this.evolu.loadQuery(fileUpdateQ)) as ReadonlyArray<any>;
      rows.push(
        ...batchRows
          .filter((row) => row.id && row.path)
          .map((row) => ({
            id: row.id as string,
            path: row.path as string,
            type: (row.type as string | null) ?? null,
          })),
      );
    }
    return rows;
  }

  private async saveHistoryCursor(ts: TimestampBytes) {
    const cursorId = createIdFromString<"HistoryCursor">("history-cursor");
    this.evolu.upsert("_historyCursor", { id: cursorId, lastTimestamp: ts });
  }

  // ---------- setting snapshots ----------

  private async loadSettingSnapshot(path: string): Promise<SettingSnapshot | null> {
    const id = createIdFromString<"SettingSnapshot">(`setting-snapshot:${path}`);

    const q = this.evolu.createQuery((db) =>
      db
        .selectFrom("_settingSnapshot")
        .select(["contentHash"])
        .where("id", "=", id)
        .where("isDeleted", "is", null)
        .limit(1),
    );

    const rows = await this.evolu.loadQuery(q);
    if (rows.length === 0) return null;
    const contentHash = rows[0].contentHash;
    if (!contentHash) return null;
    return { contentHash, deleted: contentHash === "DELETED" };
  }

  private saveSettingSnapshot(path: string, contentHash: string) {
    const id = createIdFromString<"SettingSnapshot">(`setting-snapshot:${path}`);
    this.evolu.upsert("_settingSnapshot", { id, path, contentHash });
  }

  private tombstoneSettingSnapshot(path: string) {
    this.saveSettingSnapshot(path, "DELETED");
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

    const lastVaultText = (await this.vault.readText(path)) ?? "";

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
          applyRebasedTextChangeToYText(text, yjsText, lastVaultText);
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

  private async writeYjsToVault(path: string, st: FileState): Promise<boolean> {
    try {
      const newText = st.text.toString();
      this.logInfo("writeYjsToVault: enter", {
        path,
        newTextLen: newText.length,
        lastVaultTextLen: st.lastVaultText.length,
        unchanged: newText === st.lastVaultText,
      });

      const fileFound = await this.vault.fileExists(path);
      this.logInfo("writeYjsToVault: vault lookup", { path, fileFound });

      if (!fileFound) {
        // Create parent folder(s) if the path contains a directory component
        // that doesn't exist on this device yet.
        const slashIdx = path.lastIndexOf("/");
        if (slashIdx > 0) {
          const folderPath = path.substring(0, slashIdx);
          this.logInfo("writeYjsToVault: ensuring folder", { folderPath });
          await this.vault.ensureFolder(folderPath);
        }

        this.logInfo("writeYjsToVault: creating file", { path, chars: newText.length });
        await this.vault.writeText(path, newText);
        st.lastVaultText = newText;
        this.logInfo("writeYjsToVault: file created", { path });
        return true;
      }

      if (newText === st.lastVaultText) {
        this.logInfo("writeYjsToVault: no change, skipping", { path });
        return true;
      }

      this.logInfo("writeYjsToVault: modifying file", { path, chars: newText.length });
      st.ignoreNextVaultModify = true;
      await this.vault.writeText(path, newText);
      st.lastVaultText = newText;
      return true;
    } catch (e) {
      this.logError("writeYjsToVault failed", { path, error: e });
      return false;
    }
  }

  // ---------- outgoing batching ----------

  private scheduleOutgoingFlush(path: string, st: FileState) {
    if (st.flushTimer != null) return;

    st.flushTimer = setTimeout(async () => {
      st.flushTimer = null;
      await this.flushOutgoingUpdates(path, st);
    }, this.config.outgoingBatchMs);
  }

  private async flushOutgoingUpdates(path: string, st: FileState): Promise<boolean> {
    try {
      if (st.pendingUpdates.length === 0) return true;

      const merged = Y.mergeUpdates(st.pendingUpdates);

      const updateBase64 = toBase64(merged);
      const id = createIdFromString<"FileUpdate">(
        `upd:${path}:${this.deviceId}:${Date.now()}:${Math.random()}`,
      );

      this.evolu.upsert("fileUpdate", { id, path, updateBase64 });
      this.outgoingIds.add(id);
      st.pendingUpdates = [];

      this.logInfo("Sent outgoing update", { path, bytes: merged.length });

      await this.saveLocalSnapshot(path, st);
      return true;
    } catch (e) {
      this.logError("flushOutgoingUpdates failed", { path, error: e });
      return false;
    }
  }

  // ---------- delete / rename handlers ----------

  /**
   * Called when the vault fires a `"delete"` event for a tracked file.
   *
   * Destroys the in-memory Yjs doc, tombstones the snapshot so the path is
   * treated as fresh if re-created, and emits a `fileUpdate { type: "delete" }`
   * row so other devices trash the file.
   */
  async onVaultFileDeleted(path: string) {
    if (this.isStopped) return;
    if (isTrackedSettingPath(path, this.localSyncConfig)) {
      if (this.pendingRemoteSettingDeletes.has(path)) return;
      if (!this.localSyncConfig.syncDeletes) return;
      await this.advertiseSettingDelete(path);
      return;
    }

    if (!isTrackedVaultPath(path, this.localSyncConfig)) return;
    if (this.pendingRemoteDeletes.has(path)) return; // remote-initiated trash — suppress echo
    if (!this.localSyncConfig.syncDeletes) return;
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
   * Called when the vault fires a `"rename"` event for a tracked file.
   *
   * Propagated as a delete of the old path + a full-state retransmit of the
   * new path.  The in-memory doc state is re-keyed to the new path so edits
   * made immediately after the rename are diff'd against the correct baseline.
   */
  async onVaultFileRenamed(oldPath: string, newPath: string) {
    if (this.isStopped) return;
    if (
      isTrackedSettingPath(oldPath, this.localSyncConfig) ||
      isTrackedSettingPath(newPath, this.localSyncConfig)
    ) {
      if (!this.localSyncConfig.syncDeletes) return;
      try {
        if (isTrackedSettingPath(oldPath, this.localSyncConfig)) {
          await this.advertiseSettingDelete(oldPath, "Setting file renamed, deleting old path");
        }
        if (isTrackedSettingPath(newPath, this.localSyncConfig)) {
          const content = await this.vault.readText(newPath);
          if (content !== null) {
            await this.advertiseSettingContent(newPath, content, hashText(content), "Setting file renamed, advertising new path");
          }
        }
      } catch (e) {
        this.logError("onVaultFileRenamed setting handling failed", { oldPath, newPath, error: e });
      }
      return;
    }

    if (
      !isTrackedVaultPath(oldPath, this.localSyncConfig) &&
      !isTrackedVaultPath(newPath, this.localSyncConfig)
    ) {
      return;
    }
    if (!this.localSyncConfig.syncDeletes) return;
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
  private async auditSnapshotsForOfflineDeletes(label = "Startup scan") {
    if (this.isStopped) return;
    if (!this.localSyncConfig.syncDeletes) return;

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
        (await this.vault.listFiles())
          .filter((f) => isTrackedVaultFile(f, this.localSyncConfig))
          .map((f) => f.path),
      );

      let audited = 0;
      for (const row of rows) {
        if (this.isStopped) return;
        const path = row.path;
        if (!path) continue;
        // Skip already-tombstoned snapshots.
        if (row.snapshotBase64 === "DELETED") continue;
        // If the file still exists in the vault, nothing to do.
        if (vaultPaths.has(path)) continue;

        this.logInfo(`${label}: offline delete detected`, { path });
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
        this.logInfo(`${label}: offline delete audit done`, { offlineDeletes: audited });
      }
    } catch (e) {
      this.logError(`${label}: auditSnapshotsForOfflineDeletes failed`, e);
    }
  }

  private async auditSettingSnapshotsForOfflineDeletes(label = "Startup settings scan") {
    if (this.isStopped) return;
    if (!this.localSyncConfig.syncObsidianSettings || !this.localSyncConfig.syncDeletes) return;

    try {
      const q = this.evolu.createQuery((db) =>
        db
          .selectFrom("_settingSnapshot")
          .select(["path", "contentHash"])
          .where("isDeleted", "is", null),
      );
      const rows = await this.evolu.loadQuery(q);
      if (rows.length === 0) return;

      const settingPaths = new Set(await this.listTrackedSettingPaths());

      let audited = 0;
      for (const row of rows) {
        if (this.isStopped) return;
        const path = row.path;
        if (!path || !isTrackedSettingPath(path, this.localSyncConfig)) continue;
        if (row.contentHash === "DELETED") continue;
        if (settingPaths.has(path)) continue;

        this.pendingSettingSeed.delete(path);
        await this.advertiseSettingDelete(path, `${label}: offline setting delete detected`);
        audited++;
      }

      if (audited > 0) {
        this.logInfo(`${label}: offline setting delete audit done`, { offlineDeletes: audited });
      }
    } catch (e) {
      this.logError(`${label}: auditSettingSnapshotsForOfflineDeletes failed`, e);
    }
  }
}
