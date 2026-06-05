import type { VaultFile } from "./vaultAdapter";

export type LocalSyncConfig = {
  includeExtensions: string[];
  excludeGlobs: string[];
  syncObsidianSettings: boolean;
  settingsIncludeGlobs: string[];
  settingsExcludeGlobs: string[];
  startupScan: boolean;
  syncDeletes: boolean;
  periodicRescanSeconds: number;
  settingsRescanSeconds: number;
};

export type TrackingDecision =
  | { tracked: true }
  | { tracked: false; reason: "extension"; extension: string }
  | { tracked: false; reason: "excludeRule"; rule: string };

export const DEFAULT_LOCAL_SYNC_CONFIG: LocalSyncConfig = {
  includeExtensions: ["md", "txt", "canvas"],
  excludeGlobs: [],
  syncObsidianSettings: false,
  settingsIncludeGlobs: [
    ".obsidian/**/*.json",
    ".obsidian/themes/**",
    ".obsidian/snippets/**",
  ],
  settingsExcludeGlobs: [
    ".obsidian/workspace*.json",
    ".obsidian/plugins/obsidian-local-sync/**",
  ],
  startupScan: true,
  syncDeletes: true,
  periodicRescanSeconds: 0,
  settingsRescanSeconds: 0,
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

export function isTrackedSettingPath(
  path: string,
  config: LocalSyncConfig = DEFAULT_LOCAL_SYNC_CONFIG,
): boolean {
  if (!config.syncObsidianSettings) return false;

  const includeDecision = getPathIncludeRuleDecision(path, config.settingsIncludeGlobs);
  if (!includeDecision.included || !includeDecision.rule) return false;

  const excludeDecision = getPathRuleDecision(path, config.settingsExcludeGlobs);
  return excludeDecision.included;
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
    return new RegExp(`^${globToRegex(glob)}$`).test(path);
  }

  return path === glob;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const next = glob[i + 1];
    const prev = glob[i - 1];
    const afterNext = glob[i + 2];

    if (char === "*" && next === "*" && prev === "/" && afterNext === "/") {
      out = out.slice(0, -1);
      out += "(?:.*/)?";
      i += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      out += ".*";
      i++;
      continue;
    }

    if (char === "*") {
      out += "[^/]*";
      continue;
    }

    out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
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

function getPathIncludeRuleDecision(path: string, rules: string[]): { included: boolean; rule: string } {
  let included = false;
  let matchedRule = "";

  for (const rawRule of rules) {
    const rule = rawRule.trim();
    if (!rule || rule.startsWith("#")) continue;

    const negated = rule.startsWith("!");
    const pattern = negated ? rule.slice(1).trim() : rule;
    if (!pattern || pattern.startsWith("#")) continue;

    if (matchesGlob(path, pattern)) {
      included = !negated;
      matchedRule = rule;
    }
  }

  return { included, rule: matchedRule };
}
