import assert from "node:assert/strict";
import test from "node:test";

import initSqlJs from "sql.js/dist/sql-asm.js";
import { replaceAdapterBinaryFileFromBytes, replaceAdapterFileFromTemp } from "../src/adapterAtomicFile";

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

function binaryAdapter() {
  const files = new Map<string, Uint8Array>([["target", Uint8Array.of(99)]]);
  const calls: Array<{ kind: string; bytes?: number }> = [];
  return {
    files, calls,
    async writeBinary(path: string, data: ArrayBuffer) {
      calls.push({ kind: "write", bytes: data.byteLength });
      files.set(path, new Uint8Array(data).slice());
    },
    async appendBinary(path: string, data: ArrayBuffer) {
      calls.push({ kind: "append", bytes: data.byteLength });
      const previous = files.get(path)!;
      const next = new Uint8Array(previous.length + data.byteLength);
      next.set(previous); next.set(new Uint8Array(data), previous.length);
      files.set(path, next);
    },
    async stat(path: string) {
      calls.push({ kind: "stat" });
      const data = files.get(path);
      return data ? { type: "file" as const, size: data.length, ctime: 0, mtime: 0 } : null;
    },
    async exists(path: string) { return files.has(path); },
    async remove(path: string) { calls.push({ kind: "remove" }); files.delete(path); },
    async rename(from: string, to: string) {
      calls.push({ kind: "rename" });
      files.set(to, files.get(from)!); files.delete(from);
    },
  };
}

