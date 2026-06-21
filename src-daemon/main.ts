import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { Mnemonic } from "@evolu/common";
import {
  YjsEvoluHistoryEngine,
  type EngineConfig,
  type LogLevel,
} from "../src-core/engine";
import {
  DEFAULT_LOCAL_SYNC_CONFIG,
  getExtension,
  getPathRuleDecision,
  isTrackedSettingPath,
  isTrackedVaultPath,
  type LocalSyncConfig,
} from "../src-core/pathPolicy";
import { createDaemonLogFormatter } from "../src-core/logFormat";
import { createEvoluClient } from "../src/evoluClient";
import type { PlatformIO } from "../src/sqliteDriver";
import { NodeFsVaultAdapter } from "./nodeFsVaultAdapter";

const vaultName = readRequiredEnv("VAULT_NAME");
const vaultRoot = path.resolve(process.env.VAULT_ROOT ?? `/vaults/${vaultName}`);
const dbPath = path.resolve(
  process.env.LOCALSYNC_DB_PATH ??
    path.join(vaultRoot, ".obsidian/plugins/obsidian-local-sync/obsidian-local-sync.db"),
);
const relayUrl = process.env.EVOLU_RELAY_URL ?? "wss://free.evoluhq.com";
const appName = process.env.LOCALSYNC_APP_NAME ?? "obsidian-local-sync";
const deviceId = process.env.DEVICE_ID ?? `k8s-${vaultName}`;
const logLevel = readLogLevel(process.env.LOCALSYNC_LOG_LEVEL ?? "info");
const logLevelRank: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};
const DAEMON_DEFAULT_EXCLUDE_GLOBS = [
  ".git/**",
  ".obsidian/plugins/obsidian-local-sync/**",
  ".trash/**",
  ".DS_Store",
  "*.tmp",
  "*.swp",
];
const engineConfig: EngineConfig = {
  historyPollMs: readPositiveInt("LOCALSYNC_HISTORY_POLL_MS", 1000),
  historyBatchSize: readPositiveInt("LOCALSYNC_HISTORY_BATCH_SIZE", 500),
  outgoingBatchMs: readPositiveInt("LOCALSYNC_OUTGOING_BATCH_MS", 500),
  maxOpenDocs: readPositiveInt("LOCALSYNC_MAX_OPEN_DOCS", 50),
};
const localSyncConfig: LocalSyncConfig = {
  ...DEFAULT_LOCAL_SYNC_CONFIG,
  includeExtensions: readList("LOCALSYNC_INCLUDE_EXTENSIONS", DEFAULT_LOCAL_SYNC_CONFIG.includeExtensions),
  excludeGlobs: readRules("LOCALSYNC_EXCLUDE_GLOBS", DAEMON_DEFAULT_EXCLUDE_GLOBS),
  syncObsidianSettings: readBoolean(
    "LOCALSYNC_SYNC_OBSIDIAN_SETTINGS",
    DEFAULT_LOCAL_SYNC_CONFIG.syncObsidianSettings,
  ),
  settingsIncludeGlobs: readRules(
    "LOCALSYNC_SETTINGS_INCLUDE_GLOBS",
    DEFAULT_LOCAL_SYNC_CONFIG.settingsIncludeGlobs,
  ),
  settingsExcludeGlobs: readRules(
    "LOCALSYNC_SETTINGS_EXCLUDE_GLOBS",
    DEFAULT_LOCAL_SYNC_CONFIG.settingsExcludeGlobs,
  ),
  startupScan: readBoolean("LOCALSYNC_STARTUP_SCAN", true),
  syncDeletes: readBoolean("LOCALSYNC_SYNC_DELETES", true),
  periodicRescanSeconds: readNonNegativeInt(
    "LOCALSYNC_PERIODIC_RESCAN_SECONDS",
    DEFAULT_LOCAL_SYNC_CONFIG.periodicRescanSeconds,
  ),
  settingsRescanSeconds: readNonNegativeInt(
    "LOCALSYNC_SETTINGS_RESCAN_SECONDS",
    DEFAULT_LOCAL_SYNC_CONFIG.settingsRescanSeconds,
  ),
};
const usePolling = readBoolean("LOCALSYNC_USE_POLLING", false);
const pollIntervalMs = readPositiveInt("LOCALSYNC_POLL_INTERVAL_MS", 1000);
const ownerReadTimeoutMs = readPositiveInt("LOCALSYNC_OWNER_READ_TIMEOUT_MS", 30_000);
const logFormatter = createDaemonLogFormatter("obsidian-local-sync", {});
const ATOMIC_DB_TEMP_MAX_AGE_MS = readPositiveInt("LOCALSYNC_DB_TEMP_MAX_AGE_MS", 15 * 60_000);

