import assert from "node:assert/strict";
import test from "node:test";

import { replaceAdapterFileFromTemp } from "../src/adapterAtomicFile";

test("completed Android rename is not undone when the bridge rejects", async () => {
  const files = new Set(["target", "temp"]);
  const removed: string[] = [];
  let renames = 0;
  const adapter = {
    async exists(path: string) {
      return files.has(path);
    },
    async remove(path: string) {
      removed.push(path);
      files.delete(path);
    },
    async rename(from: string, to: string) {
      renames++;
      files.delete(from);
      files.add(to);
      throw new Error("File does not exist");
    },
  };

  await replaceAdapterFileFromTemp(adapter, "temp", "target");

  assert.equal(renames, 1);
  assert.deepEqual(removed, []);
  assert.deepEqual(files, new Set(["target"]));
});

test("unsupported replacement falls back to remove then rename", async () => {
  const files = new Set(["target", "temp"]);
  const removed: string[] = [];
  let renames = 0;
  const adapter = {
    async exists(path: string) {
      return files.has(path);
    },
    async remove(path: string) {
      removed.push(path);
      files.delete(path);
    },
    async rename(from: string, to: string) {
      renames++;
      if (renames === 1) throw new Error("Target exists");
      files.delete(from);
      files.add(to);
    },
  };

  await replaceAdapterFileFromTemp(adapter, "temp", "target");

  assert.equal(renames, 2);
  assert.deepEqual(removed, ["target"]);
  assert.deepEqual(files, new Set(["target"]));
});

