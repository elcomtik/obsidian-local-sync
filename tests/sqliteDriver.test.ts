import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { CreateSqliteDriver, SimpleName } from "@evolu/common";
import { createPersistentSqlJsDriver } from "../src/sqliteDriver";

type PersistentDriver = Awaited<ReturnType<CreateSqliteDriver>> & {
  persist(): Promise<void>;
  flush(): Promise<void>;
  discard(): void;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(t: TestContext, write?: (data: Uint8Array) => Promise<void>) {
  const SQL = await initSqlJs();
  const exportMock = t.mock.method(SQL.Database.prototype, "export");
  let durable: Uint8Array | null = null;
  const values: number[] = [];
  const factory = createPersistentSqlJsDriver({
    readFile: async () => null,
    writeFile: async (data) => {
      const reopened = new SQL.Database(data);
      values.push(Number(reopened.exec("SELECT value FROM fixture")[0].values[0][0]));
      reopened.close();
      await write?.(data);
      durable = data.slice();
    },
  }, undefined, { saveDebounceMs: 10 });
  const driver = await factory("persistence-test" as SimpleName) as PersistentDriver;
  t.after(() => { driver.discard(); driver[Symbol.dispose](); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  driver.exec({ sql: "CREATE TABLE fixture(value INTEGER)", parameters: [] }, true);
  driver.exec({ sql: "INSERT INTO fixture VALUES (0)", parameters: [] }, true);
  return {
    driver, values,
    exports: () => exportMock.mock.callCount(),
    durableBytes: () => durable?.slice(),
    change(value: number) {
      driver.exec({ sql: "UPDATE fixture SET value = ?", parameters: [value] }, true);
    },
    async automaticSave() { t.mock.timers.tick(10); await drain(); },
    durableValue() {
      assert.ok(durable);
      const reopened = new SQL.Database(durable);
      try { return Number(reopened.exec("SELECT value FROM fixture")[0].values[0][0]); }
      finally { reopened.close(); }
    },
  };
}

test("explicit checkpoint cancels a pending automatic save and survives reopen", async (t) => {
  const h = await setup(t);
  h.change(1);
  await h.driver.persist();
  await h.automaticSave();
  assert.deepEqual(h.values, [1]);
  assert.equal(h.durableValue(), 1);
});

test("slow automatic write coalesces queued automatic snapshots to the newest state", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1); await h.automaticSave();
  h.change(2); await h.automaticSave();
  h.change(3); await h.automaticSave();
  assert.deepEqual(h.values, [1]);
  assert.equal(h.exports(), 1, "queued automatic requests must not allocate DB images");
  gate.resolve(); await drain();
  assert.deepEqual(h.values, [1, 3]);
  assert.equal(h.exports(), 2);
  assert.equal(h.durableValue(), 3);
});

test("checkpoint supersedes queued automatic save but awaits the active write", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1); await h.automaticSave();
  h.change(2); await h.automaticSave();
  h.change(3);
  let acknowledged = false;
  const checkpoint = h.driver.persist().then(() => { acknowledged = true; });
  await drain();
  assert.equal(acknowledged, false);
  assert.deepEqual(h.values, [1]);
  gate.resolve(); await checkpoint;
  assert.deepEqual(h.values, [1, 3]);
  assert.equal(h.durableValue(), 3);
});

test("queued automatic save captures edits made before its write starts", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1); await h.automaticSave();
  h.change(2); await h.automaticSave();
  h.change(3); // New timer has not fired, but the queued save can include this edit.
  gate.resolve(); await drain();
  assert.deepEqual(h.values, [1, 3]);
  assert.equal(h.durableValue(), 3);
});

test("edits during an explicit checkpoint get a later automatic save", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1);
  const checkpoint = h.driver.persist(); await drain();
  h.change(2); await h.automaticSave();
  gate.resolve(); await checkpoint; await drain();
  assert.deepEqual(h.values, [1, 2]);
  assert.equal(h.durableValue(), 2);
});

test("each explicit checkpoint retains its own snapshot and acknowledgement", async (t) => {
  const gates = [deferred(), deferred()];
  const h = await setup(t, async () => { await gates[h.values.length - 1].promise; });
  h.change(1);
  let firstDone = false, secondDone = false;
  const first = h.driver.persist().then(() => { firstDone = true; });
  h.change(2);
  const second = h.driver.persist().then(() => { secondDone = true; });
  await drain();
  assert.deepEqual(h.values, [1]);
  assert.equal(firstDone, false); assert.equal(secondDone, false);
  gates[0].resolve(); await first; await drain();
  assert.equal(firstDone, true); assert.equal(secondDone, false);
  assert.deepEqual(h.values, [1, 2]);
  assert.equal(h.durableValue(), 1);
  gates[1].resolve(); await second;
  assert.equal(h.durableValue(), 2);
});

test("failed automatic save does not poison a later explicit checkpoint", async (t) => {
  let fail = true;
  const h = await setup(t, async () => { if (fail) throw new Error("disk full"); });
  h.change(1); await h.automaticSave();
  fail = false;
  h.change(2); await h.driver.persist();
  assert.deepEqual(h.values, [1, 2]);
  assert.equal(h.durableValue(), 2);
});

test("failed checkpoint rejects, preserves the last durable state and permits retry", async (t) => {
  let fail = false;
  const h = await setup(t, async () => { if (fail) throw new Error("disk full"); });
  h.change(1); await h.driver.persist();
  fail = true; h.change(2);
  await assert.rejects(h.driver.persist(), /disk full/);
  assert.equal(h.durableValue(), 1);
  fail = false; await h.driver.persist();
  assert.equal(h.durableValue(), 2);
});

