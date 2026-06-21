import initSqlJs from "sql.js/dist/sql-asm.js";
import type { CreateSqliteDriver } from "@evolu/common";
import { formatLogLine, type LogFormatter } from "../src-core/logFormat";

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

const SAVE_DEBOUNCE_MS = 5_000;

/**
 * Platform-independent file I/O for the SQLite database.
 *
 * On desktop, implemented via Obsidian's DataAdapter (backed by Node fs).
 * On mobile (Android/iOS), implemented via the mobile vault adapter.
 * Both platforms expose the same DataAdapter API — no direct Node.js imports.
 */
export type PlatformIO = {
  readFile: () => Promise<Uint8Array | null>;
  writeFile: (data: Uint8Array) => Promise<void>;
  deleteFile?: () => Promise<void>;
};

export type SqlJsDriverOptions = {
  saveDebounceMs?: number;
};

/**
 * Creates an Evolu `CreateSqliteDriver` factory backed by sql.js (asm.js) with
 * file-based persistence via the platform-independent `io` abstraction.
 *
 * 1. On open: loads the existing DB file via `io.readFile()`, or starts fresh.
 * 2. After each mutation: arms a {@link SAVE_DEBOUNCE_MS}-ms debounce write.
 * 3. On `persist()`: immediately awaits a write without sealing the driver.
 * 4. On `flush()`: cancels the debounce and immediately awaits the write.
 *    Call this on plugin unload to guarantee the cursor and recent mutations
 *    are persisted before the process can be interrupted.
 *
 * This replaces `@evolu/web`, which is incompatible with Obsidian's CJS plugin
 * context (`import.meta.url` unavailable, no SharedWebWorker, no OPFS).
 */
export function createPersistentSqlJsDriver(
  io: PlatformIO,
  logFormatter: LogFormatter = formatLogLine,
  driverOptions: SqlJsDriverOptions = {},
): CreateSqliteDriver {
  return async (_name, options) => {
    const SQL = await getSql();

    let existingData: Uint8Array | null = null;
    try {
      existingData = await io.readFile();
    } catch {
      // No existing database — start fresh.
    }

    const db =
      existingData && !options?.memory
        ? new SQL.Database(existingData)
        : new SQL.Database();

    let isDisposed = false;
    // Set to true after flush() — prevents stale post-reload disk writes from
    // an old driver instance overwriting the new instance's saved state.
    let isFlushed = false;
    const saveDebounceMs = driverOptions.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let writeChain: Promise<void> = Promise.resolve();
    let writeGeneration = 0;

    function persistToDisk(data: Uint8Array, force = false): Promise<void> {
      const generation = writeGeneration;
      writeChain = writeChain.then(async () => {
        if (!force && (isDisposed || isFlushed || generation !== writeGeneration)) return;
        await io.writeFile(data);
      });
      return writeChain;
    }

    function saveToDisk(): void {
      if (isDisposed || isFlushed) return;
      const data = db.export();
      persistToDisk(data).catch((e) => {
        console.error(logFormatter("ERROR", "Failed to save database", e));
      });
    }

    function scheduleSave() {
      if (isFlushed || isDisposed) return;
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveToDisk();
      }, saveDebounceMs);
    }

    /**
     * Cancels any pending debounce timer and immediately awaits a write of the
     * current in-memory database, **without** closing the sql.js instance.
     *
     * Call this on plugin unload.  After returning, the driver enters a "sealed"
     * state: in-memory queries and mutations still succeed (so Evolu's async
     * callbacks don't throw), but no further disk writes are scheduled.  This
     * prevents a stale old-plugin-instance from overwriting the new instance's
     * cursor and mutation state on disk.
     */
    async function flushToDisk(): Promise<void> {
      if (isDisposed) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      isFlushed = true; // Seal before IO — prevents new saves from arming.
      const data = db.export();
      try {
        await persistToDisk(data, true);
      } catch (e) {
        console.error(logFormatter("ERROR", "Failed to save database", e));
      }
    }

    async function persistCurrentState(): Promise<void> {
      if (isDisposed || isFlushed) return;
      const data = db.export();
      try {
        await persistToDisk(data, true);
      } catch (e) {
        console.error(logFormatter("ERROR", "Failed to save database", e));
      }
    }

    function discardPendingWrites(): void {
      if (isDisposed) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      isFlushed = true;
      writeGeneration++;
    }

    return {
      persist: persistCurrentState,
      flush: flushToDisk,
      discard: discardPendingWrites,

      exec: (query, isMutation) => {
        // After dispose the sql.js DB is closed; return empty results rather
        // than letting db.run/exec throw "Database closed" on every relay
        // message received by a stale plugin instance.
        if (isDisposed) return { rows: [], changes: 0 };

        if (isMutation) {
          db.run(query.sql, query.parameters as any[]);
          const changes = db.getRowsModified();
          if (changes > 0) scheduleSave();
          return { rows: [], changes };
        }

        const results = db.exec(query.sql, query.parameters as any[]);
        if (results.length === 0) {
          return { rows: [], changes: 0 };
        }

        const { columns, values } = results[0];
        const rows = values.map((row) => {
          const obj: Record<string, any> = {};
          for (let i = 0; i < columns.length; i++) {
            obj[columns[i]] = row[i];
          }
          return obj;
        });

        return { rows, changes: 0 };
      },

      export: () => db.export(),

      [Symbol.dispose]: () => {
        if (isDisposed) return;
        isDisposed = true;
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        if (!isFlushed) {
          // Export before closing DB, then write asynchronously.
          const data = db.export();
          persistToDisk(data).catch((e) => {
            console.error(logFormatter("ERROR", "Failed to save database", e));
          });
        }
        db.close();
      },
    };
  };
}