await cleanupStaleAtomicTempFiles(dbPath, ATOMIC_DB_TEMP_MAX_AGE_MS);

const io: PlatformIO = {
  async readFile() {
    try {
      return await fs.readFile(dbPath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  },
  async writeFile(data) {
    await cleanupStaleAtomicTempFiles(dbPath, ATOMIC_DB_TEMP_MAX_AGE_MS);
    await writeFileAtomic(dbPath, data);
  },
};

let { evolu, closeDb } = createEvoluClient(appName, relayUrl, io, { logFormatter });

const mnemonic = process.env.LOCALSYNC_MNEMONIC?.trim();
if (mnemonic) {
  const dbExists = await fileExists(dbPath);
  const currentOwner = dbExists
    ? await withTimeout(evolu.appOwner, ownerReadTimeoutMs).catch((error) => {
        logWarn("Failed to read daemon owner from DB", error);
        return null;
      })
    : null;
  if (currentOwner?.mnemonic !== mnemonic) {
    logInfo("Restoring daemon owner from LOCALSYNC_MNEMONIC");
    await evolu.restoreAppOwner(Mnemonic.orThrow(mnemonic), { reload: false });
    await closeDb();
    ({ evolu, closeDb } = createEvoluClient(appName, relayUrl, io, {
      forceNew: true,
      logFormatter,
    }));
  }
} else {
  logWarn(
    "LOCALSYNC_MNEMONIC is not set; using the existing local DB owner or creating a new isolated owner if the DB is empty.",
  );
}

evolu.subscribeError(() => {
  const error = evolu.getError();
  if (error) {
    logError("Evolu error", error);
  }
});

const vault = new NodeFsVaultAdapter(vaultRoot, (vaultPath) =>
  getPathRuleDecision(vaultPath, localSyncConfig.excludeGlobs).included,
);
const engine = new YjsEvoluHistoryEngine({
  vault,
  evolu,
  deviceId,
  config: engineConfig,
  localSyncConfig,
  logLevel,
  logFormatter,
});

await engine.start();

const vaultWatcher = chokidar.watch(vaultRoot, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100,
  },
  atomic: true,
  usePolling,
  interval: pollIntervalMs,
  ignored: (absolutePath) => isIgnoredVaultWatchPath(vault, absolutePath),
});

vaultWatcher
  .on("add", (absolutePath) => void onVaultChanged(absolutePath))
  .on("change", (absolutePath) => void onVaultChanged(absolutePath))
  .on("unlink", (absolutePath) => void onVaultDeleted(absolutePath))
  .on("ready", () => {
    logInfo("Vault watcher ready");
  })
  .on("error", (error) => {
    logError("Vault watcher failed", error);
  });

const settingsRoot = path.join(vaultRoot, ".obsidian");
const settingsWatcher = localSyncConfig.syncObsidianSettings
  ? chokidar.watch(settingsRoot, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
      atomic: true,
      usePolling,
      interval: pollIntervalMs,
      ignored: (absolutePath) => isIgnoredSettingsWatchPath(vault, absolutePath),
    })
      .on("add", (absolutePath) => void onSettingsChanged(absolutePath))
      .on("change", (absolutePath) => void onSettingsChanged(absolutePath))
      .on("unlink", (absolutePath) => void onSettingsDeleted(absolutePath))
      .on("ready", () => {
        logInfo("Settings watcher ready");
      })
      .on("error", (error) => {
        logError("Settings watcher failed", error);
      })
  : null;