test("a queued checkpoint remains pending until its own write after an earlier failure", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => {
    if (h.values.length === 1) { await gate.promise; throw new Error("first write failed"); }
  });
  h.change(1);
  const firstRejected = assert.rejects(h.driver.persist(), /first write failed/);
  h.change(2);
  let acknowledged = false;
  const second = h.driver.persist().then(() => { acknowledged = true; });
  await drain();
  assert.equal(acknowledged, false);
  gate.resolve(); await firstRejected; await second;
  assert.deepEqual(h.values, [1, 2]);
  assert.equal(h.durableValue(), 2);
});

test("flush rejects on storage failure and can retry without accepting automatic writes", async (t) => {
  let fail = true;
  const h = await setup(t, async () => { if (fail) throw new Error("disk full"); });
  h.change(1);
  await assert.rejects(h.driver.flush(), /disk full/);
  await h.automaticSave();
  assert.deepEqual(h.values, [1]);
  fail = false; await h.driver.flush();
  assert.equal(h.durableValue(), 1);
});

test("flush supersedes pending automatic saves and fences later mutations", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1); await h.automaticSave();
  h.change(2); await h.automaticSave();
  h.change(3);
  const flushed = h.driver.flush();
  h.change(4); await h.automaticSave();
  gate.resolve(); await flushed;
  assert.deepEqual(h.values, [1, 3]);
  assert.equal(h.durableValue(), 3);
});

test("discard invalidates queued automatic work before a replacement database is used", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1); await h.automaticSave();
  h.change(2); await h.automaticSave();
  h.driver.discard();
  gate.resolve(); await drain();
  h.change(3); await h.automaticSave();
  assert.deepEqual(h.values, [1]);
  assert.equal(h.durableValue(), 1);
});

test("discard and disposal prevent deferred automatic export from touching a closed DB", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1); await h.automaticSave();
  h.change(2); await h.automaticSave();
  h.driver.discard(); h.driver[Symbol.dispose]();
  gate.resolve(); await drain();
  assert.deepEqual(h.values, [1]);
  assert.equal(h.exports(), 1);
});

test("clean checkpoints and flush avoid both exports and repeated disk writes", async (t) => {
  const h = await setup(t);
  h.change(1); await h.driver.persist();
  const exports = h.exports();
  h.driver.exec({ sql: "SELECT value FROM fixture", parameters: [] }, false);
  await h.driver.persist(); await h.driver.persist(); await h.driver.flush();
  assert.deepEqual(h.values, [1]);
  assert.equal(h.exports(), exports);
  assert.equal(h.durableValue(), 1);
});

test("identical queued barriers wait for the active write before acknowledging", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { await gate.promise; });
  h.change(1);
  const first = h.driver.persist();
  let acknowledged = false;
  const second = h.driver.persist().then(() => { acknowledged = true; });
  await drain();
  assert.equal(acknowledged, false);
  assert.deepEqual(h.values, [1]);
  gate.resolve(); await first; await second;
  assert.deepEqual(h.values, [1]);
  assert.equal(h.durableValue(), 1);
});

test("mutations during a write remain dirty even when no automatic timer fires", async (t) => {
  const gate = deferred();
  const h = await setup(t, async () => { if (h.values.length === 1) await gate.promise; });
  h.change(1); const first = h.driver.persist(); await drain();
  h.change(2);
  gate.resolve(); await first;
  assert.equal(h.durableValue(), 1);
  await h.driver.persist();
  assert.deepEqual(h.values, [1, 2]);
  assert.equal(h.durableValue(), 2);
});

test("schema-only mutation is dirty even when SQLite reports zero changed rows", async (t) => {
  const h = await setup(t);
  h.change(1); await h.driver.persist();
  const result = h.driver.exec({ sql: "CREATE INDEX fixtureValue ON fixture(value)", parameters: [] }, true);
  assert.equal(result.changes, 0);
  await h.driver.persist();
  assert.deepEqual(h.values, [1, 1]);
  const SQL = await initSqlJs(), reopened = new SQL.Database(h.durableBytes());
  assert.equal(reopened.exec("SELECT name FROM sqlite_master WHERE name='fixtureValue'")[0].values[0][0], "fixtureValue");
  reopened.close();
});

test("failed mutation and rollback conservatively require a new checkpoint", async (t) => {
  const h = await setup(t);
  h.change(1); await h.driver.persist();
  assert.throws(() => h.driver.exec({ sql: "INVALID MUTATION", parameters: [] }, true));
  await h.driver.persist();
  h.driver.exec({ sql: "BEGIN", parameters: [] }, true);
  h.change(2);
  h.driver.exec({ sql: "ROLLBACK", parameters: [] }, true);
  await h.driver.persist();
  assert.deepEqual(h.values, [1, 1, 1]);
  assert.equal(h.durableValue(), 1);
});

test("loaded durable image starts clean but an empty database needs a first write", async (t) => {
  const SQL = await initSqlJs(), seed = new SQL.Database();
  seed.run("CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(7)");
  const bytes = seed.export(); seed.close();
  for (const existing of [bytes, null]) {
    const writes: Uint8Array[] = [];
    const factory = createPersistentSqlJsDriver({
      readFile: async () => existing,
      writeFile: async (data) => { writes.push(data.slice()); },
    });
    const driver = await factory("load-clean" as SimpleName) as PersistentDriver;
    try {
      await driver.persist(); await driver.persist();
      assert.equal(writes.length, existing ? 0 : 1);
    } finally { driver.discard(); driver[Symbol.dispose](); }
  }
});

test("normal disposal persists dirty data before the SQLite instance is closed", async (t) => {
  const h = await setup(t);
  h.change(9);
  h.driver[Symbol.dispose](); await drain();
  assert.deepEqual(h.values, [9]);
  assert.equal(h.durableValue(), 9);
});
