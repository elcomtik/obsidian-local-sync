export type ProgressDetail = {
  current?: number;
  total?: number;
  unit?: "changes";
  etaSeconds?: number;
};

export function formatProgressDetail(progress: ProgressDetail): string {
  const total = Math.max(0, progress.total ?? 0);
  const current = Math.max(0, Math.min(progress.current ?? 0, total));
  const count = `${current.toLocaleString("en-US")} / ${total.toLocaleString("en-US")}`;
  return progress.unit === "changes"
    ? `${count} changes · ${total > 0 ? Math.floor(current / total * 100) : 0}%`
    : count;
}

export function formatSyncEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "Estimating remaining time…";
  if (seconds < 60) return "About a minute remaining";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `About ${minutes} min remaining`;
  // Coarse rounding avoids suggesting minute-level accuracy for long restores.
  const rounded = Math.ceil(minutes / 5) * 5;
  const hours = Math.floor(rounded / 60), rest = rounded % 60;
  return `About ${hours} hr${rest ? ` ${rest} min` : ""} remaining`;
}
