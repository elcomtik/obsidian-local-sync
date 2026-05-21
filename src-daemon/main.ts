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
  isTrackedVaultPath,
  type LocalSyncConfig,
} from "../src-core/pathPolicy";
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
const engineConfig: EngineConfig = {
  historyPollMs: readPositiveInt("LOCALSYNC_HISTORY_POLL_MS", 1000),
  historyBatchSize: readPositiveInt("LOCALSYNC_HISTORY_BATCH_SIZE", 500),
  outgoingBatchMs: readPositiveInt("LOCALSYNC_OUTGOING_BATCH_MS", 500),
  maxOpenDocs: readPositiveInt("LOCALSYNC_MAX_OPEN_DOCS", 50),
};
const localSyncConfig: LocalSyncConfig = {
  ...DEFAULT_LOCAL_SYNC_CONFIG,
  startupScan: readBoolean("LOCALSYNC_STARTUP_SCAN", true),
};
const usePolling = readBoolean("LOCALSYNC_USE_POLLING", false);
const pollIntervalMs = readPositiveInt("LOCALSYNC_POLL_INTERVAL_MS", 1000);

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
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, data);
  },
};

let { evolu, closeDb } = createEvoluClient(appName, relayUrl, io);

const mnemonic = process.env.LOCALSYNC_MNEMONIC?.trim();
if (mnemonic) {
  const currentMnemonic = (await evolu.appOwner)?.mnemonic;
  if (currentMnemonic !== mnemonic) {
    console.log("[obsidian-local-sync] INFO: Restoring daemon owner from LOCALSYNC_MNEMONIC");
    await evolu.restoreAppOwner(Mnemonic.orThrow(mnemonic), { reload: false });
    await closeDb();
    ({ evolu, closeDb } = createEvoluClient(appName, relayUrl, io, { forceNew: true }));
  }
} else {
  console.warn(
    "[obsidian-local-sync] WARN: LOCALSYNC_MNEMONIC is not set; using the existing local DB owner or creating a new isolated owner if the DB is empty.",
  );
}

evolu.subscribeError(() => {
  const error = evolu.getError();
  if (error) {
    console.error("[obsidian-local-sync] ERROR: Evolu error:", error);
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
    console.log("[obsidian-local-sync] INFO: Watcher ready");
  })
  .on("error", (error) => {
    console.error("[obsidian-local-sync] ERROR: Watcher failed", error);
  });

console.log("[obsidian-local-sync] INFO: Daemon started", {
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
  console.log("[obsidian-local-sync] INFO: Vault file changed", { path: vaultPath });
  await engine.onVaultFileChanged(vaultPath);
}

async function onDeleted(absolutePath: string) {
  const vaultPath = safeToVaultPath(vault, absolutePath);
  if (vaultPath === null) return;
  console.log("[obsidian-local-sync] INFO: Vault file deleted", { path: vaultPath });
  await engine.onVaultFileDeleted(vaultPath);
}

async function shutdown(signal: string) {
  console.log("[obsidian-local-sync] INFO: Daemon stopping", { signal });
  await watcher.close();
  await engine.stop();
  await closeDb();
  console.log("[obsidian-local-sync] INFO: Daemon stopped");
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
  return vaultPath.split("/").some((part) => part.startsWith("."));
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

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readLogLevel(value: string): LogLevel {
  if (value === "off" || value === "error" || value === "warn" || value === "info") {
    return value;
  }
  throw new Error("LOCALSYNC_LOG_LEVEL must be one of: off, error, warn, info");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