test("chunked snapshot copies exact view bytes and verifies length before replacement", async () => {
  const a = binaryAdapter();
  const backing = Uint8Array.of(90, 1, 2, 3, 4, 5, 6, 7, 91);
  const data = backing.subarray(1, 8);
  await replaceAdapterBinaryFileFromBytes(a, "temp", "target", data, { chunkBytes: 3 });
  assert.deepEqual([...a.files.get("target")!], [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(a.calls.map((c) => c.kind), ["write", "append", "append", "stat", "rename"]);
  assert.deepEqual(a.calls.filter((c) => c.bytes !== undefined).map((c) => c.bytes), [3, 3, 1]);
  assert.equal(a.files.has("temp"), false);
  assert.deepEqual([...backing], [90, 1, 2, 3, 4, 5, 6, 7, 91]);
});

test("exact chunk boundaries and empty snapshots do not append spurious bytes", async () => {
  for (const data of [Uint8Array.of(1, 2, 3, 4), new Uint8Array()]) {
    const a = binaryAdapter();
    await replaceAdapterBinaryFileFromBytes(a, "temp", "target", data, { chunkBytes: 2 });
    assert.deepEqual(a.files.get("target"), data);
    assert.equal(a.calls.filter((c) => c.kind === "append").length, data.length === 0 ? 0 : 1);
    assert.equal(a.calls.filter((c) => c.kind === "write").length, 1);
  }
});

test("a pending chunk cannot acknowledge persistence or replace the old database", async () => {
  const a = binaryAdapter();
  const append = a.appendBinary;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  a.appendBinary = async (path, data) => { await gate; await append(path, data); };
  let acknowledged = false;
  const save = replaceAdapterBinaryFileFromBytes(a, "temp", "target", Uint8Array.of(1, 2, 3), { chunkBytes: 2 })
    .then(() => { acknowledged = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false);
  assert.deepEqual([...a.files.get("target")!], [99]);
  assert.deepEqual([...a.files.get("temp")!], [1, 2]);
  assert.equal(a.calls.some((c) => c.kind === "rename"), false);
  release(); await save;
  assert.deepEqual([...a.files.get("target")!], [1, 2, 3]);
});

test("write or append failure leaves the old database intact and removes only the temp", async () => {
  for (const failAt of [0, 1, 2]) {
    const a = binaryAdapter();
    const write = a.writeBinary, append = a.appendBinary;
    let attempt = 0;
    const fail = async (path: string, data: ArrayBuffer, operation: typeof write) => {
      if (attempt++ === failAt) throw new Error("disk full");
      await operation(path, data);
    };
    a.writeBinary = (path, data) => fail(path, data, write);
    a.appendBinary = (path, data) => fail(path, data, append);
    await assert.rejects(replaceAdapterBinaryFileFromBytes(a, "temp", "target", Uint8Array.of(1, 2, 3, 4, 5), { chunkBytes: 2 }), /disk full/);
    assert.deepEqual([...a.files.get("target")!], [99]);
    assert.equal(a.files.has("temp"), false);
    assert.equal(a.calls.some((c) => c.kind === "rename"), false);
  }
});

test("append that writes and then rejects is not retried or promoted", async () => {
  const a = binaryAdapter();
  const append = a.appendBinary;
  a.appendBinary = async (path, data) => { await append(path, data); throw new Error("bridge rejected after append"); };
  await assert.rejects(replaceAdapterBinaryFileFromBytes(a, "temp", "target", Uint8Array.of(1, 2, 3), { chunkBytes: 2 }), /bridge rejected/);
  assert.deepEqual([...a.files.get("target")!], [99]);
  assert.equal(a.files.has("temp"), false);
  assert.equal(a.calls.filter((c) => c.kind === "append").length, 1);
});

test("short or duplicated append data cannot replace the database", async () => {
  for (const corrupt of ["short", "duplicate"]) {
    const a = binaryAdapter();
    const append = a.appendBinary;
    a.appendBinary = async (path, data) => {
      if (corrupt === "short") return;
      await append(path, data); await append(path, data);
    };
    await assert.rejects(replaceAdapterBinaryFileFromBytes(a, "temp", "target", Uint8Array.of(1, 2, 3), { chunkBytes: 2 }), /Incomplete binary snapshot/);
    assert.deepEqual([...a.files.get("target")!], [99]);
    assert.equal(a.calls.some((c) => c.kind === "rename"), false);
  }
});

test("missing append API preserves the single-write compatibility path", async () => {
  const a = binaryAdapter();
  const { appendBinary: _append, ...legacy } = a;
  await replaceAdapterBinaryFileFromBytes(legacy, "temp", "target", Uint8Array.of(1, 2, 3), { chunkBytes: 2 });
  assert.deepEqual(a.calls.map((c) => c.kind), ["write", "stat", "rename"]);
  assert.deepEqual([...a.files.get("target")!], [1, 2, 3]);
});

test("desktop single-write path remains available with a capable adapter", async () => {
  const a = binaryAdapter();
  await replaceAdapterBinaryFileFromBytes(a, "temp", "target", Uint8Array.of(1, 2, 3));
  assert.deepEqual(a.calls.map((c) => c.kind), ["write", "stat", "rename"]);
});

test("stat failure and cleanup failure preserve the original persistence error", async () => {
  const a = binaryAdapter();
  a.stat = async () => { throw new Error("cannot verify snapshot"); };
  a.remove = async () => { throw new Error("cleanup also failed"); };
  await assert.rejects(replaceAdapterBinaryFileFromBytes(a, "temp", "target", Uint8Array.of(1, 2, 3), { chunkBytes: 2 }), /cannot verify snapshot/);
  assert.deepEqual([...a.files.get("target")!], [99]);
  assert.equal(a.calls.some((c) => c.kind === "rename"), false);
});

test("invalid chunk sizes or a shared temp/target path fail before touching files", async () => {
  const a = binaryAdapter();
  for (const chunkBytes of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(replaceAdapterBinaryFileFromBytes(a, "temp", "target", Uint8Array.of(1), { chunkBytes }));
  }
  await assert.rejects(replaceAdapterBinaryFileFromBytes(a, "target", "target", Uint8Array.of(1)));
  assert.deepEqual(a.calls, []);
  assert.deepEqual([...a.files.get("target")!], [99]);
});

test("partial temp left by interruption does not prevent a fresh snapshot retry", async () => {
  const a = binaryAdapter();
  a.files.set("interrupted-temp", Uint8Array.of(1, 2));
  await replaceAdapterBinaryFileFromBytes(a, "fresh-temp", "target", Uint8Array.of(7, 8, 9), { chunkBytes: 2 });
  assert.deepEqual([...a.files.get("target")!], [7, 8, 9]);
  assert.deepEqual([...a.files.get("interrupted-temp")!], [1, 2]);
});

test("chunked persistence reopens a real SQLite image with identical rows", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('synthetic durable value');");
  const bytes = db.export(); db.close();
  const a = binaryAdapter();
  await replaceAdapterBinaryFileFromBytes(a, "temp", "target", bytes, { chunkBytes: 997 });
  assert.deepEqual(a.files.get("target"), bytes);
  const reopened = new SQL.Database(a.files.get("target")!);
  assert.deepEqual(reopened.exec("SELECT value FROM fixture")[0].values, [["synthetic durable value"]]);
  assert.deepEqual(reopened.exec("PRAGMA integrity_check")[0].values, [["ok"]]);
  reopened.close();
});

