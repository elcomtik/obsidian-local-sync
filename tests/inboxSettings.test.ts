import assert from "node:assert/strict";
import test from "node:test";
import { migrateInboxSettings } from "../src/inboxSettings";

test("fresh installs and legacy defaults use 100-path checkpoints", () => {
  for (const saved of [null, {}, { inboxCheckpointBatchPaths: 50 }]) {
    assert.deepEqual(migrateInboxSettings(saved), {
      inboxCheckpointBatchPaths: 100, inboxDefaultsVersion: 1,
    });
  }
});

test("migration preserves custom sizes and never reapplies over later user choices", () => {
  for (const paths of [1, 75, 100, 200]) {
    const migrated = migrateInboxSettings({ inboxCheckpointBatchPaths: paths });
    assert.equal(migrated.inboxCheckpointBatchPaths, paths);
    assert.deepEqual(migrateInboxSettings(migrated), migrated);
  }
  assert.equal(migrateInboxSettings({ inboxCheckpointBatchPaths: 50, inboxDefaultsVersion: 1 }).inboxCheckpointBatchPaths, 50);
  assert.deepEqual(migrateInboxSettings({ inboxCheckpointBatchPaths: 75, inboxDefaultsVersion: 2 }), {
    inboxCheckpointBatchPaths: 75, inboxDefaultsVersion: 2,
  });
});
