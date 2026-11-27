import assert from "node:assert/strict";
import test from "node:test";
import { SyncEtaEstimator } from "../src-core/syncEta";
import { formatProgressDetail, formatSyncEta } from "../src/progressText";

test("ETA warms up on complete saved batches, including their persistence time", () => {
  const eta = new SyncEtaEstimator();
  const first = eta.begin(0);
  assert.equal(eta.estimateSeconds(1000), undefined);
  eta.complete(first, 100, 60_000);
  assert.equal(eta.estimateSeconds(1000), undefined);
  const second = eta.begin(60_000);
  assert.equal(eta.estimateSeconds(1000), undefined, "in-flight work is not a completed sample");
  eta.complete(second, 100, 120_000);
  assert.equal(eta.estimateSeconds(1000), 600);
  assert.equal(eta.estimateSeconds(2000), 1200, "new backlog changes the estimate");
});

test("short or invalid samples cannot produce a premature ETA", () => {
  const eta = new SyncEtaEstimator();
  eta.complete(eta.begin(0), 10, 1000); eta.complete(eta.begin(1000), 10, 2000);
  assert.equal(eta.estimateSeconds(100), undefined);
  eta.complete(eta.begin(0), 0, 60_000);
  eta.complete(eta.begin(0), Infinity, 60_000);
  eta.complete(eta.begin(100), 100, 0);
  assert.equal(eta.estimateSeconds(100), undefined);
});

test("backgrounding invalidates the current batch and prior rate", () => {
  const eta = new SyncEtaEstimator();
  eta.complete(eta.begin(0), 100, 60_000); eta.complete(eta.begin(60_000), 100, 120_000);
  const interrupted = eta.begin(120_000);
  eta.setActive(false);
  assert.equal(eta.estimateSeconds(1000), undefined);
  eta.setActive(true);
  eta.complete(interrupted, 100, 9_000_000);
  eta.complete(eta.begin(9_000_000), 100, 9_060_000);
  assert.equal(eta.estimateSeconds(1000), undefined);
  eta.complete(eta.begin(9_060_000), 100, 9_120_000);
  assert.equal(eta.estimateSeconds(1000), 600);
});

test("focus notifications without suspension preserve the rate; reset clears it", () => {
  const eta = new SyncEtaEstimator();
  eta.complete(eta.begin(0), 100, 60_000); eta.complete(eta.begin(60_000), 100, 120_000);
  eta.setActive(true);
  assert.equal(eta.estimateSeconds(100), 60);
  assert.equal(eta.estimateSeconds(0), undefined);
  assert.equal(eta.estimateSeconds(NaN), undefined);
  eta.reset(); assert.equal(eta.estimateSeconds(100), undefined);
});

test("ETA uses a bounded recent window rather than an obsolete startup rate", () => {
  const eta = new SyncEtaEstimator();
  for (let i = 0; i < 7; i++) eta.complete(eta.begin(i * 60_000), i < 2 ? 1 : 100, (i + 1) * 60_000);
  assert.equal(eta.estimateSeconds(1000), 600);
});

test("progress text adds readable change counts and clamps percentages", () => {
  assert.equal(formatProgressDetail({ current: 721, total: 11694, unit: "changes" }), "721 / 11,694 changes · 6%");
  assert.equal(formatProgressDetail({ current: 12, total: 10, unit: "changes" }), "10 / 10 changes · 100%");
  assert.equal(formatProgressDetail({ current: 0, total: 0, unit: "changes" }), "0 / 0 changes · 0%");
  assert.equal(formatProgressDetail({ current: 2, total: 10 }), "2 / 10");
});

test("ETA wording remains approximate and avoids second-level precision", () => {
  assert.equal(formatSyncEta(undefined), "Estimating remaining time…");
  assert.equal(formatSyncEta(Infinity), "Estimating remaining time…");
  assert.equal(formatSyncEta(0), "Estimating remaining time…");
  assert.equal(formatSyncEta(30), "About a minute remaining");
  assert.equal(formatSyncEta(610), "About 11 min remaining");
  assert.equal(formatSyncEta(3601), "About 1 hr 5 min remaining");
  assert.equal(formatSyncEta(7200), "About 2 hr remaining");
});
