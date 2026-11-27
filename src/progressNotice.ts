import { formatProgressDetail, formatSyncEta, type ProgressDetail } from "./progressText";

export type ProgressNoticeData = ProgressDetail & { message: string };

export function createProgressNoticeFragment(progress: ProgressNoticeData, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const container = doc.createElement("div");
  container.classList.add("localsync-progress-notice");
  const label = doc.createElement("div");
  label.textContent = progress.message;
  container.appendChild(label);

  if (progress.total !== undefined) {
    const detail = doc.createElement("div");
    detail.classList.add("localsync-progress-detail");
    detail.textContent = formatProgressDetail(progress);
    container.appendChild(detail);

    const bar = doc.createElement("progress");
    bar.max = progress.total;
    bar.value = progress.current ?? 0;
    bar.setAttribute("aria-label", progress.unit === "changes" ? "Sync progress" : "Progress");
    container.appendChild(bar);

    if (progress.unit === "changes") {
      const estimate = doc.createElement("div");
      estimate.classList.add("localsync-progress-detail");
      estimate.textContent = formatSyncEta(progress.etaSeconds);
      estimate.title = "Based on recently saved progress. The estimate adjusts as more changes arrive.";
      container.appendChild(estimate);
      const hint = doc.createElement("div");
      hint.classList.add("localsync-progress-detail");
      hint.textContent = "Keep Obsidian open.";
      container.appendChild(hint);
    }
  }
  fragment.appendChild(container);
  return fragment;
}
