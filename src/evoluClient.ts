import {
  createConsole,
  createEvolu,
  createRandom,
  createRandomBytes,
  createTime,
  createWebSocket,
  SimpleName,
} from "@evolu/common";
import { createDbWorkerForPlatform } from "@evolu/common/local-first";
import type { CreateSqliteDriver, EvoluDeps } from "@evolu/common";
import { createPersistentSqlJsDriver } from "./sqliteDriver";
import { Schema } from "./schema";

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
  // Capture the driver instance created inside createDbWorkerForPlatform so
  // we can call [Symbol.dispose] on plugin unload for an immediate disk flush.
  let disposeDriver: (() => void) | null = null;

  const innerFactory = createPersistentSqlJsDriver(dataDir);
  const wrappedFactory: CreateSqliteDriver = async (name, options) => {
    const driver = await innerFactory(name, options);
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

  const evolu = createEvolu(deps)(Schema, {
    name: SimpleName.orThrow(appName),
    transports: [{ type: "WebSocket", url: relayUrl }],
  });

  return {
    evolu,
    closeDb: () => disposeDriver?.(),
  };
}
