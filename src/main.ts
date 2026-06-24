
import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type ButtonComponent,
  type DataAdapter,
} from "obsidian";

import { createEvoluClient, generateMnemonic, type CloseEvoluDb, type PersistEvoluDb } from "./evoluClient";
import type { PlatformIO } from "./sqliteDriver";
import { Mnemonic } from "@evolu/common";
import type { Evolu } from "@evolu/common";
import type { Database } from "../src-core/schema";
import {
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES,
  DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS,
  DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS,
  DEFAULT_INBOX_CHECKPOINT_BATCH_PATHS,
  YjsEvoluHistoryEngine,
  type ApplyJournalStore,
  type EngineConfig,
  type LogLevel,
  type MaterializationRepairResult,
  type SyncProgress,
} from "../src-core/engine";
import {
  DEFAULT_LOCAL_SYNC_CONFIG,
  isTrackedVaultFile,
  type LocalSyncConfig,
} from "../src-core/pathPolicy";
import { formatLogLine } from "../src-core/logFormat";
import { ObsidianVaultAdapter } from "./obsidianVaultAdapter";
import { replaceAdapterFileFromTemp } from "./adapterAtomicFile";
import { createDeviceId, createReplacementDeviceId } from "./deviceId";

/**
 * Stop promise from the most recently unloaded plugin instance.
 *
 * Obsidian's plugin disable → enable cycle calls `onunload()` synchronously
 * and then immediately calls `onload()` on the new instance.  `engine.stop()`
 * is async (it awaits any in-flight poll + flushes open docs), so without this
 * guard the old instance can still be running its poll when the new instance
 * starts — both share the vault event bus, leading to phantom vault.modify
 * calls and spurious outgoing updates.
 *
 * `onload()` awaits this before starting the engine; `onunload()` chains onto it.
 */
let _previousInstanceStop: Promise<void> = Promise.resolve();

type PluginSettings = {
  relayUrl: string;
  appName: string;
  deviceId: string;

  historyPollMs: number;
  historyBatchSize: number;
  inboxCheckpointBatchPaths: number;
  outgoingBatchMs: number;
  maxOpenDocs: number;
  vaultScanDebugProgressEveryFiles: number;
  vaultScanDebugProgressEveryMs: number;
  vaultScanInfoProgressEveryMs: number;

  includeExtensions: string[];
  excludeGlobs: string[];
  syncObsidianSettings: boolean;
  settingsIncludeGlobs: string[];
  settingsExcludeGlobs: string[];
  syncMainSettings: boolean;
  syncAppearanceSettings: boolean;
  syncHotkeys: boolean;
  syncCorePluginList: boolean;
  syncCorePluginSettings: boolean;
  syncCommunityPluginList: boolean;
  syncCommunityPluginSettings: boolean;
  syncInstalledCommunityPluginFiles: boolean;
  startupScan: boolean;
  mobileStartupScanDefaultApplied: boolean;
  syncDeletes: boolean;
  periodicRescanSeconds: number;
  settingsRescanSeconds: number;

  logLevel: LogLevel;
};

const DEFAULT_SETTINGS: PluginSettings = {
  relayUrl: "wss://free.evoluhq.com",
  appName: "obsidian-local-sync",
  deviceId: createDeviceId(),

  historyPollMs: 1000,
  historyBatchSize: 500,
  inboxCheckpointBatchPaths: DEFAULT_INBOX_CHECKPOINT_BATCH_PATHS,
  outgoingBatchMs: 500,
  maxOpenDocs: 50,
  vaultScanDebugProgressEveryFiles: DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_FILES,
  vaultScanDebugProgressEveryMs: DEFAULT_VAULT_SCAN_DEBUG_PROGRESS_EVERY_MS,
  vaultScanInfoProgressEveryMs: DEFAULT_VAULT_SCAN_INFO_PROGRESS_EVERY_MS,

  includeExtensions: DEFAULT_LOCAL_SYNC_CONFIG.includeExtensions,
  excludeGlobs: DEFAULT_LOCAL_SYNC_CONFIG.excludeGlobs,
  syncObsidianSettings: DEFAULT_LOCAL_SYNC_CONFIG.syncObsidianSettings,
  settingsIncludeGlobs: [],
  settingsExcludeGlobs: [],
  syncMainSettings: true,
  syncAppearanceSettings: true,
  syncHotkeys: true,
  syncCorePluginList: true,
  syncCorePluginSettings: true,
  syncCommunityPluginList: true,
  syncCommunityPluginSettings: true,
  syncInstalledCommunityPluginFiles: false,
  startupScan: DEFAULT_LOCAL_SYNC_CONFIG.startupScan,
  mobileStartupScanDefaultApplied: false,
  syncDeletes: DEFAULT_LOCAL_SYNC_CONFIG.syncDeletes,
  periodicRescanSeconds: DEFAULT_LOCAL_SYNC_CONFIG.periodicRescanSeconds,
  settingsRescanSeconds: DEFAULT_LOCAL_SYNC_CONFIG.settingsRescanSeconds,

  logLevel: "info",
};

const OBSOLETE_VAULT_EXCLUDE_GLOBS = new Set([
  ".git/**",
  ".trash/**",
  ".obsidian/workspace*.json",
  ".obsidian/cache/**",
  ".obsidian/plugins/obsidian-local-sync/*.db",
  ".obsidian/plugins/obsidian-local-sync/*.db-shm",
  ".obsidian/plugins/obsidian-local-sync/*.db-wal",
  ".DS_Store",
  "*.tmp",
  "*.swp",
]);

const SETTINGS_SYNC_RESCAN_SECONDS = 30;
const ATOMIC_DB_TEMP_MAX_AGE_MS = 15 * 60_000;

function toEngineConfig(s: PluginSettings): EngineConfig {
  return {
    historyPollMs: s.historyPollMs,
    historyBatchSize: s.historyBatchSize,
    inboxCheckpointBatchPaths: s.inboxCheckpointBatchPaths,
    outgoingBatchMs: s.outgoingBatchMs,
    maxOpenDocs: s.maxOpenDocs,
    vaultScanDebugProgressEveryFiles: s.vaultScanDebugProgressEveryFiles,
    vaultScanDebugProgressEveryMs: s.vaultScanDebugProgressEveryMs,
    vaultScanInfoProgressEveryMs: s.vaultScanInfoProgressEveryMs,
  };
}

function toLocalSyncConfig(s: PluginSettings): LocalSyncConfig {
  return {
    includeExtensions: normalizeExtensions(s.includeExtensions),
    excludeGlobs: normalizeRules(s.excludeGlobs),
    syncObsidianSettings: s.syncObsidianSettings,
    settingsIncludeGlobs: normalizeRules([
      ...getSettingsCategoryIncludeRules(s),
      ...s.settingsIncludeGlobs,
    ]),
    settingsExcludeGlobs: normalizeRules([
      ...getSettingsCategoryExcludeRules(s),
      ...s.settingsExcludeGlobs,
      ".obsidian/plugins/obsidian-local-sync/**",
    ]),
    startupScan: s.startupScan,
    syncDeletes: s.syncDeletes,
    periodicRescanSeconds: s.periodicRescanSeconds,
    settingsRescanSeconds: s.settingsRescanSeconds,
  };
}

