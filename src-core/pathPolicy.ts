import type { VaultFile } from "./vaultAdapter";

export type LocalSyncConfig = {
  includeExtensions: string[];
  excludeGlobs: string[];
  startupScan: boolean;
  syncDeletes: boolean;
};

export const DEFAULT_LOCAL_SYNC_CONFIG: LocalSyncConfig = {
  includeExtensions: ["md", "txt"],
  excludeGlobs: [
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
  ],
  startupScan: true,
  syncDeletes: true,
};

export function getExtension(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return undefined;
  return name.slice(idx + 1).toLowerCase();
}

export function isTrackedVaultFile(
  file: Pick<VaultFile, "path" | "extension">,
  config: LocalSyncConfig = DEFAULT_LOCAL_SYNC_CONFIG,
): boolean {
  const extension = (file.extension ?? getExtension(file.path) ?? "").toLowerCase();
  if (!config.includeExtensions.includes(extension)) return false;
  return !config.excludeGlobs.some((glob) => matchesGlob(file.path, glob));
}

export function isTrackedVaultPath(
  path: string,
  config: LocalSyncConfig = DEFAULT_LOCAL_SYNC_CONFIG,
): boolean {
  return isTrackedVaultFile({ path, extension: getExtension(path) }, config);
}

function matchesGlob(path: string, glob: string): boolean {
  if (glob.endsWith("/**")) {
    return path === glob.slice(0, -3) || path.startsWith(glob.slice(0, -2));
  }

  if (glob.startsWith("*.")) {
    return path.endsWith(glob.slice(1));
  }

  if (glob.includes("*")) {
    const escaped = glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(path);
  }

  return path === glob;
}

