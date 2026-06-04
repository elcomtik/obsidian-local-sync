import type { VaultFile } from "./vaultAdapter";

export type LocalSyncConfig = {
  includeExtensions: string[];
  excludeGlobs: string[];
  startupScan: boolean;
  syncDeletes: boolean;
  periodicRescanSeconds: number;
};

export type TrackingDecision =
  | { tracked: true }
  | { tracked: false; reason: "extension"; extension: string }
  | { tracked: false; reason: "excludeRule"; rule: string };

export const DEFAULT_LOCAL_SYNC_CONFIG: LocalSyncConfig = {
  includeExtensions: ["md", "txt", "canvas"],
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
  periodicRescanSeconds: 0,
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
  return getTrackingDecision(file, config).tracked;
}

export function getTrackingDecision(
  file: Pick<VaultFile, "path" | "extension">,
  config: LocalSyncConfig = DEFAULT_LOCAL_SYNC_CONFIG,
): TrackingDecision {
  const extension = (file.extension ?? getExtension(file.path) ?? "").toLowerCase();
  if (!config.includeExtensions.includes(extension)) {
    return { tracked: false, reason: "extension", extension };
  }

  const pathDecision = getPathRuleDecision(file.path, config.excludeGlobs);
  if (!pathDecision.included) {
    return { tracked: false, reason: "excludeRule", rule: pathDecision.rule };
  }

  return { tracked: true };
}

export function isTrackedVaultPath(
  path: string,
  config: LocalSyncConfig = DEFAULT_LOCAL_SYNC_CONFIG,
): boolean {
  return isTrackedVaultFile({ path, extension: getExtension(path) }, config);
}

function matchesGlob(path: string, glob: string): boolean {
  if (glob === "**" || glob === "*") return true;

  if (glob.endsWith("/**")) {
    return path === glob.slice(0, -3) || path.startsWith(glob.slice(0, -2));
  }

  if (glob.startsWith("**/")) {
    const suffix = glob.slice(3);
    return path === suffix || path.endsWith(`/${suffix}`);
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

function getPathRuleDecision(path: string, rules: string[]): { included: boolean; rule: string } {
  let included = true;
  let matchedRule = "";

  for (const rawRule of rules) {
    const rule = rawRule.trim();
    if (!rule || rule.startsWith("#")) continue;

    const negated = rule.startsWith("!");
    const pattern = negated ? rule.slice(1).trim() : rule;
    if (!pattern || pattern.startsWith("#")) continue;

    if (matchesGlob(path, pattern)) {
      included = negated;
      matchedRule = rule;
    }
  }

  return { included, rule: matchedRule };
}