function getSettingsCategoryIncludeRules(s: PluginSettings): string[] {
  const rules: string[] = [];

  if (s.syncMainSettings) {
    rules.push(
      ".obsidian/app.json",
      ".obsidian/backlink.json",
      ".obsidian/bookmarks.json",
      ".obsidian/daily-notes.json",
      ".obsidian/graph.json",
      ".obsidian/types.json",
    );
  }
  if (s.syncAppearanceSettings) {
    rules.push(
      ".obsidian/appearance.json",
      ".obsidian/themes/**",
      ".obsidian/snippets/**",
    );
  }
  if (s.syncHotkeys) rules.push(".obsidian/hotkeys.json");
  if (s.syncCorePluginList) rules.push(".obsidian/core-plugins.json");
  if (s.syncCorePluginSettings) rules.push(".obsidian/*.json");
  if (s.syncCommunityPluginList) rules.push(".obsidian/community-plugins.json");
  if (s.syncCommunityPluginSettings) {
    rules.push(".obsidian/plugins/*/*.json");
  }
  if (s.syncInstalledCommunityPluginFiles) {
    rules.push(
      ".obsidian/plugins/*/main.js",
      ".obsidian/plugins/*/styles.css",
      ".obsidian/plugins/*/manifest.json",
    );
  }

  return rules;
}

function getSettingsCategoryExcludeRules(s: PluginSettings): string[] {
  const rules: string[] = [
    ".obsidian/workspace*.json",
  ];

  if (!s.syncMainSettings) {
    rules.push(
      ".obsidian/app.json",
      ".obsidian/backlink.json",
      ".obsidian/bookmarks.json",
      ".obsidian/daily-notes.json",
      ".obsidian/graph.json",
      ".obsidian/types.json",
    );
  }
  if (!s.syncAppearanceSettings) {
    rules.push(
      ".obsidian/appearance.json",
      ".obsidian/themes/**",
      ".obsidian/snippets/**",
    );
  }
  if (!s.syncHotkeys) rules.push(".obsidian/hotkeys.json");
  if (!s.syncCorePluginList) rules.push(".obsidian/core-plugins.json");
  if (!s.syncCommunityPluginList) rules.push(".obsidian/community-plugins.json");
  if (!s.syncCommunityPluginSettings) {
    rules.push(".obsidian/plugins/*/*.json");
    if (s.syncInstalledCommunityPluginFiles) {
      rules.push("!.obsidian/plugins/*/manifest.json");
    }
  }
  if (!s.syncInstalledCommunityPluginFiles) {
    rules.push(
      ".obsidian/plugins/*/main.js",
      ".obsidian/plugins/*/styles.css",
      ".obsidian/plugins/*/manifest.json",
    );
  }

  return rules;
}

function normalizeExtensions(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().replace(/^\./, "").toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return Array.from(seen);
}

