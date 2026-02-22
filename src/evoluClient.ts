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
import type { EvoluDeps } from "@evolu/common";
import { createPersistentSqlJsDriver } from "./sqliteDriver";
import { Schema } from "./schema";

export function createEvoluClient(
  appName: string,
  relayUrl: string,
  dataDir: string,
) {
  const createDbWorker = () =>
    createDbWorkerForPlatform({
      console: createConsole(),
      createSqliteDriver: createPersistentSqlJsDriver(dataDir),
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

  return createEvolu(deps)(Schema, {
    name: SimpleName.orThrow(appName),
    transports: [{ type: "WebSocket", url: relayUrl }],
  });
}
