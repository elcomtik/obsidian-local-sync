import * as Y from "yjs";
import DiffMatchPatch from "diff-match-patch";
import type { Evolu } from "@evolu/common";
import { createIdFromString } from "@evolu/common";
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

export const DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES = 100;
export const DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS = 10_000;
export const DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS = 60_000;

/**
 * Runtime configuration for {@link YjsEvoluHistoryEngine}.
 * All values are hot-swappable via {@link YjsEvoluHistoryEngine.updateConfig}.
 */
export type EngineConfig = {
  /** Milliseconds between quiet-cycle checks and failed-inbox retries. */
  historyPollMs: number;
  /** Maximum pending incoming rows exposed by each subscribed inbox query. */
  historyBatchSize: number;
  /** Debounce window (ms) before flushing accumulated Yjs updates to Evolu. */
  outgoingBatchMs: number;
  /** Maximum simultaneously open Yjs docs; least-recently-used are evicted above this limit. */
  maxOpenDocs: number;
  /** Debug scan progress heartbeat by processed tracked files. Set to 0 to disable file-count progress. */
  vaultScanDebugProgressEveryFiles: number;
  /** Debug scan progress heartbeat by elapsed milliseconds. Set to 0 to disable time-based debug progress. */
  vaultScanDebugProgressEveryMs: number;
  /** Info scan progress heartbeat by elapsed milliseconds. Set to 0 to disable info progress. */
  vaultScanInfoProgressEveryMs: number;
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

export type ReconcileResult = "loaded" | "unchanged" | "deferred" | "skipped";

export type MaterializationRepairStats = {
  planned: number;
  written: number;
  deleted: number;
  unchanged: number;
  skippedLocalDrift: number;
  failed: number;
};

export type MaterializationRepairResult = {
  files: MaterializationRepairStats;
  settings: MaterializationRepairStats;
};

type MaterializationOutcome =
  | "written"
  | "deleted"
  | "unchanged"
  | "skipped-local-drift"
  | "failed";

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

function hashTextToClientId(text: string): number {
  const id = Number.parseInt(hashText(text).slice(0, 8), 16) >>> 0;
  return id === 0 ? 1 : id;
}

function getLocalSyncOutgoingId(origin: unknown): string | null {
  if (!origin || typeof origin !== "object") return null;
  const id = (origin as { localSyncOutgoingId?: unknown }).localSyncOutgoingId;
  return typeof id === "string" && id.length > 0 ? id : null;
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
  path: string;
  doc: Y.Doc;
  text: Y.Text;

  // last text seen in vault file (for diffing)
  lastVaultText: string;

  // ignore one modify event to prevent loop (remote write -> vault modify)
  ignoreNextVaultModify: boolean;

  // outgoing update batching
  pendingUpdates: Uint8Array[];
  pendingOutgoingId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;

};

type FileSnapshot = {
  snapshotBase64: string;
  contentHash: string | null;
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

type PendingFileUpdateRow = {
  id: string;
  path: string;
  updateBase64: string;
  type: string | null;
  createdAt: string;
  sourceVersion: string;
};

type PendingSettingUpdateRow = SettingUpdateWithId & {
  createdAt: string;
  sourceVersion: string;
};

function compareUpdateOrder(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  const timestampOrder = left.createdAt.localeCompare(right.createdAt);
  return timestampOrder !== 0 ? timestampOrder : left.id.localeCompare(right.id);
}

type FileMaterializationPlan = {
  path: string;
  ids: string[];
  signature: string;
  latestType: string | null;
};

type SettingMaterializationPlan = {
  path: string;
  id: string;
  signature: string;
  row: SettingUpdateWithId;
};

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
 * Pending-only subscribed queries expose rows that do not yet have a durable
 * local processed marker. File updates are applied incrementally to snapshots;
 * full-history reconstruction is reserved for manual repair.
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
  private persistLocalDb?: () => Promise<void>;

  private states = new Map<string, FileState>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private vaultRescanTimer: ReturnType<typeof setInterval> | null = null;
  private settingsRescanTimer: ReturnType<typeof setInterval> | null = null;
  private isScanningVault = false;
  private isScanningSettings = false;
  private isStopped = false;
  private unsubscribers: Array<() => void> = [];
  /** Resolves when current inbox/manual-repair work completes. Awaited by stop(). */
  private ongoingPoll: Promise<void> = Promise.resolve();

  // Only process remote history when Obsidian is active
  private isActive = true;

  /**
   * Paths of vault files that the startup scan identified as having no local
   * snapshot (never seeded) but that are NOT immediately seeded from vault.
   *
   * Seeding is deferred by one quiet inbox cycle so the relay has time
   * to deliver any existing synced rows for these files before we create a new
   * Yjs state.
   * Without this, a reset & restore could seed vault content into an empty doc
   * and later materialize remote rows on top of it, doubling content.
   *
   * Files are removed from this set as soon as materialized remote state covers
   * them. The remaining files are seeded from vault after one full quiet cycle
   * once the incoming inbox has no pending work.
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
   * populating {@link pendingVaultSeed}. Until this is true the quiet cycle
   * will not attempt to drain the set (it might not be fully populated yet).
   */
  private scanComplete = false;

  /**
   * Becomes `true` after the first quiet cycle that runs *after* the scan is
   * complete (`scanComplete === true`). Seeding from {@link pendingVaultSeed}
   * is only allowed once this is true and the inbox has no queued work.
   */
  private pendingVaultSeedReady = false;

  private pendingFileInbox = new Map<string, PendingFileUpdateRow>();
  private pendingSettingInbox = new Map<string, PendingSettingUpdateRow>();
  private inboxProgressKeys = new Set<string>();
  private inboxProgressDiscovered = 0;
  private inboxProgressApplied = 0;
  private inboxProgressTotal: number | null = null;
  private inboxProgressTotalPromise: Promise<void> | null = null;
  private inboxQuietTicks = 0;
  private fileInboxRunning = false;
  private settingInboxRunning = false;
  private fileInboxInitialized = false;
  private settingInboxInitialized = false;
  private fileInboxPageSaturated = false;
  private settingInboxPageSaturated = false;
  private startupPathsReady = false;
  private startupUnscannedPaths = new Set<string>();

  // Full-history materializers are used only by the manual repair action.
  private fileMaterializerRunning = false;
  private settingMaterializerRunning = false;
  private fileMaterializationBlockedSignatures = new Map<string, string>();

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
    persistLocalDb?: () => Promise<void>;
  }) {
    this.vault = args.vault;
    this.evolu = args.evolu;
    this.deviceId = args.deviceId;
    this.config = args.config;
    this.localSyncConfig = args.localSyncConfig ?? DEFAULT_LOCAL_SYNC_CONFIG;
    this.logLevel = args.logLevel;
    this.formatLogLine = args.logFormatter ?? formatLogLine;
    this.reportSyncProgress = args.reportSyncProgress;
    this.persistLocalDb = args.persistLocalDb;
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
   * Initialises the engine: subscribes to synced tables, starts the quiet timer,
   * and scans local vault state.
   *
   * Safe to call only once per engine instance.
   */
  async start() {
    try {
      this.isStopped = false;
      await this.initializeIncrementalInbox();
      this.startInboxSubscriptions();
      this.startPollingTimer();
      this.startRescanTimer();
      this.logInfo("Engine started", this.config);
      // Kick off the audit and scans concurrently.
      // - auditSnapshotsForOfflineDeletes: detects files deleted/renamed while plugin was off.
      // - scanVaultForUnsyncedFiles: populates pendingVaultSeed (no Yjs mutations).
      // - inbox subscriptions: relay delivery; deferred seeding runs after the
      //   incoming inbox has observed a quiet cycle.
      if (this.localSyncConfig.startupScan) {
        void this.auditSnapshotsForOfflineDeletes("Startup scan");
        void this.scanVaultForUnsyncedFiles("Startup scan");
        void this.auditSettingSnapshotsForOfflineDeletes("Startup settings scan");
        void this.scanSettingsForUnsyncedFiles("Startup settings scan");
      } else {
        this.scanComplete = true;
        this.startupPathsReady = true;
        this.kickIncrementalInboxes();
      }
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
          if (this.logLevel === "debug") this.logDebug(`${label}: skipped file`, {
            path: file.path,
            reason: decision.reason,
            extension: key,
          });
        } else {
          skippedByRule.set(decision.rule, (skippedByRule.get(decision.rule) ?? 0) + 1);
          if (this.logLevel === "debug") this.logDebug(`${label}: skipped file`, {
            path: file.path,
            reason: decision.reason,
            rule: decision.rule,
          });
        }
      }

      if (label === "Startup scan") {
        this.startupUnscannedPaths = new Set(files.map((file) => file.path));
        this.startupPathsReady = true;
        this.kickIncrementalInboxes();
      }

      this.logInfo(`${label}: begin`, {
        adapterFiles: allFiles.length,
        trackedFiles: files.length,
        skippedByExtension: Object.fromEntries(skippedByExtension),
        skippedByRule: Object.fromEntries(skippedByRule),
      });
      const reportUiProgress = label === "Startup scan" || label === "Manual vault scan";
      if (reportUiProgress) {
        this.reportSyncProgress?.({
          status: "syncing",
          message: "LocalSync is checking local files.",
          current: 0,
          total: files.length,
        });
      }
      let loaded = 0;
      let unchanged = 0;
      let deferred = 0;
      let processed = 0;
      const scanStartedAt = Date.now();
      let lastProgressAt = scanStartedAt;
      let lastInfoProgressAt = scanStartedAt;
      let lastUiProgressAt = scanStartedAt;

      for (const file of files) {
        if (!this.isActive || this.isStopped) break;
        const result = await this.reconcileVaultFile(file.path, label);
        processed++;

        if (result === "deferred") {
          deferred++;
        } else if (result === "loaded") {
          loaded++;
          if (label === "Startup scan") {
            await this.closeDoc(file.path);
            this.states.delete(file.path);
          }
        } else if (result === "unchanged") {
          unchanged++;
        }
        if (label === "Startup scan") {
          this.startupUnscannedPaths.delete(file.path);
          this.kickIncrementalInboxes();
        }

        const now = Date.now();
        if (reportUiProgress && (processed === files.length || now - lastUiProgressAt >= 250)) {
          lastUiProgressAt = now;
          this.reportSyncProgress?.({
            status: "syncing",
            message: "LocalSync is checking local files.",
            current: processed,
            total: files.length,
          });
        }
        const shouldLogDebugProgress =
          this.logLevel === "debug" &&
          (processed === files.length ||
            (this.config.vaultScanDebugProgressEveryFiles > 0 &&
              processed % this.config.vaultScanDebugProgressEveryFiles === 0) ||
            (this.config.vaultScanDebugProgressEveryMs > 0 &&
              now - lastProgressAt >= this.config.vaultScanDebugProgressEveryMs));
        const shouldLogInfoProgress =
          levelRank[this.logLevel] >= levelRank.info &&
          processed < files.length &&
          this.config.vaultScanInfoProgressEveryMs > 0 &&
          now - lastInfoProgressAt >= this.config.vaultScanInfoProgressEveryMs;

        if (shouldLogDebugProgress) {
          lastProgressAt = now;
          this.logDebug(`${label}: progress`, {
            processed,
            trackedFiles: files.length,
            loaded,
            unchanged,
            deferred,
            elapsedMs: now - scanStartedAt,
            path: file.path,
          });
        }

        if (shouldLogInfoProgress) {
          lastInfoProgressAt = now;
          this.logInfo(`${label}: progress`, {
            processed,
            trackedFiles: files.length,
            loaded,
            unchanged,
            deferred,
            elapsedMs: now - scanStartedAt,
          });
        }
      }

      this.logInfo(`${label}: done`, {
        loaded,
        unchanged,
        deferred,
        trackedFiles: files.length,
        adapterFiles: allFiles.length,
      });
      this.scanComplete = true;
      this.startupUnscannedPaths.clear();
      this.kickIncrementalInboxes();
      if (label === "Manual vault scan") {
        this.reportSyncProgress?.({
          status: "caught-up",
          message: "LocalSync local vault scan complete.",
        });
      }
    } catch (e) {
      this.logError(`${label}: scanVaultForUnsyncedFiles failed`, e);
      this.scanComplete = true; // allow drain even if scan errored
      this.startupPathsReady = true;
      this.startupUnscannedPaths.clear();
      this.kickIncrementalInboxes();
    } finally {
      this.isScanningVault = false;
    }
  }

  private async scanSettingsForUnsyncedFiles(label: string) {
    if (this.isStopped) return;
    if (!this.localSyncConfig.syncObsidianSettings) return;
    if (this.isScanningSettings) {
      this.logDebug(`${label}: settings scan already running, skipping`);
      return;
    }

    this.isScanningSettings = true;
    try {
      const paths = await this.listTrackedSettingPaths();
      this.logDebug(`${label}: begin`, { trackedSettings: paths.length });

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

      const result = {
        trackedSettings: paths.length,
        advertised,
        deferred,
        unchanged,
      };
      if (advertised > 0 || deferred > 0) {
        this.logInfo(`${label}: done`, result);
      } else {
        this.logDebug(`${label}: done`, result);
      }
    } catch (e) {
      this.logError(`${label}: scanSettingsForUnsyncedFiles failed`, e);
    } finally {
      this.isScanningSettings = false;
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
   * **No snapshot:** defer seeding until after a quiet inbox cycle so
   * existing remote state has a chance to arrive first.
   */
  async reconcileVaultFile(path: string, label = "Startup scan"): Promise<ReconcileResult> {
    if (this.isStopped) return "skipped";
    if (!isTrackedVaultPath(path, this.localSyncConfig)) return "skipped";

    const snapshot = await this.loadLocalSnapshotRecord(path);
    if (snapshot === null) {
      this.logInfo(`${label}: deferring new file seed`, { path });
      this.pendingVaultSeed.add(path);
      return "deferred";
    }

    const vaultText = await this.vault.readText(path);
    if (vaultText !== null && snapshot.contentHash === hashText(vaultText)) {
      return "unchanged";
    }

    await this.getOrLoadFileState(path);
    return "loaded";
  }

  /**
   * Seeds files from {@link pendingVaultSeed} that have not yet been covered by
   * materialized remote state.
   *
   * Called after the incoming inbox is quiet once {@link pendingVaultSeedReady} is
   * true. Files already removed from `pendingVaultSeed` by materialization are
   * skipped automatically by the set iteration.
  */
  private async drainPendingVaultSeed() {
    if (this.isStopped) return;
    if (this.pendingVaultSeed.size === 0) return;
    this.logInfo("Deferred seed: seeding files", { count: this.pendingVaultSeed.size });
    for (const path of this.pendingVaultSeed) {
      if (!this.isActive || this.isStopped) break;
      // Only seed if incoming processing has not already opened the file.
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

    this.logInfo("Deferred settings seed: seeding files", { count: this.pendingSettingSeed.size });
    for (const path of this.pendingSettingSeed) {
      if (!this.isActive || this.isStopped) break;
      if (!isTrackedSettingPath(path, this.localSyncConfig)) {
        this.pendingSettingSeed.delete(path);
        continue;
      }

      const remote = await this.loadLatestSettingUpdateForPath(path);
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
      this.evolu.upsert("fileUpdate", { id, path, updateBase64, originDeviceId: this.deviceId });
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
      originDeviceId: this.deviceId,
    });
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
      originDeviceId: this.deviceId,
    });
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
      this.stopInboxSubscriptions();
      // Wait for any in-progress materialization work to finish before closing
      // open docs and flushing the database.
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
      this.startInboxSubscriptions();
      await this.enforceLruLimit();
      this.logInfo("Engine config updated", this.config);
    } catch (e) {
      this.logError("updateConfig failed", e);
    }
  }

  async runMaterializationRepairNow(label = "Manual materialization repair"): Promise<MaterializationRepairResult> {
    const run = this.ongoingPoll.then(async () => {
      const result: MaterializationRepairResult = {
        files: this.createEmptyMaterializationStats(),
        settings: this.createEmptyMaterializationStats(),
      };

      if (this.isStopped) return result;

      this.fileMaterializerRunning = true;
      this.settingMaterializerRunning = true;
      try {
        const filePlans = await this.collectFileMaterializationPlans(true);
        result.files.planned = filePlans.length;
        for (const plan of filePlans) {
          if (this.isStopped) break;
          this.recordMaterializationOutcome(result.files, await this.materializeFilePlan(plan));
        }

        const settingPlans = await this.collectSettingMaterializationPlans(true);
        result.settings.planned = settingPlans.length;
        for (const plan of settingPlans) {
          if (this.isStopped) break;
          this.recordMaterializationOutcome(result.settings, await this.materializeSettingPlan(plan));
        }

        this.logInfo(`${label}: done`, result);
        return result;
      } finally {
        this.fileMaterializerRunning = false;
        this.settingMaterializerRunning = false;
        void this.handleHistoryQuietTick();
      }
    });
    this.ongoingPoll = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Detect local changes made while the engine was stopped or bypassed vault events. */
  async runVaultScanNow(label = "Manual vault scan"): Promise<void> {
    if (this.isStopped) return;
    if (this.localSyncConfig.syncDeletes) {
      await this.auditSnapshotsForOfflineDeletes(label);
    }
    await this.scanVaultForUnsyncedFiles(label);
  }

  private createEmptyMaterializationStats(): MaterializationRepairStats {
    return {
      planned: 0,
      written: 0,
      deleted: 0,
      unchanged: 0,
      skippedLocalDrift: 0,
      failed: 0,
    };
  }

  private recordMaterializationOutcome(stats: MaterializationRepairStats, outcome: MaterializationOutcome) {
    if (outcome === "written") stats.written++;
    else if (outcome === "deleted") stats.deleted++;
    else if (outcome === "unchanged") stats.unchanged++;
    else if (outcome === "skipped-local-drift") stats.skippedLocalDrift++;
    else stats.failed++;
  }

  /** Changes the console log verbosity at runtime. Takes effect immediately. */
  setLogLevel(level: LogLevel) {
    this.logLevel = level;
    this.logInfo("Log level set", level);
  }

  /** Updates path policy used by scans, vault events, and remote write/delete handling. */
  updateLocalSyncConfig(config: LocalSyncConfig) {
    this.localSyncConfig = config;
    this.fileMaterializationBlockedSignatures.clear();
    this.stopRescanTimer();
    this.startRescanTimer();
    this.kickIncrementalInboxes();
    this.logInfo("Local sync path policy updated", config);
  }

  /**
   * Resumes materialization work.
   *
   * Called when the Obsidian window regains focus (`window focus` or
   * `visibilitychange` → visible). Triggers an immediate poll to catch up on
   * changes received while the engine was inactive.
   */
  async setActive() {
    if (this.isStopped) return;
    this.isActive = true;
    this.logInfo("App active");
    this.kickIncrementalInboxes();
    void this.handleHistoryQuietTick();
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
    this.fileMaterializationBlockedSignatures.delete(path);

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

  // ---------- inbox subscriptions and quiet timer ----------

  private startPollingTimer() {
    this.pollTimer = setInterval(() => {
      if (this.isActive) {
        this.kickIncrementalInboxes();
        void this.handleHistoryQuietTick();
      }
    }, this.config.historyPollMs);
  }

  private stopPollingTimer() {
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private startInboxSubscriptions() {
    this.stopInboxSubscriptions();

    const fileQuery = this.createPendingFileUpdateQuery();
    const settingQuery = this.createPendingSettingUpdateQuery();

    const consumeFileRows = (rows: ReadonlyArray<any>) => {
      this.fileInboxInitialized = true;
      this.fileInboxPageSaturated = rows.length >= this.config.historyBatchSize;
      this.enqueuePendingFileRows(rows);
      void this.ensureInboxProgressTotal();
    };
    const consumeSettingRows = (rows: ReadonlyArray<any>) => {
      this.settingInboxInitialized = true;
      this.settingInboxPageSaturated = rows.length >= this.config.historyBatchSize;
      this.enqueuePendingSettingRows(rows);
      void this.ensureInboxProgressTotal();
    };

    this.unsubscribers.push(
      this.evolu.subscribeQuery(fileQuery)(() => {
        consumeFileRows(this.evolu.getQueryRows(fileQuery) as ReadonlyArray<any>);
      }),
    );
    if (this.localSyncConfig.syncObsidianSettings) {
      this.unsubscribers.push(
        this.evolu.subscribeQuery(settingQuery)(() => {
          consumeSettingRows(this.evolu.getQueryRows(settingQuery) as ReadonlyArray<any>);
        }),
      );
    } else {
      this.settingInboxInitialized = true;
    }

    void this.evolu.loadQuery(fileQuery).then((rows) => consumeFileRows(rows as ReadonlyArray<any>));
    if (this.localSyncConfig.syncObsidianSettings) {
      void this.evolu.loadQuery(settingQuery).then((rows) => consumeSettingRows(rows as ReadonlyArray<any>));
    }
  }

  private stopInboxSubscriptions() {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Best effort shutdown only.
      }
    }
    this.unsubscribers = [];
  }

  private createPendingFileUpdateQuery() {
    return this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("fileUpdate as incoming")
        .leftJoin("_processedFileUpdate as processed", (join: any) =>
          join
            .onRef("processed.sourceId", "=", "incoming.id")
            .on((eb: any) =>
              eb(
                "processed.sourceVersion",
                "=",
                eb.fn.coalesce("incoming.updatedAt", "incoming.createdAt"),
              ),
            ),
        )
        .select((eb: any) => [
          "incoming.id as id",
          "incoming.path as path",
          "incoming.updateBase64 as updateBase64",
          "incoming.type as type",
          "incoming.createdAt as createdAt",
          eb.fn.coalesce("incoming.updatedAt", "incoming.createdAt").as("sourceVersion"),
        ])
        .where("incoming.isDeleted", "is", null)
        .where("processed.id", "is", null)
        .where((eb: any) =>
          eb.or([
            eb("incoming.originDeviceId", "is", null),
            eb("incoming.originDeviceId", "!=", this.deviceId),
          ]),
        )
        .orderBy("incoming.createdAt", "asc")
        .orderBy("incoming.id", "asc")
        .limit(this.config.historyBatchSize),
    );
  }

  private createPendingSettingUpdateQuery() {
    return this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("settingUpdate as incoming")
        .leftJoin("_processedSettingUpdate as processed", (join: any) =>
          join
            .onRef("processed.sourceId", "=", "incoming.id")
            .on((eb: any) =>
              eb(
                "processed.sourceVersion",
                "=",
                eb.fn.coalesce("incoming.updatedAt", "incoming.createdAt"),
              ),
            ),
        )
        .select((eb: any) => [
          "incoming.id as id",
          "incoming.path as path",
          "incoming.contentBase64 as contentBase64",
          "incoming.contentHash as contentHash",
          "incoming.encoding as encoding",
          "incoming.type as type",
          "incoming.createdAt as createdAt",
          eb.fn.coalesce("incoming.updatedAt", "incoming.createdAt").as("sourceVersion"),
        ])
        .where("incoming.isDeleted", "is", null)
        .where("processed.id", "is", null)
        .where((eb: any) =>
          eb.or([
            eb("incoming.originDeviceId", "is", null),
            eb("incoming.originDeviceId", "!=", this.deviceId),
          ]),
        )
        .orderBy("incoming.createdAt", "asc")
        .orderBy("incoming.id", "asc")
        .limit(this.config.historyBatchSize),
    );
  }

  private createPendingFileUpdateCountQuery() {
    return this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("fileUpdate as incoming")
        .leftJoin("_processedFileUpdate as processed", (join: any) =>
          join
            .onRef("processed.sourceId", "=", "incoming.id")
            .on((eb: any) =>
              eb(
                "processed.sourceVersion",
                "=",
                eb.fn.coalesce("incoming.updatedAt", "incoming.createdAt"),
              ),
            ),
        )
        .select((eb: any) => eb.fn.countAll().as("count"))
        .where("incoming.isDeleted", "is", null)
        .where("processed.id", "is", null)
        .where((eb: any) =>
          eb.or([
            eb("incoming.originDeviceId", "is", null),
            eb("incoming.originDeviceId", "!=", this.deviceId),
          ]),
        ),
    );
  }

  private createPendingSettingUpdateCountQuery() {
    return this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("settingUpdate as incoming")
        .leftJoin("_processedSettingUpdate as processed", (join: any) =>
          join
            .onRef("processed.sourceId", "=", "incoming.id")
            .on((eb: any) =>
              eb(
                "processed.sourceVersion",
                "=",
                eb.fn.coalesce("incoming.updatedAt", "incoming.createdAt"),
              ),
            ),
        )
        .select((eb: any) => eb.fn.countAll().as("count"))
        .where("incoming.isDeleted", "is", null)
        .where("processed.id", "is", null)
        .where((eb: any) =>
          eb.or([
            eb("incoming.originDeviceId", "is", null),
            eb("incoming.originDeviceId", "!=", this.deviceId),
          ]),
        ),
    );
  }

  private async loadPendingInboxCount(): Promise<number> {
    const fileCountQuery = this.createPendingFileUpdateCountQuery();
    const settingCountQuery = this.createPendingSettingUpdateCountQuery();
    const [fileRows, settingRows] = await Promise.all([
      this.evolu.loadQuery(fileCountQuery),
      this.localSyncConfig.syncObsidianSettings
        ? this.evolu.loadQuery(settingCountQuery)
        : Promise.resolve([]),
    ]);
    const fileCount = Number((fileRows[0] as { count?: unknown } | undefined)?.count ?? 0);
    const settingCount = Number((settingRows[0] as { count?: unknown } | undefined)?.count ?? 0);
    return fileCount + settingCount;
  }

  private async ensureInboxProgressTotal(): Promise<void> {
    if (this.inboxProgressTotal !== null) return;
    if (!this.fileInboxInitialized || !this.settingInboxInitialized) return;
    if (!this.fileInboxPageSaturated && !this.settingInboxPageSaturated) {
      this.inboxProgressTotal = this.inboxProgressDiscovered;
      this.reportInboxProgress();
      return;
    }
    if (!this.inboxProgressTotalPromise) {
      this.inboxProgressTotalPromise = this.loadPendingInboxCount()
        .then((count) => {
          this.inboxProgressTotal = Math.max(count, this.inboxProgressDiscovered);
          this.reportInboxProgress();
        })
        .catch((error) => {
          this.logWarn("Pending inbox count failed", error);
          this.inboxProgressTotal = this.inboxProgressDiscovered;
        })
        .finally(() => {
          this.inboxProgressTotalPromise = null;
        });
    }
    await this.inboxProgressTotalPromise;
  }

  private enqueuePendingFileRows(rows: ReadonlyArray<any>) {
    let discovered = false;
    for (const row of rows) {
      if (!row.id || !row.path || !row.updateBase64 || !row.createdAt || !row.sourceVersion) continue;
      const pending: PendingFileUpdateRow = {
        id: row.id as string,
        path: row.path as string,
        updateBase64: row.updateBase64 as string,
        type: (row.type as string | null) ?? null,
        createdAt: row.createdAt as string,
        sourceVersion: row.sourceVersion as string,
      };
      const key = this.inboxKey(pending);
      if (!this.inboxProgressKeys.has(`file:${key}`)) {
        this.inboxProgressKeys.add(`file:${key}`);
        this.inboxProgressDiscovered++;
        if (this.inboxProgressTotal !== null) {
          this.inboxProgressTotal = Math.max(this.inboxProgressTotal, this.inboxProgressDiscovered);
        }
        discovered = true;
      }
      this.pendingFileInbox.set(key, pending);
    }
    if (discovered) {
      this.inboxQuietTicks = 0;
      this.reportInboxProgress();
      void this.ensureInboxProgressTotal();
    }
    this.kickIncrementalInboxes();
  }

  private enqueuePendingSettingRows(rows: ReadonlyArray<any>) {
    let discovered = false;
    for (const row of rows) {
      if (!row.id || !row.path || !row.contentHash || !row.createdAt || !row.sourceVersion) continue;
      const pending: PendingSettingUpdateRow = {
        id: row.id as string,
        path: row.path as string,
        contentBase64: (row.contentBase64 as string | null) ?? "",
        contentHash: row.contentHash as string,
        encoding: (row.encoding as string | null) ?? null,
        type: (row.type as string | null) ?? null,
        createdAt: row.createdAt as string,
        sourceVersion: row.sourceVersion as string,
      };
      const key = this.inboxKey(pending);
      if (!this.inboxProgressKeys.has(`setting:${key}`)) {
        this.inboxProgressKeys.add(`setting:${key}`);
        this.inboxProgressDiscovered++;
        if (this.inboxProgressTotal !== null) {
          this.inboxProgressTotal = Math.max(this.inboxProgressTotal, this.inboxProgressDiscovered);
        }
        discovered = true;
      }
      this.pendingSettingInbox.set(key, pending);
    }
    if (discovered) {
      this.inboxQuietTicks = 0;
      this.reportInboxProgress();
      void this.ensureInboxProgressTotal();
    }
    this.kickIncrementalInboxes();
  }

  private inboxKey(row: { id: string; sourceVersion: string }): string {
    return `${row.id}:${row.sourceVersion}`;
  }

  private reportInboxProgress() {
    if (this.inboxProgressDiscovered === 0) return;
    this.reportSyncProgress?.({
      status: "syncing",
      message: "LocalSync is applying remote changes.",
      current: this.inboxProgressApplied,
      total: this.inboxProgressTotal ?? this.inboxProgressDiscovered,
    });
  }

  private reportInboxBlocked() {
    this.reportSyncProgress?.({
      status: "blocked",
      message: "LocalSync paused: a remote update could not be applied. Check the console.",
    });
  }

  private canProcessIncomingPath(path: string): boolean {
    if (!this.localSyncConfig.startupScan || this.scanComplete) return true;
    return this.startupPathsReady && !this.startupUnscannedPaths.has(path);
  }

  private kickIncrementalInboxes() {
    if (this.isStopped || !this.isActive) return;
    void this.runFileInbox();
    void this.runSettingInbox();
  }

  private async runFileInbox() {
    if (this.fileInboxRunning || this.isStopped || !this.isActive) return;
    const firstEligible = Array.from(this.pendingFileInbox.values()).find((row) =>
      this.canProcessIncomingPath(row.path),
    );
    if (!firstEligible) return;

    this.fileInboxRunning = true;
    const run = this.ongoingPoll.then(async () => {
      await this.ensureInboxProgressTotal();
      while (!this.isStopped && this.isActive) {
        const first = Array.from(this.pendingFileInbox.values()).find((row) =>
          this.canProcessIncomingPath(row.path),
        );
        if (!first) break;
        const rows = Array.from(this.pendingFileInbox.values())
          .filter((row) => row.path === first.path)
          .sort(compareUpdateOrder);
        if (!(await this.processPendingFilePath(first.path, rows))) {
          this.reportInboxBlocked();
          break;
        }
        for (const row of rows) this.pendingFileInbox.delete(this.inboxKey(row));
        this.inboxProgressApplied += rows.length;
        this.reportInboxProgress();
      }
    });
    this.ongoingPoll = run.then(() => undefined, () => undefined);
    try {
      await run;
    } catch (error) {
      this.logError("Incremental file inbox failed", error);
      this.reportInboxBlocked();
    } finally {
      this.fileInboxRunning = false;
      void this.handleHistoryQuietTick();
    }
  }

  private async runSettingInbox() {
    if (this.settingInboxRunning || this.isStopped || !this.isActive) return;
    const firstEligible = Array.from(this.pendingSettingInbox.values()).find((row) =>
      this.canProcessIncomingPath(row.path),
    );
    if (!firstEligible) return;

    this.settingInboxRunning = true;
    const run = this.ongoingPoll.then(async () => {
      await this.ensureInboxProgressTotal();
      while (!this.isStopped && this.isActive) {
        const first = Array.from(this.pendingSettingInbox.values()).find((row) =>
          this.canProcessIncomingPath(row.path),
        );
        if (!first) break;
        const rows = Array.from(this.pendingSettingInbox.values())
          .filter((row) => row.path === first.path)
          .sort(compareUpdateOrder);
        if (!(await this.processPendingSettingPath(first.path, rows))) {
          this.reportInboxBlocked();
          break;
        }
        for (const row of rows) this.pendingSettingInbox.delete(this.inboxKey(row));
        this.inboxProgressApplied += rows.length;
        this.reportInboxProgress();
      }
    });
    this.ongoingPoll = run.then(() => undefined, () => undefined);
    try {
      await run;
    } catch (error) {
      this.logError("Incremental setting inbox failed", error);
      this.reportInboxBlocked();
    } finally {
      this.settingInboxRunning = false;
      void this.handleHistoryQuietTick();
    }
  }

  private async initializeIncrementalInbox() {
    const stateId = createIdFromString<"InboxState">("incremental-inbox-v1");
    const stateQuery = this.evolu.createQuery((db) =>
      db
        .selectFrom("_inboxState")
        .select(["version"])
        .where("id", "=", stateId)
        .where("isDeleted", "is", null)
        .limit(1),
    );
    const stateRows = await this.evolu.loadQuery(stateQuery);
    if (stateRows.some((row) => row.version === "2")) return;

    const fileSnapshotQuery = this.evolu.createQuery((db) =>
      db.selectFrom("_fileSnapshot").select(["id"]).limit(1),
    );
    const settingSnapshotQuery = this.evolu.createQuery((db) =>
      db.selectFrom("_settingSnapshot").select(["id"]).limit(1),
    );
    const fileMaterializationQuery = this.evolu.createQuery((db) =>
      db.selectFrom("_fileMaterialization").select(["id"]).limit(1),
    );
    const settingMaterializationQuery = this.evolu.createQuery((db) =>
      db.selectFrom("_settingMaterialization").select(["id"]).limit(1),
    );
    const localStateRows = await Promise.all([
      this.evolu.loadQuery(fileSnapshotQuery),
      this.evolu.loadQuery(settingSnapshotQuery),
      this.evolu.loadQuery(fileMaterializationQuery),
      this.evolu.loadQuery(settingMaterializationQuery),
    ]);
    const isExistingPeer = localStateRows.some((rows) => rows.length > 0);

    if (isExistingPeer) {
      const fileRowsQuery = this.evolu.createQuery((db) =>
        (db as any)
          .selectFrom("fileUpdate")
          .select(["id", "path", "type", "createdAt", "updatedAt"])
          .where("isDeleted", "is", null)
          .orderBy("createdAt", "asc")
          .orderBy("id", "asc"),
      );
      const settingRowsQuery = this.evolu.createQuery((db) =>
        (db as any)
          .selectFrom("settingUpdate")
          .select(["id", "path", "contentHash", "type", "createdAt", "updatedAt"])
          .where("isDeleted", "is", null)
          .orderBy("createdAt", "asc")
          .orderBy("id", "asc"),
      );
      const fileSignaturesQuery = this.evolu.createQuery((db) =>
        db
          .selectFrom("_fileMaterialization")
          .select(["path", "signature"])
          .where("isDeleted", "is", null),
      );
      const settingSignaturesQuery = this.evolu.createQuery((db) =>
        db
          .selectFrom("_settingMaterialization")
          .select(["path", "signature"])
          .where("isDeleted", "is", null),
      );
      const [fileRows, settingRows, fileSignatures, settingSignatures] = await Promise.all([
        this.evolu.loadQuery(fileRowsQuery),
        this.evolu.loadQuery(settingRowsQuery),
        this.evolu.loadQuery(fileSignaturesQuery),
        this.evolu.loadQuery(settingSignaturesQuery),
      ]);
      const trustedFileRows = this.collectTrustedFileMigrationRows(
        fileRows as ReadonlyArray<any>,
        fileSignatures as ReadonlyArray<any>,
      );
      const trustedSettingRows = this.collectTrustedSettingMigrationRows(
        settingRows as ReadonlyArray<any>,
        settingSignatures as ReadonlyArray<any>,
      );
      const migrationTotal = trustedFileRows.length + trustedSettingRows.length;
      if (migrationTotal > 0) {
        this.reportSyncProgress?.({
          status: "syncing",
          message: "LocalSync is preparing local sync state.",
          current: 0,
          total: migrationTotal,
        });
      }
      await this.markFileRowsProcessed(trustedFileRows, (current) => {
        this.reportSyncProgress?.({
          status: "syncing",
          message: "LocalSync is preparing local sync state.",
          current,
          total: migrationTotal,
        });
      });
      await this.markSettingRowsProcessed(trustedSettingRows, (current) => {
        this.reportSyncProgress?.({
          status: "syncing",
          message: "LocalSync is preparing local sync state.",
          current: trustedFileRows.length + current,
          total: migrationTotal,
        });
      });
      this.logInfo("Incremental inbox migration: imported materialization checkpoints", {
        trustedFileRows: trustedFileRows.length,
        pendingFileRows: fileRows.length - trustedFileRows.length,
        trustedSettingRows: trustedSettingRows.length,
        pendingSettingRows: settingRows.length - trustedSettingRows.length,
      });
    }

    await this.upsertAndWait("_inboxState", { id: stateId, version: "2" });
    await this.persistLocalDb?.();
  }

  private collectTrustedFileMigrationRows(
    rows: ReadonlyArray<any>,
    signatures: ReadonlyArray<any>,
  ): ReadonlyArray<any> {
    const savedByPath = new Map<string, string>(
      signatures
        .filter((row) => row.path && row.signature)
        .map((row) => [row.path as string, row.signature as string]),
    );
    const rowsByPath = new Map<string, any[]>();
    for (const row of rows) {
      if (!row.path || !row.id) continue;
      const pathRows = rowsByPath.get(row.path as string) ?? [];
      pathRows.push(row);
      rowsByPath.set(row.path as string, pathRows);
    }

    const trusted: any[] = [];
    for (const [path, pathRows] of rowsByPath) {
      const signature = this.createMaterializationSignature(
        pathRows.map((row) => `${row.id as string}:${(row.type as string | null) ?? ""}`),
      );
      if (savedByPath.get(path) === signature) trusted.push(...pathRows);
    }
    return trusted;
  }

  private collectTrustedSettingMigrationRows(
    rows: ReadonlyArray<any>,
    signatures: ReadonlyArray<any>,
  ): ReadonlyArray<any> {
    const savedByPath = new Map<string, string>(
      signatures
        .filter((row) => row.path && row.signature)
        .map((row) => [row.path as string, row.signature as string]),
    );
    const rowsByPath = new Map<string, any[]>();
    for (const row of rows) {
      if (!row.path || !row.id || !row.contentHash) continue;
      const pathRows = rowsByPath.get(row.path as string) ?? [];
      pathRows.push(row);
      rowsByPath.set(row.path as string, pathRows);
    }

    const trusted: any[] = [];
    for (const [path, pathRows] of rowsByPath) {
      const latest = pathRows[pathRows.length - 1];
      const signature = this.createMaterializationSignature([
        latest.id as string,
        latest.contentHash as string,
        (latest.type as string | null) ?? "",
      ]);
      if (savedByPath.get(path) === signature) trusted.push(...pathRows);
    }
    return trusted;
  }

  private async upsertAndWait(table: string, row: Record<string, unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const result = (this.evolu.upsert as any)(table, row, { onComplete: resolve });
      if (result && result.ok === false) {
        reject(new Error(`Failed to upsert ${table}: ${JSON.stringify(result.error)}`));
      }
    });
  }

  private getSourceVersion(row: { createdAt?: unknown; updatedAt?: unknown; sourceVersion?: unknown }): string | null {
    if (typeof row.sourceVersion === "string") return row.sourceVersion;
    if (typeof row.updatedAt === "string") return row.updatedAt;
    return typeof row.createdAt === "string" ? row.createdAt : null;
  }

  private async markFileRowsProcessed(
    rows: ReadonlyArray<{ id?: unknown; createdAt?: unknown; updatedAt?: unknown; sourceVersion?: unknown }>,
    reportProgress?: (current: number) => void,
  ) {
    const validRows = rows.filter(
      (row) => typeof row.id === "string" && this.getSourceVersion(row) !== null,
    );
    for (let offset = 0; offset < validRows.length; offset += 250) {
      if (validRows.length > 1000 && offset % 2500 === 0) {
        this.logInfo("Incremental inbox migration: file marker progress", {
          processed: offset,
          total: validRows.length,
        });
      }
      await Promise.all(
        validRows.slice(offset, offset + 250).map((row) => {
          const sourceId = row.id as string;
          const sourceVersion = this.getSourceVersion(row)!;
          const id = createIdFromString<"ProcessedFileUpdate">(
            `processed-file:${sourceId}:${sourceVersion}`,
          );
          return this.upsertAndWait("_processedFileUpdate", { id, sourceId, sourceVersion });
        }),
      );
      reportProgress?.(Math.min(offset + 250, validRows.length));
    }
  }

  private async markSettingRowsProcessed(
    rows: ReadonlyArray<{ id?: unknown; createdAt?: unknown; updatedAt?: unknown; sourceVersion?: unknown }>,
    reportProgress?: (current: number) => void,
  ) {
    const validRows = rows.filter(
      (row) => typeof row.id === "string" && this.getSourceVersion(row) !== null,
    );
    for (let offset = 0; offset < validRows.length; offset += 250) {
      if (validRows.length > 1000 && offset % 2500 === 0) {
        this.logInfo("Incremental inbox migration: setting marker progress", {
          processed: offset,
          total: validRows.length,
        });
      }
      await Promise.all(
        validRows.slice(offset, offset + 250).map((row) => {
          const sourceId = row.id as string;
          const sourceVersion = this.getSourceVersion(row)!;
          const id = createIdFromString<"ProcessedSettingUpdate">(
            `processed-setting:${sourceId}:${sourceVersion}`,
          );
          return this.upsertAndWait("_processedSettingUpdate", { id, sourceId, sourceVersion });
        }),
      );
      reportProgress?.(Math.min(offset + 250, validRows.length));
    }
  }

  private async reconcileLocalFileBeforeIncoming(path: string): Promise<boolean> {
    if (this.states.has(path)) {
      const closed = await this.closeDoc(path);
      if (!closed) return false;
      this.states.delete(path);
    }

    const current = await this.vault.readText(path);
    const snapshot = await this.loadLocalSnapshotText(path);
    if (current === null || current === snapshot) return true;

    await this.getOrLoadFileState(path);
    const closed = await this.closeDoc(path);
    if (closed) this.states.delete(path);
    return closed;
  }

  private async buildPendingFileContentState(
    path: string,
    rows: PendingFileUpdateRow[],
  ): Promise<{ doc: Y.Doc; text: Y.Text } | null> {
    const latestDelete = await this.loadLatestFileDelete(path);
    const applicable = latestDelete
      ? rows.filter((row) => compareUpdateOrder(row, latestDelete) > 0)
      : rows;
    if (applicable.length === 0) return null;

    const doc = new Y.Doc();
    const text = doc.getText("content");
    const snapshot = await this.loadLocalSnapshot(path);
    if (snapshot) Y.applyUpdate(doc, fromBase64(snapshot));
    for (const row of applicable) {
      Y.applyUpdate(doc, fromBase64(row.updateBase64), "remote");
    }
    return { doc, text };
  }

  private async recoverInterruptedFileApplication(
    path: string,
    rows: PendingFileUpdateRow[],
  ): Promise<{ doc: Y.Doc; text: Y.Text } | null> {
    if (this.states.has(path)) return null;
    const current = await this.vault.readText(path);
    const snapshotText = await this.loadLocalSnapshotText(path);
    if (current === null || current === snapshotText) return null;

    const pendingState = await this.buildPendingFileContentState(path, rows);
    if (pendingState && pendingState.text.toString() === current) {
      this.logInfo("Recovered interrupted remote file application", {
        path,
        updates: rows.length,
      });
      return pendingState;
    }
    pendingState?.doc.destroy();
    return null;
  }

  private async processPendingFilePath(path: string, rows: PendingFileUpdateRow[]): Promise<boolean> {
    if (!isTrackedVaultPath(path, this.localSyncConfig)) {
      await this.markFileRowsProcessed(rows);
      await this.persistLocalDb?.();
      return true;
    }

    try {
      const hasDelete = rows.some((row) => row.type === "delete");
      const recovered = hasDelete
        ? null
        : await this.recoverInterruptedFileApplication(path, rows);
      if (recovered) {
        await this.writeIncrementalFileState(path, recovered.doc, recovered.text);
      } else if (!(await this.reconcileLocalFileBeforeIncoming(path))) {
        return false;
      } else if (hasDelete) {
        const allRows = await this.loadFileUpdateRowsForPath(path);
        const materialized = this.materializeFileRows(allRows);
        if (materialized === null) {
          const existed = await this.vault.fileExists(path);
          this.destroyDoc(path);
          this.tombstoneSnapshot(path);
          if (existed) {
            this.pendingRemoteDeletes.add(path);
            try {
              await this.vault.deleteFile(path);
            } finally {
              this.pendingRemoteDeletes.delete(path);
            }
          }
        } else {
          await this.writeIncrementalFileState(path, materialized.doc, materialized.text);
        }
      } else {
        const pendingState = await this.buildPendingFileContentState(path, rows);
        if (pendingState) {
          await this.writeIncrementalFileState(path, pendingState.doc, pendingState.text);
        }
      }

      await this.markFileRowsProcessed(rows);
      await this.persistLocalDb?.();
      this.pendingVaultSeed.delete(path);
      this.logInfo("Incremental file updates applied", { path, updates: rows.length });
      return true;
    } catch (error) {
      this.logError("processPendingFilePath failed", { path, error });
      return false;
    }
  }

  private async writeIncrementalFileState(path: string, doc: Y.Doc, text: Y.Text): Promise<void> {
    const current = await this.vault.readText(path);
    const state = this.createFileStateFromDoc(path, doc, text, current ?? "", true);
    const written = await this.writeYjsToVault(path, state);
    if (!written) {
      doc.destroy();
      throw new Error(`Failed to write incremental file state: ${path}`);
    }
    this.states.set(path, state);
    await this.saveLocalSnapshot(path, state);
    await this.enforceLruLimit();
  }

  private async loadFileUpdateRowsForPath(path: string): Promise<PendingFileUpdateRow[]> {
    const query = this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("fileUpdate")
        .select(["id", "path", "updateBase64", "type", "createdAt", "updatedAt"])
        .where("path", "=", path)
        .where("isDeleted", "is", null)
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc"),
    );
    return (await this.evolu.loadQuery(query)) as unknown as PendingFileUpdateRow[];
  }

  private materializeFileRows(rows: PendingFileUpdateRow[]): { doc: Y.Doc; text: Y.Text } | null {
    let doc = new Y.Doc();
    let text = doc.getText("content");
    let sawContent = false;
    for (const row of rows) {
      if (row.type === "delete") {
        doc.destroy();
        doc = new Y.Doc();
        text = doc.getText("content");
        sawContent = false;
      } else {
        Y.applyUpdate(doc, fromBase64(row.updateBase64), "remote");
        sawContent = true;
      }
    }
    if (sawContent) return { doc, text };
    doc.destroy();
    return null;
  }

  private async loadLatestFileDelete(path: string): Promise<{ id: string; createdAt: string } | null> {
    const query = this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("fileUpdate")
        .select(["id", "createdAt"])
        .where("path", "=", path)
        .where("type", "=", "delete")
        .where("isDeleted", "is", null)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(1),
    );
    const rows = (await this.evolu.loadQuery(query)) as ReadonlyArray<any>;
    if (!rows[0]?.id || !rows[0]?.createdAt) return null;
    return { id: rows[0].id as string, createdAt: rows[0].createdAt as string };
  }

  private async processPendingSettingPath(path: string, rows: PendingSettingUpdateRow[]): Promise<boolean> {
    if (!this.localSyncConfig.syncObsidianSettings || !isTrackedSettingPath(path, this.localSyncConfig)) {
      await this.markSettingRowsProcessed(rows);
      await this.persistLocalDb?.();
      return true;
    }

    try {
      const current = await this.vault.readText(path);
      const snapshot = await this.loadSettingSnapshot(path);
      const currentHash = current === null ? null : hashText(current);
      const latest = await this.loadLatestSettingUpdateForPath(path);
      if (current !== null && latest && latest.contentHash === currentHash) {
        this.logInfo("Recovered interrupted remote setting application", { path });
        await this.applyRemoteSettingUpdate(latest);
      } else if (current !== null && snapshot?.contentHash !== currentHash) {
        await this.advertiseSettingContent(path, current, currentHash ?? hashText(current));
      } else {
        if (latest) await this.applyRemoteSettingUpdate(latest);
      }
      await this.markSettingRowsProcessed(rows);
      await this.persistLocalDb?.();
      this.pendingSettingSeed.delete(path);
      this.logInfo("Incremental setting updates applied", { path, updates: rows.length });
      return true;
    } catch (error) {
      this.logError("processPendingSettingPath failed", { path, error });
      return false;
    }
  }

  private async loadLatestSettingUpdateForPath(path: string): Promise<SettingUpdateWithId | null> {
    const query = this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("settingUpdate")
        .select(["id", "path", "contentBase64", "contentHash", "encoding", "type"])
        .where("path", "=", path)
        .where("isDeleted", "is", null)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(1),
    );
    const rows = (await this.evolu.loadQuery(query)) as ReadonlyArray<any>;
    const row = rows[0];
    if (!row?.id || !row?.path || !row?.contentHash) return null;
    return {
      id: row.id as string,
      path: row.path as string,
      contentBase64: (row.contentBase64 as string | null) ?? "",
      contentHash: row.contentHash as string,
      encoding: (row.encoding as string | null) ?? null,
      type: (row.type as string | null) ?? null,
    };
  }

  private createFileUpdateMetaQuery() {
    return this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("fileUpdate")
        .select(["id", "path", "type", "updatedAt"])
        .where("isDeleted", "is", null)
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc"),
    );
  }

  private createSettingUpdateRowsQuery() {
    return this.evolu.createQuery((db) =>
      (db as any)
        .selectFrom("settingUpdate")
        .select(["id", "path", "contentBase64", "contentHash", "encoding", "type", "createdAt", "updatedAt"])
        .where("isDeleted", "is", null)
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc"),
    );
  }

  private async collectFileMaterializationPlans(force: boolean): Promise<FileMaterializationPlan[]> {
    const rows = (await this.evolu.loadQuery(this.createFileUpdateMetaQuery())) as ReadonlyArray<any>;
    const idsByPath = new Map<string, string[]>();
    const signaturePartsByPath = new Map<string, string[]>();
    const latestTypeByPath = new Map<string, string | null>();

    for (const row of rows) {
      if (!row.id || !row.path) continue;
      const path = row.path as string;
      if (!isTrackedVaultPath(path, this.localSyncConfig)) continue;
      const type = (row.type as string | null) ?? null;
      const ids = idsByPath.get(path) ?? [];
      ids.push(row.id as string);
      idsByPath.set(path, ids);
      const signatureParts = signaturePartsByPath.get(path) ?? [];
      signatureParts.push(`${row.id as string}:${type ?? ""}:${(row.updatedAt as string | null) ?? ""}`);
      signaturePartsByPath.set(path, signatureParts);
      latestTypeByPath.set(path, type);
    }

    const plans: FileMaterializationPlan[] = [];
    for (const [path, ids] of idsByPath) {
      const latestType = latestTypeByPath.get(path) ?? null;
      const signature = this.createMaterializationSignature(signaturePartsByPath.get(path) ?? ids);
      const savedSignature = await this.loadFileMaterializationSignature(path);
      if (!force && savedSignature === signature) continue;
      if (!force && this.fileMaterializationBlockedSignatures.get(path) === signature) continue;
      plans.push({ path, ids, signature, latestType });
    }
    return plans;
  }

  private async materializeFilePlan(plan: FileMaterializationPlan): Promise<MaterializationOutcome> {
    if (plan.latestType === "delete") {
      const currentText = await this.vault.readText(plan.path);
      const snapshotText = await this.loadLocalSnapshotText(plan.path);
      if (currentText !== null && snapshotText !== currentText) {
        this.fileMaterializationBlockedSignatures.set(plan.path, plan.signature);
        this.logWarn("File materializer skipped delete due to local drift", { path: plan.path });
        return "skipped-local-drift";
      }

      this.destroyDoc(plan.path);
      this.pendingVaultSeed.delete(plan.path);
      this.tombstoneSnapshot(plan.path);
      if (currentText !== null) {
        this.pendingRemoteDeletes.add(plan.path);
        try {
          await this.vault.deleteFile(plan.path);
        } finally {
          this.pendingRemoteDeletes.delete(plan.path);
        }
      }
      await this.saveFileMaterializationSignature(plan.path, plan.signature);
      this.fileMaterializationBlockedSignatures.delete(plan.path);
      this.logInfo("File materializer applied delete", { path: plan.path });
      return currentText !== null ? "deleted" : "unchanged";
    }

    const currentText = await this.vault.readText(plan.path);
    const snapshotText = await this.loadLocalSnapshotText(plan.path);
    if (currentText !== null && snapshotText !== currentText) {
      this.fileMaterializationBlockedSignatures.set(plan.path, plan.signature);
      this.logWarn("File materializer skipped update due to local drift", { path: plan.path });
      return "skipped-local-drift";
    }
    if (this.states.has(plan.path)) {
      const closed = await this.closeDoc(plan.path);
      if (!closed) {
        this.logWarn("File materializer skipped update because open doc could not close", { path: plan.path });
        return "failed";
      }
      this.states.delete(plan.path);
    }

    const materialized = await this.materializeFileHistory(plan.ids);
    if (!materialized) return "failed";
    const historyText = materialized.text.toString();

    if (currentText === historyText) {
      await this.saveLocalSnapshot(plan.path, {
        path: plan.path,
        doc: materialized.doc,
        text: materialized.text,
        lastVaultText: historyText,
        ignoreNextVaultModify: false,
        pendingUpdates: [],
        pendingOutgoingId: null,
        flushTimer: null,
      });
      await this.saveFileMaterializationSignature(plan.path, plan.signature);
      this.fileMaterializationBlockedSignatures.delete(plan.path);
      materialized.doc.destroy();
      return "unchanged";
    }

    const repairState = this.createFileStateFromDoc(
      plan.path,
      materialized.doc,
      materialized.text,
      currentText ?? "",
      true,
    );
    const written = await this.writeYjsToVault(plan.path, repairState);
    if (!written) {
      materialized.doc.destroy();
      return "failed";
    }

    this.states.set(plan.path, repairState);
    await this.saveLocalSnapshot(plan.path, repairState);
    await this.saveFileMaterializationSignature(plan.path, plan.signature);
    await this.persistLocalDb?.();
    this.fileMaterializationBlockedSignatures.delete(plan.path);
    this.pendingVaultSeed.delete(plan.path);
    this.logInfo("File materializer wrote vault file", {
      path: plan.path,
      previousChars: currentText?.length ?? 0,
      materializedChars: historyText.length,
    });
    return "written";
  }

  private async collectSettingMaterializationPlans(force: boolean): Promise<SettingMaterializationPlan[]> {
    if (!this.localSyncConfig.syncObsidianSettings) {
      return [];
    }

    const rows = (await this.evolu.loadQuery(this.createSettingUpdateRowsQuery())) as ReadonlyArray<any>;
    const latestByPath = new Map<string, SettingMaterializationPlan>();

    for (const row of rows) {
      if (!row.id || !row.path || !row.contentHash) continue;
      const path = row.path as string;
      if (!isTrackedSettingPath(path, this.localSyncConfig)) continue;
      const setting: SettingUpdateWithId = {
        id: row.id as string,
        path,
        contentBase64: (row.contentBase64 as string | null) ?? "",
        contentHash: row.contentHash as string,
        encoding: (row.encoding as string | null) ?? null,
        type: (row.type as string | null) ?? null,
      };
      const signature = this.createMaterializationSignature([
        setting.id,
        setting.contentHash,
        setting.type ?? "",
        (row.updatedAt as string | null) ?? "",
      ]);
      latestByPath.set(path, { path, id: setting.id, signature, row: setting });
    }

    const plans: SettingMaterializationPlan[] = [];
    for (const plan of latestByPath.values()) {
      const savedSignature = await this.loadSettingMaterializationSignature(plan.path);
      if (!force && savedSignature === plan.signature) continue;
      plans.push(plan);
    }
    return plans;
  }

  private async materializeSettingPlan(plan: SettingMaterializationPlan): Promise<MaterializationOutcome> {
    const current = await this.vault.readText(plan.path);
    const snapshot = await this.loadSettingSnapshot(plan.path);

    if (current !== null && snapshot?.contentHash !== hashText(current)) {
      this.logWarn("Setting materializer skipped due to local drift", { path: plan.path });
      return "skipped-local-drift";
    }

    if (plan.row.type === "delete") {
      this.pendingSettingSeed.delete(plan.path);
      this.tombstoneSettingSnapshot(plan.path);
      if (current !== null) {
        this.pendingRemoteSettingDeletes.add(plan.path);
        try {
          await this.vault.deleteFile(plan.path);
        } finally {
          this.pendingRemoteSettingDeletes.delete(plan.path);
        }
      }
      await this.saveSettingMaterializationSignature(plan.path, plan.signature);
      this.logInfo("Setting materializer applied delete", { path: plan.path });
      return current !== null ? "deleted" : "unchanged";
    }

    const content = await decodeSettingContent(plan.row);
    let changed = false;
    if (current !== content) {
      this.pendingRemoteSettingWrites.add(plan.path);
      try {
        await this.vault.writeText(plan.path, content);
        changed = true;
      } finally {
        this.pendingRemoteSettingWrites.delete(plan.path);
      }
    }
    this.saveSettingSnapshot(plan.path, plan.row.contentHash);
    await this.saveSettingMaterializationSignature(plan.path, plan.signature);
    this.pendingSettingSeed.delete(plan.path);
    this.logInfo("Setting materializer applied update", {
      path: plan.path,
      changed: current !== content,
      contentHash: plan.row.contentHash,
    });
    return changed ? "written" : "unchanged";
  }

  private async handleHistoryQuietTick() {
    if (this.isStopped || !this.isActive) return;
    if (!this.fileInboxInitialized || !this.settingInboxInitialized) return;
    if (
      this.fileInboxRunning ||
      this.settingInboxRunning ||
      this.fileMaterializerRunning ||
      this.settingMaterializerRunning ||
      this.pendingFileInbox.size > 0 ||
      this.pendingSettingInbox.size > 0
    ) {
      this.inboxQuietTicks = 0;
      return;
    }

    if (!this.scanComplete) return;
    if (this.inboxProgressDiscovered > 0 && this.inboxQuietTicks === 0) {
      this.inboxQuietTicks = 1;
      return;
    }

    this.reportSyncProgress?.({
      status: "caught-up",
      message: "LocalSync is caught up.",
    });
    this.inboxProgressKeys.clear();
    this.inboxProgressDiscovered = 0;
    this.inboxProgressApplied = 0;
    this.inboxProgressTotal = null;
    this.inboxProgressTotalPromise = null;
    this.inboxQuietTicks = 0;
    this.fileInboxPageSaturated = false;
    this.settingInboxPageSaturated = false;

    if (!this.pendingVaultSeedReady) {
      this.pendingVaultSeedReady = true;
    } else {
      await this.drainPendingVaultSeed();
      await this.drainPendingSettingSeed();
    }
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
    if (this.localSyncConfig.startupScan && !this.scanComplete) {
      this.logDebug("Periodic settings rescan: startup vault scan not complete, skipping");
      return;
    }
    this.logDebug("Periodic settings rescan: tick");
    if (this.localSyncConfig.syncDeletes) {
      await this.auditSettingSnapshotsForOfflineDeletes("Periodic settings rescan");
    }
    await this.scanSettingsForUnsyncedFiles("Periodic settings rescan");
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

  private async materializeFileHistory(ids: string[]): Promise<{ doc: Y.Doc; text: Y.Text } | null> {
    const rows = await this.loadFileUpdateContentRows(ids);
    const rowsById = new Map<
      string,
      { updateBase64: string; type: string | null }
    >(
      rows
        .filter((row) => row.id && row.updateBase64)
        .map((row) => [
          row.id as string,
          {
            updateBase64: row.updateBase64 as string,
            type: (row.type as string | null) ?? null,
          },
        ]),
    );

    let doc = new Y.Doc();
    let text = doc.getText("content");
    let sawContent = false;

    for (const id of ids) {
      const row = rowsById.get(id);
      if (!row) continue;

      if (row.type === "delete") {
        doc.destroy();
        doc = new Y.Doc();
        text = doc.getText("content");
        sawContent = false;
        continue;
      }

      Y.applyUpdate(doc, fromBase64(row.updateBase64), "remote");
      sawContent = true;
    }

    if (!sawContent) {
      doc.destroy();
      return null;
    }
    return { doc, text };
  }

  private async loadLocalSnapshotText(path: string): Promise<string | null> {
    const snapshotBase64 = await this.loadLocalSnapshot(path);
    if (!snapshotBase64) return null;

    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, fromBase64(snapshotBase64));
      return doc.getText("content").toString();
    } finally {
      doc.destroy();
    }
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

  private createMaterializationSignature(parts: string[]): string {
    return hashText(parts.join("\n"));
  }

  private async loadFileMaterializationSignature(path: string): Promise<string | null> {
    const id = createIdFromString<"FileMaterialization">(`file-materialization:${path}`);
    const q = this.evolu.createQuery((db) =>
      db
        .selectFrom("_fileMaterialization")
        .select(["signature"])
        .where("id", "=", id)
        .where("isDeleted", "is", null)
        .limit(1),
    );
    const rows = await this.evolu.loadQuery(q);
    return rows[0]?.signature ?? null;
  }

  private async saveFileMaterializationSignature(path: string, signature: string) {
    const id = createIdFromString<"FileMaterialization">(`file-materialization:${path}`);
    this.evolu.upsert("_fileMaterialization", { id, path, signature });
  }

  private async loadSettingMaterializationSignature(path: string): Promise<string | null> {
    const id = createIdFromString<"SettingMaterialization">(`setting-materialization:${path}`);
    const q = this.evolu.createQuery((db) =>
      db
        .selectFrom("_settingMaterialization")
        .select(["signature"])
        .where("id", "=", id)
        .where("isDeleted", "is", null)
        .limit(1),
    );
    const rows = await this.evolu.loadQuery(q);
    return rows[0]?.signature ?? null;
  }

  private async saveSettingMaterializationSignature(path: string, signature: string) {
    const id = createIdFromString<"SettingMaterialization">(`setting-materialization:${path}`);
    this.evolu.upsert("_settingMaterialization", { id, path, signature });
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

  private createFileStateFromDoc(
    path: string,
    doc: Y.Doc,
    text: Y.Text,
    lastVaultText: string,
    ignoreNextVaultModify: boolean,
  ): FileState {
    const st: FileState = {
      path,
      doc,
      text,
      lastVaultText,
      ignoreNextVaultModify,
      pendingUpdates: [],
      pendingOutgoingId: null,
      flushTimer: null,
    };

    doc.on("update", (u: Uint8Array, origin: unknown) => {
      // Skip updates applied from the incoming/manual-repair path. Those remote
      // updates must not be echoed back to the network.
      if (origin === "remote") return;
      const outgoingId = getLocalSyncOutgoingId(origin);
      if (outgoingId) {
        st.pendingOutgoingId = st.pendingUpdates.length === 0 ? outgoingId : null;
      } else {
        st.pendingOutgoingId = null;
      }
      st.pendingUpdates.push(u);
      this.scheduleOutgoingFlush(st);
    });

    return st;
  }

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

    const st = this.createFileStateFromDoc(path, doc, text, lastVaultText, false);

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
    if (snapshotBase64) {
      const yjsText = text.toString();
      if (yjsText !== lastVaultText) {
        const snapshotHash = hashText(snapshotBase64);
        const vaultHash = hashText(lastVaultText);
        const outgoingId = createIdFromString<"FileUpdate">(
          `catchup:${path}:${this.deviceId}:${snapshotHash}:${vaultHash}`,
        );
        const previousClientId = doc.clientID;
        doc.clientID = hashTextToClientId(`catchup-client:${path}:${this.deviceId}:${snapshotHash}:${vaultHash}`);
        this.logInfo("getOrLoadFileState: vault drifted from snapshot, applying catch-up diff", {
          path,
          yjsLen: yjsText.length,
          vaultLen: lastVaultText.length,
        });
        try {
          doc.transact(() => {
            applyRebasedTextChangeToYText(text, yjsText, lastVaultText);
          }, { localSyncOutgoingId: outgoingId });
        } finally {
          doc.clientID = previousClientId;
        }
      }
    } else if (!snapshotBase64 && lastVaultText && seedFromVault) {
      const vaultHash = hashText(lastVaultText);
      const outgoingId = createIdFromString<"FileUpdate">(
        `seed:${path}:${this.deviceId}:${vaultHash}`,
      );
      const previousClientId = doc.clientID;
      doc.clientID = hashTextToClientId(`seed-client:${path}:${this.deviceId}:${vaultHash}`);
      try {
        doc.transact(() => text.insert(0, lastVaultText), { localSyncOutgoingId: outgoingId });
      } finally {
        doc.clientID = previousClientId;
      }
    }

    this.states.set(path, st);
    return st;
  }

  private async loadLocalSnapshot(path: string): Promise<string | null> {
    return (await this.loadLocalSnapshotRecord(path))?.snapshotBase64 ?? null;
  }

  private async loadLocalSnapshotRecord(path: string): Promise<FileSnapshot | null> {
    const id = createIdFromString<"FileSnapshot">(`snapshot:${path}`);

    const q = this.evolu.createQuery((db) =>
      db
        .selectFrom("_fileSnapshot")
        .select(["snapshotBase64", "contentHash"])
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
    if (!val || val === "DELETED") return null;
    return {
      snapshotBase64: val,
      contentHash: rows[0].contentHash ?? null,
    };
  }

  private async saveLocalSnapshot(path: string, st: FileState) {
    const snapshotBytes = Y.encodeStateAsUpdate(st.doc);
    const snapshotBase64 = toBase64(snapshotBytes);
    const id = createIdFromString<"FileSnapshot">(`snapshot:${path}`);
    this.evolu.upsert("_fileSnapshot", {
      id,
      path,
      snapshotBase64,
      contentHash: hashText(st.text.toString()),
    });
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
    this.evolu.upsert("_fileSnapshot", { id, path, snapshotBase64: "DELETED", contentHash: null });
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

  private scheduleOutgoingFlush(st: FileState) {
    if (st.flushTimer != null) return;

    st.flushTimer = setTimeout(async () => {
      st.flushTimer = null;
      await this.flushOutgoingUpdates(st.path, st);
    }, this.config.outgoingBatchMs);
  }

  private async flushOutgoingUpdates(path: string, st: FileState): Promise<boolean> {
    try {
      if (st.pendingUpdates.length === 0) return true;

      const merged = Y.mergeUpdates(st.pendingUpdates);

      const updateBase64 = toBase64(merged);
      const id = st.pendingOutgoingId
        ? (st.pendingOutgoingId as any)
        : createIdFromString<"FileUpdate">(
            `upd:${path}:${this.deviceId}:${Date.now()}:${Math.random()}`,
          );

      this.evolu.upsert("fileUpdate", { id, path, updateBase64, originDeviceId: this.deviceId });
      st.pendingUpdates = [];
      st.pendingOutgoingId = null;

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
    this.fileMaterializationBlockedSignatures.delete(path);
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
        originDeviceId: this.deviceId,
      });
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
        if (st.flushTimer != null) {
          clearTimeout(st.flushTimer);
          st.flushTimer = null;
        }
        // The full-state retransmit below already contains these operations.
        st.pendingUpdates = [];
        st.pendingOutgoingId = null;
        st.path = newPath;
        this.states.delete(oldPath);
        this.states.set(newPath, st);
        await this.saveLocalSnapshot(newPath, st);
      }

      this.pendingVaultSeed.delete(oldPath);
      this.fileMaterializationBlockedSignatures.delete(oldPath);
      this.fileMaterializationBlockedSignatures.delete(newPath);
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
        originDeviceId: this.deviceId,
      });

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
          originDeviceId: this.deviceId,
        });
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
