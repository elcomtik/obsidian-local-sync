import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { createConsole, createEvolu, createRandom, createRandomBytes, createTime, SimpleName } from "@evolu/common";
import { createDbWorkerForPlatform } from "@evolu/common/local-first";
import { createPersistentSqlJsDriver } from "../src/sqliteDriver";
import { Schema } from "../src-core/schema";
import { DEFAULT_LOCAL_SYNC_CONFIG } from "../src-core/pathPolicy";
import { YjsEvoluHistoryEngine } from "../src-core/engine";
import type { VaultAdapter } from "../src-core/vaultAdapter";

function encoded(content: string) {
  const doc = new Y.Doc(); doc.getText("content").insert(0, content);
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy(); return bytes;
}

test("real Evolu reloads detached inboxes without losing remote or local changes", { timeout: 10_000 }, async (t) => {
  let driver: any, engine: any;
  let inboxReadsWhileSuspended = 0, inboxReads = 0;
  const inner = createPersistentSqlJsDriver({ readFile: async () => null, writeFile: async () => {} });
  const deps = {
    console: createConsole(), randomBytes: createRandomBytes(), time: createTime(), reloadApp() {},
    createDbWorker: () => createDbWorkerForPlatform({
      console: createConsole(), random: createRandom(), randomBytes: createRandomBytes(), time: createTime(),
      createWebSocket: () => { throw new Error("Offline integration test must not connect"); },
      createSqliteDriver: async (name, options) => {
        driver = await inner(name, options);
        const exec = driver.exec;
        driver.exec = (query, mutation) => {
          if (!mutation && query.sql.includes("incoming") && query.sql.includes("_processed") && !query.sql.includes("count(")) {
            inboxReads++;
            if (engine?.inboxSubscriptionsSuspended) inboxReadsWhileSuspended++;
          }
          return exec(query, mutation);
        };
        return driver;
      },
    }),
  } satisfies Parameters<typeof createEvolu>[0];
  const evolu = createEvolu(deps)(Schema, {
    name: SimpleName.orThrow("inbox-subscription-integration"), transports: [],
    indexes: (create) => [
      create("processedFileUpdateSourceVersion").on("_processedFileUpdate").columns(["sourceId", "sourceVersion"]),
      create("processedSettingUpdateSourceVersion").on("_processedSettingUpdate").columns(["sourceId", "sourceVersion"]),
    ],
  });
  await evolu.appOwner;
  t.after(async () => { await engine?.stop(false); driver?.discard(); driver?.[Symbol.dispose](); });
  const mutate = (table: keyof typeof Schema, values: Record<string, unknown>) => new Promise<string>((resolve, reject) => {
    const result = evolu.update(table, values as any, { onComplete: () => resolve(String(values.id)) });
    if (!result.ok) reject(new Error("Synthetic mutation rejected"));
  });
  // Use actual Evolu IDs and callbacks rather than relying on the fixture's
  // permissive strings or its simplified mutation/query cache implementation.
  const firstEncoded = encoded("first");
  const insertFile = (path: string, content: string, type: string | null = null) => new Promise<string>((resolve, reject) => {
    const result = evolu.insert("fileUpdate", {
      path, updateBase64: path === "first.md" ? firstEncoded : encoded(content), type, originDeviceId: "remote-peer",
    } as any, { onComplete: () => { if (result.ok) resolve(result.value.id); } });
    if (!result.ok) reject(new Error("Synthetic insert rejected"));
  });
  const firstId = await insertFile("first.md", "first");
  const files = new Map<string, string>();
  let injected = false;
  let journal: any = null;
  const vault: VaultAdapter = {
    async listFiles() { return [...files.keys()].map((path) => ({ path })); },
    async listFolder() { return null; },
    async readText(path) { return files.get(path) ?? null; },
    async writeText(path, content) {
      files.set(path, content);
      if (!injected) {
        injected = true;
        assert.equal(engine.inboxSubscriptionsSuspended, true);
        // These canonical mutations arrive with both subscriptions absent.
        // The real Evolu promise cache must not reuse the pre-checkpoint page.
        await insertFile("later.md", "later");
        await insertFile("deleted.md", "old");
        await insertFile("deleted.md", "", "delete");
        const next = new Y.Doc(); Y.applyUpdate(next, Buffer.from(firstEncoded, "base64"));
        const text = next.getText("content"); text.delete(0, text.length); text.insert(0, "new version");
        await mutate("fileUpdate", { id: firstId, updateBase64: Buffer.from(Y.encodeStateAsUpdate(next)).toString("base64") });
        next.destroy();
        files.set("local.md", "local edit during catch-up");
        await engine.onVaultFileChanged("local.md");
        await engine.flushOutgoingUpdates("local.md", engine.states.get("local.md"));
        await new Promise<void>((resolve, reject) => {
          const result = evolu.insert("settingUpdate", {
            path: ".obsidian/app.json", contentBase64: Buffer.from("{}").toString("base64"),
            contentHash: "synthetic", encoding: "raw", type: null, originDeviceId: "remote-peer",
          } as any, { onComplete: resolve });
          if (!result.ok) reject(new Error("Synthetic setting rejected"));
        });
      }
    },
    async deleteFile(path) { files.delete(path); },
    async fileExists(path) { return files.has(path); },
    async ensureFolder() {},
  };
  engine = new YjsEvoluHistoryEngine({
    evolu, vault, deviceId: "test-phone", logLevel: "off",
    config: { historyPollMs: 60_000, historyBatchSize: 500, inboxCheckpointBatchPaths: 100,
      outgoingBatchMs: 100, maxOpenDocs: 50, vaultScanDebugProgressEveryFiles: 100,
      vaultScanDebugProgressEveryMs: 10_000, vaultScanInfoProgressEveryMs: 60_000, vaultRescanWatchdogMs: 900_000 },
    localSyncConfig: { ...DEFAULT_LOCAL_SYNC_CONFIG, startupScan: false, syncObsidianSettings: true,
      periodicRescanSeconds: 0, settingsRescanSeconds: 0 },
    persistLocalDb: async () => { await driver.persist(); },
    applyJournalStore: { async load() { return journal; }, async save(value) { journal = value; }, async clear() { journal = null; } },
  });
  engine.isActive = false;
  await engine.start();
  await engine.inboxLoadPromise;
  assert.ok(engine.pendingFileInbox.size > 0, "fixture must expose the initial pending remote update");
  const readsBeforeApply = inboxReads;
  engine.isActive = true;
  await engine.runIncrementalInbox();
  assert.equal(evolu.getError(), null);
  assert.equal(files.get("later.md"), "later");
  assert.equal(files.get(".obsidian/app.json"), "{}");
  assert.equal(files.has("deleted.md"), false);
  assert.equal(files.get("first.md"), "new version");
  assert.equal(files.get("local.md"), "local edit during catch-up");
  assert.equal(journal, null);
  assert.equal(engine.pendingFileInbox.size + engine.pendingSettingInbox.size, 0);
  assert.equal(engine.inboxRefreshNeeded, false);
  assert.equal(inboxReadsWhileSuspended, 0, "snapshot mutations must not reload detached inbox queries");
  assert.ok(inboxReads > readsBeforeApply, "boundary must execute fresh inbox reads");
  const authored = await evolu.loadQuery(evolu.createQuery((db) => db.selectFrom("fileUpdate")
    .select(["id", "path"]).where("originDeviceId", "=", "test-phone" as any)));
  assert.deepEqual(authored.map((row) => row.path), ["local.md"], "only the intentional local edit may be authored by this peer");
});
