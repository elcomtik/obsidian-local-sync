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
import type { CreateSqliteDriver, Evolu, EvoluDeps, Mnemonic } from "@evolu/common";
import type { Database } from "../src-core/schema";
import { createPersistentSqlJsDriver, type PlatformIO } from "./sqliteDriver";
import { Schema } from "../src-core/schema";
import { formatLogLine, type LogFormatter } from "../src-core/logFormat";

/**
 * Custom console passed to Evolu deps.
 *
 * Evolu's `createConsole` unconditionally calls `console.error()` for error-
 * level messages (the `enableLogging` flag only gates log/warn/info/debug).
 * When the relay WebSocket cannot connect, Evolu logs its own relay-level
 * errors via `deps.console.error`, which appear in the Obsidian developer
 * console as red unhandled errors — alarming but not actionable.
 *
 * The raw `"WebSocket connection to 'wss://...' failed"` messages that the
 * Electron runtime emits *before* any JS handler cannot be intercepted here;
 * those are a platform concern.  But Evolu's own error-level relay/storage
 * messages *can* be demoted to warn so they do not flood the error stream.
 */
function createEvoluConsole(logFormatter: LogFormatter) {
  return {
    ...createConsole(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error: (...args: any[]) => {
      console.warn(logFormatter("WARN", "Evolu error", args));
    },
  };
}

/**
 * Module-level Evolu client singleton.
 *
 * `[Symbol.dispose]()` on the Evolu instance is not implemented in
 * @evolu/common 7.4.1 — calling it throws.  This means there is no way to
 * fully shut down an Evolu instance: its relay WebSocket keeps reconnecting
 * until the process exits.
 *
 * Consequence: creating a new Evolu instance on every plugin reload leaks the
 * old WebSocket permanently for the lifetime of the Obsidian process, causing
 * an ever-growing stack of `WebSocket connection failed` errors in the console.
 *
 * Fix: cache the client at module level and reuse it across plugin disable →
 * enable cycles.  A new client is created only when reset/restore genuinely
 * needs a fresh relay identity (different mnemonic → different WebSocket
 * authentication).  The SQLite driver's `flush()` is still called on every
 * unload to persist the history cursor.
 */
let _cached: { evolu: Evolu<Database>; flush: () => Promise<void> } | null = null;

/**
 * Returns the Evolu client for `appName` / `relayUrl`, creating it on the
 * first call and reusing it on subsequent calls.  Pass `forceNew: true` only
 * when reset/restore needs a fresh relay connection with a new identity.
 *
 * `closeDb` flushes the SQLite driver to disk without closing anything —
 * safe to call on every plugin unload.
 *
 * `io` provides platform-independent file I/O for the SQLite database.
 * Use `app.vault.adapter.readBinary/writeBinary` on both desktop and mobile
 * (Obsidian's DataAdapter API is available on all platforms).
 */
export function createEvoluClient(
  appName: string,
  relayUrl: string,
  io: PlatformIO,
  {
    forceNew = false,
    logFormatter = formatLogLine,
  }: { forceNew?: boolean; logFormatter?: LogFormatter } = {},
) {
  if (_cached && !forceNew) {
    return { evolu: _cached.evolu, closeDb: _cached.flush };
  }

  let flush: () => Promise<void> = async () => {};

  const evoluConsole = createEvoluConsole(logFormatter);
  const innerFactory = createPersistentSqlJsDriver(io, logFormatter);
  const wrappedFactory: CreateSqliteDriver = async (_name, options) => {
    const driver = await innerFactory(_name, options);
    flush = async () => { await (driver as any).flush?.(); };
    return driver;
  };

  const createDbWorker = () =>
    createDbWorkerForPlatform({
      console: evoluConsole,
      createSqliteDriver: wrappedFactory,
      createWebSocket,
      random: createRandom(),
      randomBytes: createRandomBytes(),
      time: createTime(),
    });

  const deps: EvoluDeps = {
    console: evoluConsole,
    createDbWorker,
    randomBytes: createRandomBytes(),
    reloadApp: () => {},
    time: createTime(),
  };

  // Use a unique name each time forceNew is true so createEvolu's module-level
  // cache gives us a genuinely fresh instance with a new relay WebSocket.
  // Normal (non-forceNew) calls always use the bare appName so they hit the
  // same cache slot — but since we guard with _cached ourselves, createEvolu's
  // cache is a belt-and-suspenders safety net, not the primary mechanism.
  const instanceName = forceNew
    ? `${appName}-${Date.now()}`.slice(0, 64)
    : appName;

  const evolu = createEvolu(deps)(Schema, {
    name: SimpleName.orThrow(instanceName),
    transports: [{ type: "WebSocket", url: relayUrl }],
  });

  const closeDb = () => flush();
  _cached = { evolu, flush: closeDb };
  return { evolu, closeDb };  // closeDb: () => Promise<void>
}

/**
 * Generates a fresh random 24-word mnemonic using the same entropy source
 * Evolu uses internally.  Use this as the argument to `restoreAppOwner` when
 * you want a clean reset with a new identity (instead of calling
 * `resetAppOwner`, which skips `initializeDb` and leaves internal Evolu tables
 * missing).
 */
export function generateMnemonic(): Mnemonic {
  const randomBytes = createRandomBytes();
  const secret = createOwnerSecret({ randomBytes });
  return ownerSecretToMnemonic(secret);
}
