import {
  createConsole,
  createEvolu,
  createRandom,
  createRandomBytes,
  createTime,
  createWebSocket,
  SimpleName,
} from "@evolu/common";
import { createOwnerSecret, ownerSecretToMnemonic } from "@evolu/common/local-first";
import { createDbWorkerForPlatform } from "@evolu/common/local-first";
import type { CreateSqliteDriver, EvoluDeps } from "@evolu/common";
import { createPersistentSqlJsDriver } from "./sqliteDriver";
import { Schema } from "./schema";

/**
 * `createEvolu` caches instances by name at the module level.  Each plugin
 * restart must use a unique name so that reset/restore gets a fresh Evolu
 * client (new DB connection + new relay WebSocket with the restored identity).
 * Without this, the second call to `createEvoluClient` returns the stale
 * cached instance — still wired to the old owner's WebSocket — and sync never
 * works after restore.
 *
 * The DB *file* is always named after `appName` (e.g. `obsidian-local-sync.db`).
 * The Evolu instance *cache key* includes a monotonic counter so each call
 * creates a fresh instance.  The `wrappedFactory` ignores the Evolu-provided
 * `name` argument and always opens the fixed `appName` file.
 */
let _clientGeneration = 0;

/**
 * Creates the Evolu client and returns it together with a `closeDb` callback.
 *
 * `closeDb` must be called on plugin unload.  It cancels the sqliteDriver's
 * debounce timer and immediately flushes the in-memory SQLite database to disk,
 * ensuring that the last history cursor and any other pending mutations are
 * persisted before the plugin is torn down.  Without this, changes written in
 * the last {@link SAVE_DEBOUNCE_MS} window would be lost and the cursor would
 * appear reset on the next startup.
 */
export function createEvoluClient(
  appName: string,
  relayUrl: string,
  dataDir: string,
) {
  const dbFileName = SimpleName.orThrow(appName);

  // Capture the driver instance created inside createDbWorkerForPlatform so
  // we can call [Symbol.dispose] on plugin unload for an immediate disk flush.
  let disposeDriver: (() => void) | null = null;

  const innerFactory = createPersistentSqlJsDriver(dataDir);
  const wrappedFactory: CreateSqliteDriver = async (_name, options) => {
    // Always open the file named after `appName` — not the session-unique
    // Evolu instance name — so that restarts read the same persisted DB.
    const driver = await innerFactory(dbFileName, options);
    // Use flush() rather than [Symbol.dispose]: flush saves to disk without
    // closing the database, so Evolu's async callbacks can still run after
    // plugin unload without hitting "Database closed" errors.
    disposeDriver = () => (driver as any).flush?.();
    return driver;
  };

  const createDbWorker = () =>
    createDbWorkerForPlatform({
      console: createConsole(),
      createSqliteDriver: wrappedFactory,
      createWebSocket,
      random: createRandom(),
      randomBytes: createRandomBytes(),
      time: createTime(),
    });

  const deps: EvoluDeps = {
    console: createConsole(),
    createDbWorker,
    randomBytes: createRandomBytes(),
    reloadApp: () => {},
    time: createTime(),
  };

  // Unique instance name per call bypasses Evolu's module-level instance cache.
  // Generation 0 uses the bare appName (backward-compatible with any persisted
  // state tied to that name); subsequent restarts append the counter.
  const generation = _clientGeneration++;
  const rawName =
    generation === 0 ? appName : `${appName}-${generation}`.slice(0, 64);

  const evolu = createEvolu(deps)(Schema, {
    name: SimpleName.orThrow(rawName), // unique per call; bypasses module-level cache
    transports: [{ type: "WebSocket", url: relayUrl }],
  });

  return {
    evolu,
    closeDb: () => disposeDriver?.(),
  };
}

/**
 * Generates a fresh random 24-word mnemonic using the same entropy source
 * Evolu uses internally.  Use this as the argument to `restoreAppOwner` when
 * you want a clean reset with a new identity (instead of calling
 * `resetAppOwner`, which skips `initializeDb` and leaves internal Evolu tables
 * missing).
 */
export function generateMnemonic(): string {
  const randomBytes = createRandomBytes();
  const secret = createOwnerSecret({ randomBytes });
  return ownerSecretToMnemonic(secret);
}