function normalizeRules(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeNonNegativeInt(value: number): number {
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function logInfo(message: string, data?: unknown) {
  console.log(formatLogLine("INFO", message, data));
}

function logWarn(message: string, data?: unknown) {
  console.warn(formatLogLine("WARN", message, data));
}

function logError(message: string, data?: unknown) {
  console.error(formatLogLine("ERROR", message, data));
}

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function normalizedDirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function normalizedBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

async function cleanupStaleAdapterTempFiles(
  adapter: DataAdapter,
  filePath: string,
  maxAgeMs = ATOMIC_DB_TEMP_MAX_AGE_MS,
): Promise<void> {
  const dir = normalizedDirname(filePath);
  const base = normalizedBasename(filePath);
  const now = Date.now();
  let deleted = 0;
  let reclaimedBytes = 0;

  let listed;
  try {
    listed = await adapter.list(dir);
  } catch {
    return;
  }

  for (const tempPath of listed.files) {
    const name = normalizedBasename(tempPath);
    if (!name.startsWith(`${base}.`) || !name.endsWith(".tmp")) continue;

    try {
      const stat = await adapter.stat(tempPath);
      if (!stat || now - stat.mtime < maxAgeMs) continue;
      await adapter.remove(tempPath);
      deleted++;
      reclaimedBytes += stat.size;
    } catch (error) {
      logWarn("Failed to cleanup stale DB temp file", { path: tempPath, error });
    }
  }

  if (deleted > 0) {
    logInfo("Cleaned stale DB temp files", {
      dir,
      deleted,
      reclaimedBytes,
      maxAgeMs,
    });
  }
}

type ResetProgress = {
  message: string;
  current?: number;
  total?: number;
};

type ResetProgressReporter = (progress: ResetProgress) => void;

function createProgressNoticeFragment(progress: ResetProgress): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const container = document.createElement("div");
  container.addClass("localsync-progress-notice");

  const label = document.createElement("div");
  label.textContent = progress.message;
  container.appendChild(label);

  if (progress.total !== undefined) {
    const bar = document.createElement("progress");
    bar.max = progress.total;
    bar.value = progress.current ?? 0;
    container.appendChild(bar);

    const detail = document.createElement("div");
    detail.addClass("localsync-progress-detail");
    detail.textContent = `${progress.current ?? 0} / ${progress.total}`;
    container.appendChild(detail);
  }

  fragment.appendChild(container);
  return fragment;
}

function formatMaterializationRepairSummary(result: MaterializationRepairResult): string {
  const planned = result.files.planned + result.settings.planned;
  const written = result.files.written + result.settings.written;
  const deleted = result.files.deleted + result.settings.deleted;
  const unchanged = result.files.unchanged + result.settings.unchanged;
  const skipped = result.files.skippedLocalDrift + result.settings.skippedLocalDrift;
  const failed = result.files.failed + result.settings.failed;
  return `Materialization repair done: planned ${planned}, wrote ${written}, deleted ${deleted}, unchanged ${unchanged}, skipped local drift ${skipped}, failed ${failed}.`;
}

const SYNC_PROGRESS_NOTICE_MIN_ROWS = 5;

export default class ObsidianLocalSyncPlugin extends Plugin {
  settings!: PluginSettings;

  evolu!: Evolu<Database>;
  closeEvoluDb: CloseEvoluDb | null = null;
  persistEvoluDb: PersistEvoluDb | null = null;
  engine: YjsEvoluHistoryEngine | null = null;
  mnemonicCache: Mnemonic | null = null;

  /**
   * Set to true the moment onunload() is called.  Checked at every async
   * resume point in onload/startEngine so a superseded instance bails out
   * before registering vault event handlers or starting the poll loop.
   */
  private _unloaded = false;
  private suppressVaultEvents = false;
  private syncProgressNotice: Notice | null = null;
  private syncProgressHideTimer: number | null = null;
  private syncProgressStatus: SyncProgress["status"] = "caught-up";

  async onload() {
    // Wait for any previous instance to fully stop before starting a new one.
    // Obsidian calls onunload() + onload() back-to-back; without this guard the
    // old engine's in-flight poll can still be running when the new engine starts,
    // causing phantom vault.modify events and spurious outgoing updates.
    await _previousInstanceStop;
    if (this._unloaded) return; // unloaded before we even began

    await this.loadSettings();
    if (this._unloaded) return; // unloaded during settings load

    // ----------------------------
    // Settings UI
    // ----------------------------
    this.addSettingTab(new LocalSyncSettingTab(this.app, this));

    // Defer engine start until the workspace layout is ready.
    //
    // During initial Obsidian startup, vault.getFiles() returns an empty or
    // incomplete list if called before the workspace finishes indexing files.
    // auditSnapshotsForOfflineDeletes() calls vault.getFiles() to build the
    // set of existing paths and treats any snapshot path absent from that set
    // as an offline delete.  If the vault isn't ready yet, every snapshotted
    // file is falsely treated as deleted — delete rows are emitted for all
    // files. Remote peers would then materialize those delete rows and trash
    // their local files too.
    //
    // onLayoutReady fires synchronously if the workspace is already ready
    // (on plugin reload mid-session), or deferred until it is (initial boot).
    this.app.workspace.onLayoutReady(() => {
      if (this._unloaded) return;
      this.startEngine().catch((e) => {
        if (!this._unloaded) {
          logError("Failed to start engine", e);
          new Notice("LocalSync: failed to start — check console for details");
        }
      });
    });
  }

  /**
   * Returns platform-independent file I/O for the plugin's SQLite database.
   *
   * Obsidian's `DataAdapter` API (`readBinary` / `writeBinary`) is available
   * on both desktop (FileSystemAdapter, backed by Node fs) and mobile
   * (MobileAdapter, backed by Capacitor).  Using it here removes all direct
   * `node:fs` / `node:path` imports from the plugin bundle, which allows the
   * plugin to load on Android and iOS where those Node globals do not exist.
   *
   * The DB file lives at `<vault>/<configDir>/plugins/<pluginId>/<appName>.db`
   * — the same directory Obsidian already created for the plugin.
   */
  private buildIO(appName: string): PlatformIO {
    const dbPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/${appName}.db`;
    return {
      readFile: async () => {
        try {
          // Check existence first: on Android, readBinary emits a native-level
          // "File does not exist" error to the console before the JS exception
          // propagates, causing noisy but harmless log spam on first startup.
          if (!(await this.app.vault.adapter.exists(dbPath))) return null;
          const buf = await this.app.vault.adapter.readBinary(dbPath);
          return new Uint8Array(buf);
        } catch {
          return null;
        }
      },
      writeFile: async (data: Uint8Array) => {
        const tempPath = `${dbPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        const adapter = this.app.vault.adapter;
        await cleanupStaleAdapterTempFiles(adapter, dbPath);
        try {
          await adapter.writeBinary(tempPath, exactArrayBuffer(data));
          await replaceAdapterFileFromTemp(adapter, tempPath, dbPath);
        } catch (error) {
          try {
            if (await adapter.exists(tempPath)) await adapter.remove(tempPath);
          } catch {
            // Best effort cleanup only.
          }
          throw error;
        }
      },
      deleteFile: async () => {
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(dbPath)) await adapter.remove(dbPath);
      },
    };
  }

  private buildApplyJournalStore(appName: string): ApplyJournalStore {
    const journalPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/${appName}.apply.wal`;
    const adapter = this.app.vault.adapter;
    return {
      load: async () => {
        if (!(await adapter.exists(journalPath))) return null;
        return JSON.parse(await adapter.read(journalPath));
      },
      save: async (journal) => {
        const tempPath = `${journalPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        await cleanupStaleAdapterTempFiles(adapter, journalPath);
        try {
          await adapter.write(tempPath, JSON.stringify(journal));
          await replaceAdapterFileFromTemp(adapter, tempPath, journalPath);
        } catch (error) {
          try {
            if (await adapter.exists(tempPath)) await adapter.remove(tempPath);
          } catch {
            // Best effort cleanup only.
          }
          throw error;
        }
      },
      clear: async () => {
        if (await adapter.exists(journalPath)) await adapter.remove(journalPath);
      },
    };
  }

  private async startEngine() {
    // ----------------------------
    // Create Evolu client
    // ----------------------------
    const { evolu, closeDb, persistDb } = createEvoluClient(
      this.settings.appName,
      this.settings.relayUrl,
      this.buildIO(this.settings.appName),
    );
    this.evolu = evolu;
    this.closeEvoluDb = closeDb;
    this.persistEvoluDb = persistDb;

    if (this.settings.logLevel !== "off") {
      logInfo("Evolu client created", {
        appName: this.settings.appName,
        relayUrl: this.settings.relayUrl,
        deviceId: this.settings.deviceId,
      });
    }

    // ----------------------------
    // Log Evolu owner state
    // ----------------------------
    if (this.settings.logLevel !== "off") {
      const owner = await this.evolu.appOwner;
      logInfo("Evolu owner loaded", {
        hasMnemonic: !!owner?.mnemonic,
      });
    }

    // ----------------------------
    // Subscribe to Evolu errors
    // ----------------------------
    this.evolu.subscribeError(() => {
      const error = this.evolu.getError();
      if (error) {
        logError("Evolu error", error);
      }
    });

    // ----------------------------
    // Create Engine
    // ----------------------------
    this.engine = new YjsEvoluHistoryEngine({
      vault: new ObsidianVaultAdapter(this.app.vault),
      evolu: this.evolu,
      deviceId: this.settings.deviceId,
      config: toEngineConfig(this.settings),
      localSyncConfig: toLocalSyncConfig(this.settings),
      logLevel: this.settings.logLevel,
      reportSyncProgress: (progress) => this.handleSyncProgress(progress),
      persistLocalDb: this.persistEvoluDb,
      applyJournalStore: this.buildApplyJournalStore(this.settings.appName),
    });

    await this.engine.start();

    // Bail out if onunload() fired while the engine was starting.
    // Without this check a superseded instance would register vault event
    // handlers that outlive the instance, firing into a stopped engine.
    if (this._unloaded) {
      void this.engine?.stop();
      return;
    }

    // ----------------------------
    // Listen to vault changes
    // ----------------------------
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (this.suppressVaultEvents) return;
        if (file instanceof TFile) {
          await this.engine?.onVaultFileChanged(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.suppressVaultEvents) return;
        if (file instanceof TFile) {
          void this.engine?.onVaultFileDeleted(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.suppressVaultEvents) return;
        if (file instanceof TFile) {
          void this.engine?.onVaultFileRenamed(oldPath, file.path);
        }
      }),
    );

    // ----------------------------
    // Active / inactive tracking
    // ----------------------------
    this.registerDomEvent(window, "focus", () => {
      void this.engine?.setActive();
    });

    this.registerDomEvent(window, "blur", () => {
      this.engine?.setInactive();
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.engine?.setActive();
      } else {
        this.engine?.setInactive();
      }
    });
  }

  onunload() {
    // Signal any still-running onload/startEngine to abort at its next
    // async resume point — prevents a superseded instance from registering
    // vault event handlers or starting the poll loop after being unloaded.
    this._unloaded = true;

    // Chain closeEvoluDb *after* stop resolves so the cursor write from any
    // in-progress poll is committed to the in-memory DB before we flush to disk.
    //
    // Append to the existing chain rather than overwriting it.  Under rapid
    // consecutive restarts, overwriting would allow instance N+2 to start
    // before instance N has finished stopping (because N+1's engine may not
    // have been created yet, making its stop a no-op that resolves immediately).
    // Chaining ensures every subsequent onload() awaits ALL prior stops.
    _previousInstanceStop = _previousInstanceStop.then(() =>
      (this.engine?.stop() ?? Promise.resolve()).then(() => this.closeEvoluDb?.()),
    );
    if (this.syncProgressHideTimer != null) {
      window.clearTimeout(this.syncProgressHideTimer);
      this.syncProgressHideTimer = null;
    }
    this.syncProgressNotice?.hide();
    this.syncProgressNotice = null;
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    let migrated = false;

    if (
      saved &&
      !("syncMainSettings" in saved) &&
      JSON.stringify(normalizeRules(saved.settingsIncludeGlobs ?? [])) ===
        JSON.stringify([".obsidian/**/*.json"])
    ) {
      this.settings.settingsIncludeGlobs = [];
      migrated = true;
    }
    if (saved?.syncObsidianSettings && saved.settingsRescanSeconds === undefined) {
      this.settings.settingsRescanSeconds = SETTINGS_SYNC_RESCAN_SECONDS;
      migrated = true;
    }
    if (
      saved &&
      "syncInstalledCommunityPlugins" in saved &&
      !("syncInstalledCommunityPluginFiles" in saved)
    ) {
      const oldValue = Boolean((saved as { syncInstalledCommunityPlugins?: boolean }).syncInstalledCommunityPlugins);
      this.settings.syncInstalledCommunityPluginFiles = oldValue;
      if (oldValue) this.settings.syncCommunityPluginSettings = true;
      delete (this.settings as { syncInstalledCommunityPlugins?: boolean }).syncInstalledCommunityPlugins;
      migrated = true;
    }
    if (!saved?.mobileStartupScanDefaultApplied) {
      if (Platform.isMobile) this.settings.startupScan = false;
      this.settings.mobileStartupScanDefaultApplied = true;
      migrated = true;
    }
    this.settings.includeExtensions = normalizeExtensions(this.settings.includeExtensions);
    this.settings.excludeGlobs = normalizeRules(this.settings.excludeGlobs).filter((rule) => {
      const keep = !OBSOLETE_VAULT_EXCLUDE_GLOBS.has(rule);
      if (!keep) migrated = true;
      return keep;
    });
    this.settings.settingsIncludeGlobs = normalizeRules(this.settings.settingsIncludeGlobs);
    this.settings.settingsExcludeGlobs = normalizeRules(this.settings.settingsExcludeGlobs);
    this.settings.periodicRescanSeconds = normalizeNonNegativeInt(this.settings.periodicRescanSeconds);
    this.settings.settingsRescanSeconds = normalizeNonNegativeInt(this.settings.settingsRescanSeconds);
    // Persist the generated deviceId on first install so it survives restarts.
    if (!saved?.deviceId || migrated) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async applyEngineConfigFromSettings() {
    await this.saveSettings();
    await this.engine?.updateConfig(toEngineConfig(this.settings));
  }

  async applyLocalSyncConfigFromSettings() {
    this.settings.includeExtensions = normalizeExtensions(this.settings.includeExtensions);
    this.settings.excludeGlobs = normalizeRules(this.settings.excludeGlobs);
    this.settings.settingsIncludeGlobs = normalizeRules(this.settings.settingsIncludeGlobs);
    this.settings.settingsExcludeGlobs = normalizeRules(this.settings.settingsExcludeGlobs);
    this.settings.periodicRescanSeconds = normalizeNonNegativeInt(this.settings.periodicRescanSeconds);
    this.settings.settingsRescanSeconds = normalizeNonNegativeInt(this.settings.settingsRescanSeconds);
    await this.saveSettings();
    this.engine?.updateLocalSyncConfig(toLocalSyncConfig(this.settings));
  }

  async applyLogLevelFromSettings() {
    await this.saveSettings();
    this.engine?.setLogLevel(this.settings.logLevel);
  }

  async runMaterializationRepairNow(): Promise<MaterializationRepairResult> {
    if (!this.engine) {
      throw new Error("LocalSync engine is not running");
    }
    return this.engine.runMaterializationRepairNow();
  }

  async runVaultScanNow(): Promise<void> {
    if (!this.engine) {
      throw new Error("LocalSync engine is not running");
    }
    await this.engine.runVaultScanNow();
  }

  /**
   * Prepare for a reset/restore: stop the engine without flushing, then wait a
   * macrotask tick so all pending Evolu microtasks (processMutationQueue) drain
   * before the caller issues the reset/restore to the DB worker.
   *
   * Evolu's DB worker runs on the main thread (no real Worker). Calling
   * dbWorker.postMessage("reset") drops all tables synchronously. Any mutation
   * that was queued via queueMicrotask fires *after* the drop but in the same
   * macrotask, hitting the now-empty DB and producing a SqliteError. The
   * setTimeout(0) forces those microtasks to flush before the caller proceeds.
   */
  async prepareForOwnerChange() {
    await this.engine?.stop(false);
    await this.buildApplyJournalStore(this.settings.appName).clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Restart the engine after reset/restore.
   *
   * The old Evolu client's WebSocket relay connection was established with the
   * previous owner identity.  After restoreAppOwner the in-memory DB has the
   * new identity, but the relay session still uses the old write key — so sync
   * never authenticates and evolu_history stays empty.  We must flush the new
   * DB state to disk, then tear down and recreate the full Evolu client so the
   * new client opens a fresh relay connection with the restored identity.
   *
   * The vault event handlers were registered once in startEngine and all read
   * this.engine at call-time, so replacing the field is enough.
   */
  async restartEngine() {
    // Flush the new DB state (written by restoreAppOwner) to disk.
    await this.closeEvoluDb?.();
    this.closeEvoluDb = null;
    this.persistEvoluDb = null;

    // Recreate the Evolu client: fresh DB connection + new relay WebSocket.
    const { evolu, closeDb, persistDb } = createEvoluClient(
      this.settings.appName,
      this.settings.relayUrl,
      this.buildIO(this.settings.appName),
      { forceNew: true }, // new mnemonic → new relay WebSocket required
    );
    this.evolu = evolu;
    this.closeEvoluDb = closeDb;
    this.persistEvoluDb = persistDb;

    this.engine = new YjsEvoluHistoryEngine({
      vault: new ObsidianVaultAdapter(this.app.vault),
      evolu: this.evolu,
      deviceId: this.settings.deviceId,
      config: toEngineConfig(this.settings),
      localSyncConfig: toLocalSyncConfig(this.settings),
      logLevel: this.settings.logLevel,
      reportSyncProgress: (progress) => this.handleSyncProgress(progress),
      persistLocalDb: this.persistEvoluDb,
      applyJournalStore: this.buildApplyJournalStore(this.settings.appName),
    });
    await this.engine.start();
  }

  private handleSyncProgress(progress: SyncProgress) {
    if (this._unloaded) return;

    const shouldShow =
      progress.status !== "syncing" ||
      (progress.total ?? 0) >= SYNC_PROGRESS_NOTICE_MIN_ROWS ||
      this.syncProgressNotice !== null;
    if (!shouldShow) return;

    if (progress.status === "caught-up" && this.syncProgressStatus === "caught-up") {
      return;
    }
    this.syncProgressStatus = progress.status;

    if (this.syncProgressHideTimer != null) {
      window.clearTimeout(this.syncProgressHideTimer);
      this.syncProgressHideTimer = null;
    }

    if (progress.status === "caught-up" && !this.syncProgressNotice) return;

    if (!this.syncProgressNotice) {
      this.syncProgressNotice = new Notice(createProgressNoticeFragment(progress), 0);
    } else {
      this.syncProgressNotice.setMessage(createProgressNoticeFragment(progress));
    }

    if (progress.status === "caught-up") {
      this.syncProgressHideTimer = window.setTimeout(() => {
        this.syncProgressNotice?.hide();
        this.syncProgressNotice = null;
        this.syncProgressHideTimer = null;
        this.syncProgressStatus = "caught-up";
      }, 3500);
    }
  }

  async resetLocalSyncState(reportProgress?: ResetProgressReporter): Promise<number> {
    const mnemonic =
      this.mnemonicCache ??
      (await this.evolu.appOwner)?.mnemonic;
    if (!mnemonic) {
      throw new Error("Cannot reset LocalSync state: no Evolu owner mnemonic found");
    }

    return this.recreateLocalStateWithMnemonic(mnemonic, "existing", reportProgress);
  }

  async restoreMnemonicWithLocalWipe(
    mnemonic: Mnemonic,
    reportProgress?: ResetProgressReporter,
  ): Promise<number> {
    return this.recreateLocalStateWithMnemonic(mnemonic, "restored", reportProgress);
  }

  private async recreateLocalStateWithMnemonic(
    mnemonic: Mnemonic,
    mnemonicLabel: "existing" | "restored",
    reportProgress?: ResetProgressReporter,
  ): Promise<number> {
    reportProgress?.({ message: "Stopping LocalSync engine..." });
    await this.engine?.stop(false);

    const deleted = await this.wipeSyncedVaultFiles(reportProgress);

    reportProgress?.({ message: "Closing local database..." });
    await this.closeEvoluDb?.({ flush: false });
    this.closeEvoluDb = null;
    this.persistEvoluDb = null;

    reportProgress?.({ message: "Deleting local database..." });
    const io = this.buildIO(this.settings.appName);
    await this.buildApplyJournalStore(this.settings.appName).clear();
    await io.deleteFile?.();

    // A fresh local database must also use a fresh peer identity. The inbox
    // intentionally ignores rows originating from this deviceId to prevent
    // live self-echoes. Reusing the old ID after a destructive reset would
    // therefore hide every remote history row originally authored by this
    // device, leaving a rebuilt vault with only other peers' files.
    reportProgress?.({ message: "Rotating local peer identity..." });
    this.settings.deviceId = createReplacementDeviceId(this.settings.deviceId);
    await this.saveSettings();

    reportProgress?.({ message: "Creating fresh local database..." });
    const { evolu, closeDb, persistDb } = createEvoluClient(
      this.settings.appName,
      this.settings.relayUrl,
      io,
      { forceNew: true },
    );
    this.evolu = evolu;
    this.closeEvoluDb = closeDb;
    this.persistEvoluDb = persistDb;
    reportProgress?.({ message: `Restoring ${mnemonicLabel} mnemonic...` });
    await this.evolu.restoreAppOwner(mnemonic, { reload: false });
    this.mnemonicCache = mnemonic;
    reportProgress?.({ message: "Restarting sync..." });
    await this.restartEngine();
    reportProgress?.({ message: `Reset complete. Deleted ${deleted} local file(s).` });
    return deleted;
  }

  private async wipeSyncedVaultFiles(reportProgress?: ResetProgressReporter): Promise<number> {
    const config = toLocalSyncConfig(this.settings);
    const paths = new Set<string>();

    for (const file of this.app.vault.getFiles()) {
      if (isTrackedVaultFile(file, config)) paths.add(file.path);
    }

    this.suppressVaultEvents = true;
    try {
      let deleted = 0;
      const failed: string[] = [];
      const orderedPaths = Array.from(paths).sort().reverse();
      reportProgress?.({
        message: orderedPaths.length > 0 ? "Deleting synced vault files..." : "No synced vault files to delete.",
        current: 0,
        total: orderedPaths.length,
      });

      for (let index = 0; index < orderedPaths.length; index++) {
        const path = orderedPaths[index];
        try {
          if (!(await this.app.vault.adapter.exists(path))) {
            reportProgress?.({
              message: "Deleting synced vault files...",
              current: index + 1,
              total: orderedPaths.length,
            });
            continue;
          }
          await this.app.vault.adapter.remove(path);
          if (await this.app.vault.adapter.exists(path)) {
            failed.push(path);
            reportProgress?.({
              message: "Deleting synced vault files...",
              current: index + 1,
              total: orderedPaths.length,
            });
            continue;
          }
          deleted++;
        } catch (error) {
          failed.push(path);
          logError("LocalSync synced vault file wipe failed", { path, error });
        }
        reportProgress?.({
          message: "Deleting synced vault files...",
          current: index + 1,
          total: orderedPaths.length,
        });
      }
      logWarn("LocalSync synced vault files wiped", { deleted, failed: failed.length });
      if (failed.length > 0) {
        throw new Error(`Failed to delete ${failed.length} synced vault file(s)`);
      }
      return deleted;
    } finally {
      this.suppressVaultEvents = false;
    }
  }

}

class LocalSyncSettingTab extends PluginSettingTab {
  plugin: ObsidianLocalSyncPlugin;

  constructor(app: App, plugin: ObsidianLocalSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("localsync-settings");

    const markWide = (setting: Setting) => {
      setting.settingEl.addClass("localsync-wide-setting");
      return setting;
    };

    containerEl.createEl("h2", { text: "LocalSync" });

    // ----------------------------
    // Logging
    // ----------------------------
    new Setting(containerEl)
      .setName("Log level")
      .setDesc("Controls console logging.")
      .addDropdown((dd) => {
        dd.addOption("off", "Off");
        dd.addOption("error", "Error");
        dd.addOption("warn", "Warn");
        dd.addOption("info", "Info");
        dd.addOption("debug", "Debug");

        dd.setValue(this.plugin.settings.logLevel);

        dd.onChange(async (value) => {
          this.plugin.settings.logLevel = value as LogLevel;
          await this.plugin.applyLogLevelFromSettings();
          new Notice(`Log level set to ${value}`);
        });
      });

    const addEngineNumberSetting = (
      name: string,
      desc: string,
      key: keyof Pick<
        PluginSettings,
        | "historyPollMs"
        | "historyBatchSize"
        | "inboxCheckpointBatchPaths"
        | "outgoingBatchMs"
        | "maxOpenDocs"
        | "vaultScanDebugProgressEveryFiles"
        | "vaultScanDebugProgressEveryMs"
        | "vaultScanInfoProgressEveryMs"
      >,
      min: number,
      noticeLabel: string,
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text.setValue(String(this.plugin.settings[key]));
          text.inputEl.addEventListener("change", async () => {
            const n = Number(text.inputEl.value);
            if (!Number.isInteger(n) || n < min) {
              text.setValue(String(this.plugin.settings[key]));
              new Notice(`${noticeLabel} must be at least ${min}`);
              return;
            }
            this.plugin.settings[key] = Math.floor(n);
            await this.plugin.applyEngineConfigFromSettings();
            new Notice(`${noticeLabel} set to ${this.plugin.settings[key]}`);
          });
        });
    };

    addEngineNumberSetting(
      "Info scan progress interval (ms)",
      "Emit aggregate startup scan progress at info level. Set to 0 to disable.",
      "vaultScanInfoProgressEveryMs",
      0,
      "Info scan progress interval",
    );

    addEngineNumberSetting(
      "Debug scan progress interval (ms)",
      "Emit detailed startup scan progress at debug level by elapsed time. Set to 0 to disable.",
      "vaultScanDebugProgressEveryMs",
      0,
      "Debug scan progress interval",
    );

    addEngineNumberSetting(
      "Debug scan progress files",
      "Emit detailed startup scan progress at debug level every N tracked files. Set to 0 to disable.",
      "vaultScanDebugProgressEveryFiles",
      0,
      "Debug scan progress files",
    );

    // ----------------------------
    // Sync
    // ----------------------------
    containerEl.createEl("h3", { text: "Sync" });

    containerEl.createEl("h3", { text: "Vault sync" });

    const setExtensionEnabled = async (extension: string, enabled: boolean) => {
      const extensions = new Set(normalizeExtensions(this.plugin.settings.includeExtensions));
      if (enabled) extensions.add(extension);
      else extensions.delete(extension);
      if (extensions.size === 0) {
        new Notice("At least one vault file type must be enabled");
        return false;
      }
      this.plugin.settings.includeExtensions = Array.from(extensions);
      await this.plugin.applyLocalSyncConfigFromSettings();
      return true;
    };

    new Setting(containerEl)
      .setName("Notes")
      .setDesc("Sync Markdown note files with the .md extension.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeExtensions.includes("md"));
        toggle.onChange(async (value) => {
          const changed = await setExtensionEnabled("md", value);
          if (!changed) toggle.setValue(true);
        });
      });

    new Setting(containerEl)
      .setName("Text files")
      .setDesc("Sync plain text files with the .txt extension.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeExtensions.includes("txt"));
        toggle.onChange(async (value) => {
          const changed = await setExtensionEnabled("txt", value);
          if (!changed) toggle.setValue(true);
        });
      });

    new Setting(containerEl)
      .setName("Canvases")
      .setDesc("Sync Obsidian canvas files with the .canvas extension.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeExtensions.includes("canvas"));
        toggle.onChange(async (value) => {
          const changed = await setExtensionEnabled("canvas", value);
          if (!changed) toggle.setValue(true);
        });
      });

    new Setting(containerEl)
      .setName("Sync deletes")
      .setDesc("Propagate local deletes and startup offline-delete audit rows.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncDeletes);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncDeletes = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
          new Notice(`Delete sync ${value ? "enabled" : "disabled"}`);
        });
      });

    new Setting(containerEl)
      .setName("Startup scan")
      .setDesc(
        Platform.isMobile
          ? "Detect changes made while LocalSync was stopped. Disabled by default on mobile; external file changes may be missed until a manual or periodic scan."
          : "Detect changes made while LocalSync was stopped by scanning tracked vault files at startup.",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.startupScan);
        toggle.onChange(async (value) => {
          this.plugin.settings.startupScan = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
          new Notice(`Startup scan ${value ? "enabled" : "disabled"}`);
        });
      });

    new Setting(containerEl)
      .setName("Vault rescan interval (seconds)")
      .setDesc("Scan tracked vault files periodically. Set to 0 to disable.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.periodicRescanSeconds));
        text.inputEl.addEventListener("change", async () => {
          const n = Number(text.inputEl.value);
          if (!Number.isInteger(n) || n < 0) {
            text.setValue(String(this.plugin.settings.periodicRescanSeconds));
            new Notice("Vault rescan interval must be 0 or a positive whole number of seconds");
            return;
          }
          this.plugin.settings.periodicRescanSeconds = n;
          await this.plugin.applyLocalSyncConfigFromSettings();
          new Notice(n > 0 ? `Vault rescan every ${n} seconds` : "Vault rescan disabled");
        });
      });

    markWide(new Setting(containerEl))
      .setName("Excluded paths")
      .setDesc("Optional Obsidian-visible vault paths. One rule per line. Later rules win; prefix with ! to re-include.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 8;
        ta.inputEl.addClass("localsync-wide-input");
        ta.setPlaceholder("archive/**\n!archive/keep/**");
        ta.setValue(this.plugin.settings.excludeGlobs.join("\n"));
        ta.onChange(async (value) => {
          this.plugin.settings.excludeGlobs = value.split(/\r?\n/);
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    containerEl.createEl("h3", { text: "Maintenance" });

    new Setting(containerEl)
      .setName("Local vault scan")
      .setDesc("Check tracked files now for changes made while LocalSync was stopped or outside Obsidian.")
      .addButton((btn) => {
        btn.setButtonText("Scan now").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Scanning...");
          try {
            await this.plugin.runVaultScanNow();
            new Notice("LocalSync vault scan complete");
          } catch (error) {
            logError("Manual vault scan failed", error);
            new Notice("LocalSync vault scan failed. Check console.");
          } finally {
            btn.setButtonText("Scan now");
            btn.setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Materialization repair")
      .setDesc("Rebuild local files from synced LocalSync rows now. Files with local drift are skipped.")
      .addButton((btn) => {
        btn.setButtonText("Run now").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Running...");
          const notice = new Notice("Running LocalSync materialization repair...", 0);
          try {
            const result = await this.plugin.runMaterializationRepairNow();
            notice.setMessage(formatMaterializationRepairSummary(result));
            window.setTimeout(() => notice.hide(), 8000);
          } catch (error) {
            logError("Manual materialization repair failed", error);
            notice.setMessage("Materialization repair failed. Check console.");
            window.setTimeout(() => notice.hide(), 8000);
          } finally {
            btn.setButtonText("Run now");
            btn.setDisabled(false);
          }
        });
      });

    containerEl.createEl("h3", { text: "Obsidian settings sync" });

    new Setting(containerEl)
      .setName("Sync Obsidian settings")
      .setDesc("Sync allowlisted .obsidian settings files as plain last-writer-wins files.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncObsidianSettings);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncObsidianSettings = value;
          if (value && this.plugin.settings.settingsRescanSeconds === 0) {
            this.plugin.settings.settingsRescanSeconds = SETTINGS_SYNC_RESCAN_SECONDS;
            new Notice(`Settings rescan enabled every ${SETTINGS_SYNC_RESCAN_SECONDS} seconds`);
          }
          await this.plugin.applyLocalSyncConfigFromSettings();
          new Notice(`Obsidian settings sync ${value ? "enabled" : "disabled"}`);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Settings rescan interval (seconds)")
      .setDesc("Scan .obsidian settings periodically. Set to 0 to disable.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.settingsRescanSeconds));
        text.inputEl.addEventListener("change", async () => {
          const n = Number(text.inputEl.value);
          if (!Number.isInteger(n) || n < 0) {
            text.setValue(String(this.plugin.settings.settingsRescanSeconds));
            new Notice("Settings rescan interval must be 0 or a positive whole number of seconds");
            return;
          }
          this.plugin.settings.settingsRescanSeconds = n;
          await this.plugin.applyLocalSyncConfigFromSettings();
          new Notice(n > 0 ? `Settings rescan every ${n} seconds` : "Settings rescan disabled");
        });
      });

    new Setting(containerEl)
      .setName("Main settings")
      .setDesc("Sync editor settings, links, graph, bookmarks, daily notes, and file types.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncMainSettings);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncMainSettings = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    new Setting(containerEl)
      .setName("Appearance settings")
      .setDesc("Sync appearance settings, themes, and snippets.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncAppearanceSettings);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncAppearanceSettings = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    new Setting(containerEl)
      .setName("Hotkeys")
      .setDesc("Sync custom hotkeys.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncHotkeys);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncHotkeys = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    new Setting(containerEl)
      .setName("Active core plugin list")
      .setDesc("Sync which core plugins are enabled.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncCorePluginList);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncCorePluginList = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    new Setting(containerEl)
      .setName("Core plugin settings")
      .setDesc("Sync top-level Obsidian JSON settings, excluding workspace state.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncCorePluginSettings);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncCorePluginSettings = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    new Setting(containerEl)
      .setName("Active community plugin list")
      .setDesc("Sync which community plugins are enabled.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncCommunityPluginList);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncCommunityPluginList = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    new Setting(containerEl)
      .setName("Community plugin settings")
      .setDesc("Sync .obsidian/plugins/*/*.json settings, excluding plugin manifests unless installed plugin files are enabled.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncCommunityPluginSettings);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncCommunityPluginSettings = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    new Setting(containerEl)
      .setName("Installed community plugin files")
      .setDesc("Sync installed plugin main.js, styles.css, and manifest.json files. Disabled by default; enable only when plugin installations should follow this vault.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncInstalledCommunityPluginFiles);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncInstalledCommunityPluginFiles = value;
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    containerEl.createEl("h3", { text: "Advanced policy" });

    markWide(new Setting(containerEl))
      .setName("Settings include rules")
      .setDesc("Optional extra .obsidian include rules. One rule per line.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 4;
        ta.inputEl.addClass("localsync-wide-input");
        ta.setPlaceholder(".obsidian/plugins/my-plugin/**");
        ta.setValue(this.plugin.settings.settingsIncludeGlobs.join("\n"));
        ta.onChange(async (value) => {
          this.plugin.settings.settingsIncludeGlobs = value.split(/\r?\n/);
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    markWide(new Setting(containerEl))
      .setName("Settings exclude rules")
      .setDesc("Optional .obsidian exclude rules. One rule per line. Later rules win; prefix with ! to re-include.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 4;
        ta.inputEl.addClass("localsync-wide-input");
        ta.setPlaceholder(".obsidian/plugins/some-plugin/**");
        ta.setValue(this.plugin.settings.settingsExcludeGlobs.join("\n"));
        ta.onChange(async (value) => {
          this.plugin.settings.settingsExcludeGlobs = value.split(/\r?\n/);
          await this.plugin.applyLocalSyncConfigFromSettings();
        });
      });

    // ----------------------------
    // Performance
    // ----------------------------
    containerEl.createEl("h3", { text: "Performance" });

    addEngineNumberSetting("Quiet cycle interval (ms)", "How often to run deferred seed and inventory checks.", "historyPollMs", 100, "Quiet interval");

    addEngineNumberSetting("Incoming batch size", "Maximum pending remote rows processed per inbox batch.", "historyBatchSize", 10, "Batch size");

    addEngineNumberSetting("Checkpoint batch paths", "Maximum changed paths persisted in one crash-recoverable inbox checkpoint.", "inboxCheckpointBatchPaths", 1, "Checkpoint batch paths");

    addEngineNumberSetting("Outgoing batch interval (ms)", "Minimum time between sending Yjs updates.", "outgoingBatchMs", 50, "Outgoing interval");

    addEngineNumberSetting("Max open Yjs docs (LRU)", "How many files keep Yjs state in memory.", "maxOpenDocs", 5, "Max open docs");

    // ----------------------------
    // Evolu Sync Key (Mnemonic)
    // ----------------------------
    containerEl.createEl("h3", { text: "Sync Key (Mnemonic)" });

    markWide(new Setting(containerEl))
      .setName("Relay URL")
      .setDesc("WebSocket relay endpoint. Changes take effect after reloading Obsidian.")
      .addText((text) => {
        text.inputEl.addClass("localsync-wide-input");
        text
          .setPlaceholder("wss://free.evoluhq.com")
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed.startsWith("wss://") && !trimmed.startsWith("ws://")) {
              new Notice("Relay URL must start with wss:// or ws://");
              return;
            }
            this.plugin.settings.relayUrl = trimmed;
            await this.plugin.saveSettings();
          });
      });

    // -- Reveal / copy --
    const revealSetting = new Setting(containerEl)
      .setName("Your mnemonic")
      .setDesc("24-word key — copy this to each device you want to sync.");
    revealSetting.settingEl.addClass("localsync-mnemonic-setting");

    const mnemonicBox = revealSetting.settingEl.createDiv({ cls: "localsync-mnemonic-box" });
    mnemonicBox.style.display = "none";

    const mnemonicInput = mnemonicBox.createEl("input");
    mnemonicInput.type = "text";
    mnemonicInput.readOnly = true;
    mnemonicInput.addClass("localsync-mnemonic-input");

    revealSetting
      .addButton((btn) => {
        btn.setButtonText("Reveal").onClick(async () => {
          if (mnemonicBox.style.display === "none") {
            const mnemonic =
              this.plugin.mnemonicCache ??
              (await this.plugin.evolu.appOwner)?.mnemonic ??
              "(no owner)";
            mnemonicInput.value = mnemonic;
            mnemonicBox.style.display = "";
            btn.setButtonText("Hide");
          } else {
            mnemonicInput.value = "";
            mnemonicBox.style.display = "none";
            btn.setButtonText("Reveal");
          }
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Copy").onClick(async () => {
          const mnemonic =
            this.plugin.mnemonicCache ??
            (await this.plugin.evolu.appOwner)?.mnemonic;
          if (!mnemonic) {
            new Notice("No owner found");
            return;
          }
          await navigator.clipboard.writeText(mnemonic);
          new Notice("Mnemonic copied to clipboard");
        });
      });

    containerEl.createEl("h3", { text: "Danger zone" });

    // -- Restore --
    let restoreValue = "";
    let restorePending = false;
    let restoreReady = false;

    const resetRestoreState = () => {
      restorePending = false;
      restoreReady = false;
      btn_restore.setButtonText("Restore");
    };

    let btn_restore: ButtonComponent;

    markWide(new Setting(containerEl))
      .setName("Restore mnemonic")
      .setDesc("Deletes this device's synced local files and LocalSync database, then restores the pasted identity.")
      .addTextArea((ta) => {
        ta.setPlaceholder("word1 word2 word3 …");
        ta.inputEl.rows = 2;
        ta.inputEl.addClass("localsync-wide-input");
        ta.onChange((v) => {
          restoreValue = v.trim();
        });
      })
      .addButton((btn) => {
        btn_restore = btn;
        btn
          .setButtonText("Restore")
          .setWarning()
          .onClick(async () => {
            if (!restoreValue) {
              new Notice("Paste your mnemonic first");
              return;
            }
            // If already confirmed and ready — execute
            if (restoreReady) {
              restorePending = false;
              restoreReady = false;
              btn.setButtonText("Restore");
              const progressNotice = new Notice(
                createProgressNoticeFragment({ message: "Starting mnemonic restore..." }),
                0,
              );
              try {
                const parsed = Mnemonic.orThrow(restoreValue);
                const deleted = await this.plugin.restoreMnemonicWithLocalWipe(parsed, (progress) => {
                  progressNotice.setMessage(createProgressNoticeFragment(progress));
                });
                logInfo("Evolu owner restored with local wipe");
                progressNotice.setMessage(
                  createProgressNoticeFragment({
                    message: `Owner restored. Deleted ${deleted} local file(s), sync restarted.`,
                  }),
                );
                window.setTimeout(() => progressNotice.hide(), 5000);
                this.display();
              } catch (e) {
                logError("Mnemonic restore failed", e);
                progressNotice.setMessage("Mnemonic restore failed — check console.");
                window.setTimeout(() => progressNotice.hide(), 8000);
              }
              return;
            }
            // If waiting period is in progress — ignore
            if (restorePending) return;

            // First click — start mandatory 5s wait
            const hasFiles = this.plugin.app.vault
              .getFiles()
              .some((f) => this.plugin.settings.includeExtensions.includes(f.extension));

            restorePending = true;
            restoreReady = false;
            btn.setButtonText("Please wait 5s…");
            new Notice(
              hasFiles
                ? "⚠️ This will delete local synced vault files, restore the pasted mnemonic, " +
                  "and rebuild from remote history. " +
                  "Confirm restore in 5 seconds."
                : "⚠️ Restoring mnemonic and rebuilding local sync state — confirm in 5 seconds.",
              5000,
            );
            window.setTimeout(() => {
              if (restorePending) {
                restoreReady = true;
                btn.setButtonText("Confirm restore?");
                // Auto-cancel after 10s if not confirmed
                window.setTimeout(() => {
                  if (restorePending && restoreReady) resetRestoreState();
                }, 10000);
              }
            }, 5000);
          });
      });

    // -- Reset local sync state --
    let localResetPending = false;
    let localResetReady = false;

    const resetLocalResetState = () => {
      localResetPending = false;
      localResetReady = false;
      btn_local_reset.setButtonText("Reset local state");
    };

    let btn_local_reset: ButtonComponent;

    new Setting(containerEl)
      .setName("Reset local sync state")
      .setDesc("Deletes this device's synced vault files and LocalSync database, then restarts sync with the existing mnemonic.")
      .addButton((btn) => {
        btn_local_reset = btn;
        btn
          .setWarning()
          .setButtonText("Reset local state")
          .onClick(async () => {
            if (localResetReady) {
              localResetPending = false;
              localResetReady = false;
              btn.setButtonText("Reset local state");
              const progressNotice = new Notice(
                createProgressNoticeFragment({ message: "Starting local reset..." }),
                0,
              );
              try {
                const deleted = await this.plugin.resetLocalSyncState((progress) => {
                  progressNotice.setMessage(createProgressNoticeFragment(progress));
                });
                logWarn("LocalSync local state reset");
                progressNotice.setMessage(
                  createProgressNoticeFragment({
                    message: `LocalSync state reset complete. Deleted ${deleted} local file(s).`,
                  }),
                );
                window.setTimeout(() => progressNotice.hide(), 5000);
                this.display();
              } catch (e) {
                logError("LocalSync local state reset failed", e);
                progressNotice.setMessage("LocalSync state reset failed — check console.");
                window.setTimeout(() => progressNotice.hide(), 8000);
              }
              return;
            }
            if (localResetPending) return;

            localResetPending = true;
            localResetReady = false;
            btn.setButtonText("Please wait 5s…");
            new Notice(
              "This deletes synced vault files and the LocalSync database on this device only. Confirm reset in 5 seconds.",
              5000,
            );
            window.setTimeout(() => {
              if (localResetPending) {
                localResetReady = true;
                btn.setButtonText("Confirm local reset?");
                window.setTimeout(() => {
                  if (localResetPending && localResetReady) resetLocalResetState();
                }, 10000);
              }
            }, 5000);
          });
      });

    // -- Reset owner --
    let resetPending = false;
    let resetReady = false;

    const resetResetState = () => {
      resetPending = false;
      resetReady = false;
      btn_reset.setButtonText("Reset");
    };

    let btn_reset: ButtonComponent;

    new Setting(containerEl)
      .setName("Reset owner (danger)")
      .setDesc("Permanently deletes the Evolu identity on this device.")
      .addButton((btn) => {
        btn_reset = btn;
        btn
          .setWarning()
          .setButtonText("Reset")
          .onClick(async () => {
            // If already confirmed and ready — execute
            if (resetReady) {
              resetPending = false;
              resetReady = false;
              btn.setButtonText("Reset");
              await this.plugin.prepareForOwnerChange();
              // Use restoreAppOwner with a fresh mnemonic instead of resetAppOwner.
              // resetAppOwner only drops tables without calling initializeDb, so
              // internal tables (evolu_history etc.) are missing after reset.
              // restoreAppOwner drops + re-initialises the full DB schema.
              const newMnemonic = generateMnemonic();
              await this.plugin.evolu.restoreAppOwner(newMnemonic, { reload: false });
              this.plugin.mnemonicCache = newMnemonic;
              logWarn("Evolu owner reset");
              await this.plugin.restartEngine();
              new Notice("Owner reset — engine restarted.");
              this.display();
              return;
            }
            // If waiting period is in progress — ignore
            if (resetPending) return;

            // First click — start mandatory 5s wait
            resetPending = true;
            resetReady = false;
            btn.setButtonText("Please wait 5s…");
            new Notice("⚠️ This will permanently delete the Evolu identity on this device. Confirm reset in 5 seconds.", 5000);
            window.setTimeout(() => {
              if (resetPending) {
                resetReady = true;
                btn.setButtonText("Confirm reset?");
                // Auto-cancel after 10s if not confirmed
                window.setTimeout(() => {
                  if (resetPending && resetReady) resetResetState();
                }, 10000);
              }
            }, 5000);
          });
      });
  }
}