logInfo("Daemon started", {
  vaultName,
  vaultRoot,
  dbPath,
  relayUrl,
  deviceId,
  usePolling,
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function onVaultChanged(absolutePath: string) {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null) return;
  logInfo("Vault file changed", { path: vaultPath });
  await engine.onVaultFileChanged(vaultPath);
}

async function onVaultDeleted(absolutePath: string) {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null) return;
  logInfo("Vault file deleted", { path: vaultPath });
  await engine.onVaultFileDeleted(vaultPath);
}

async function onSettingsChanged(absolutePath: string) {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null) return;
  logInfo("Settings file changed", { path: vaultPath });
  await engine.onVaultFileChanged(vaultPath);
}

async function onSettingsDeleted(absolutePath: string) {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null) return;
  logInfo("Settings file deleted", { path: vaultPath });
  await engine.onVaultFileDeleted(vaultPath);
}

async function shutdown(signal: string) {
  logInfo("Daemon stopping", { signal });
  await vaultWatcher.close();
  await settingsWatcher?.close();
  await engine.stop();
  await closeDb();
  logInfo("Daemon stopped");
  process.exit(0);
}

function safeToVaultPath(vault: NodeFsVaultAdapter, absolutePath: string): string | null {
  try {
    return vault.toVaultPath(absolutePath);
  } catch {
    return null;
  }
}

function isIgnoredVaultWatchPath(vault: NodeFsVaultAdapter, absolutePath: string): boolean {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null || vaultPath === "") return false;
  if (vaultPath === ".obsidian" || vaultPath.startsWith(".obsidian/")) return true;
  if (getExtension(vaultPath) === undefined) return false;
  return !isTrackedVaultPath(vaultPath, localSyncConfig);
}

function isIgnoredSettingsWatchPath(vault: NodeFsVaultAdapter, absolutePath: string): boolean {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null || vaultPath === "") return false;
  if (getExtension(vaultPath) === undefined) return false;
  return !isTrackedSettingPath(vaultPath, localSyncConfig);
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be 0 or a positive integer`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(/[,\s]+/).map((value) => value.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }
  return Array.from(new Set(values));
}

function readRules(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
}

function readLogLevel(value: string): LogLevel {
  if (value === "off" || value === "error" || value === "warn" || value === "info" || value === "debug") {
    return value;
  }
  throw new Error("LOCALSYNC_LOG_LEVEL must be one of: off, error, warn, info, debug");
}

function logInfo(message: string, data?: unknown) {
  if (logLevelRank[logLevel] < logLevelRank.info) return;
  console.log(logFormatter("INFO", message, data));
}

function logWarn(message: string, data?: unknown) {
  if (logLevelRank[logLevel] < logLevelRank.warn) return;
  console.warn(logFormatter("WARN", message, data));
}

function logError(message: string, data?: unknown) {
  if (logLevelRank[logLevel] < logLevelRank.error) return;
  console.error(logFormatter("ERROR", message, data));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await fs.stat(filePath);
    return fileStat.isFile();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupStaleAtomicTempFiles(filePath: string, maxAgeMs: number): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const now = Date.now();
  let deleted = 0;
  let reclaimedBytes = 0;

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith(`${base}.`) || !entry.endsWith(".tmp")) continue;
    const tempPath = path.join(dir, entry);
    try {
      const stat = await fs.stat(tempPath);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < maxAgeMs) continue;
      await fs.rm(tempPath, { force: true });
      deleted++;
      reclaimedBytes += stat.size;
    } catch (error) {
      if (!isMissingFile(error)) logWarn("Failed to cleanup stale DB temp file", { path: tempPath, error });
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Timed out waiting for Evolu app owner")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
