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
const engineConfig: EngineConfig = {
  historyPollMs: readPositiveInt("LOCALSYNC_HISTORY_POLL_MS", 1000),
  historyBatchSize: readPositiveInt("LOCALSYNC_HISTORY_BATCH_SIZE", 500),
  outgoingBatchMs: readPositiveInt("LOCALSYNC_OUTGOING_BATCH_MS", 500),
  maxOpenDocs: readPositiveInt("LOCALSYNC_MAX_OPEN_DOCS", 50),
};
const localSyncConfig: LocalSyncConfig = {
  ...DEFAULT_LOCAL_SYNC_CONFIG,
  includeExtensions: readList("LOCALSYNC_INCLUDE_EXTENSIONS", DEFAULT_LOCAL_SYNC_CONFIG.includeExtensions),
  excludeGlobs: readRules("LOCALSYNC_EXCLUDE_GLOBS", DEFAULT_LOCAL_SYNC_CONFIG.excludeGlobs),
  startupScan: readBoolean("LOCALSYNC_STARTUP_SCAN", true),
  syncDeletes: readBoolean("LOCALSYNC_SYNC_DELETES", true),
  periodicRescanSeconds: readNonNegativeInt(
    "LOCALSYNC_PERIODIC_RESCAN_SECONDS",
    DEFAULT_LOCAL_SYNC_CONFIG.periodicRescanSeconds,
  ),
};
const usePolling = readBoolean("LOCALSYNC_USE_POLLING", false);
const pollIntervalMs = readPositiveInt("LOCALSYNC_POLL_INTERVAL_MS", 1000);
const ownerReadTimeoutMs = readPositiveInt("LOCALSYNC_OWNER_READ_TIMEOUT_MS", 30_000);
const logFormatter = createDaemonLogFormatter("obsidian-local-sync", {});

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

const vault = new NodeFsVaultAdapter(vaultRoot);
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

const watcher = chokidar.watch(vaultRoot, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100,
  },
  atomic: true,
  usePolling,
  interval: pollIntervalMs,
  ignored: (absolutePath) => isIgnoredWatchPath(vault, absolutePath),
});

watcher
  .on("add", (absolutePath) => void onChanged(absolutePath))
  .on("change", (absolutePath) => void onChanged(absolutePath))
  .on("unlink", (absolutePath) => void onDeleted(absolutePath))
  .on("ready", () => {
    logInfo("Watcher ready");
  })
  .on("error", (error) => {
    logError("Watcher failed", error);
  });

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

async function onChanged(absolutePath: string) {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null) return;
  logInfo("Vault file changed", { path: vaultPath });
  await engine.onVaultFileChanged(vaultPath);
}

async function onDeleted(absolutePath: string) {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null) return;
  logInfo("Vault file deleted", { path: vaultPath });
  await engine.onVaultFileDeleted(vaultPath);
}

async function shutdown(signal: string) {
  logInfo("Daemon stopping", { signal });
  await watcher.close();
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

function isIgnoredWatchPath(vault: NodeFsVaultAdapter, absolutePath: string): boolean {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null || vaultPath === "") return false;
  if (getExtension(vaultPath) === undefined) return false;
  return !isTrackedVaultPath(vaultPath, localSyncConfig);
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
  await fs.writeFile(tempPath, data);
  await fs.rename(tempPath, filePath);
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
