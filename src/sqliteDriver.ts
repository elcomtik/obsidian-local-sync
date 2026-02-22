import initSqlJs from "sql.js/dist/sql-asm.js";
import type { CreateSqliteDriver } from "@evolu/common";
import fs from "node:fs";
import path from "node:path";

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

const SAVE_DEBOUNCE_MS = 5_000;

/**
 * Creates an Evolu `CreateSqliteDriver` factory backed by sql.js (asm.js) with
 * file-based persistence via Node.js `fs`.
 *
 * The returned factory, when called by Evolu with a database name:
 * 1. Loads an existing `<name>.db` file from `dataDir` on open, or starts a
 *    fresh in-memory database if the file does not exist.
 * 2. After each mutation that modifies at least one row, arms a
 *    {@link SAVE_DEBOUNCE_MS}-millisecond debounce save to disk.
 * 3. On `[Symbol.dispose]`: cancels any pending debounce, immediately flushes
 *    the database to disk, then closes the sql.js instance.
 *
 * This replaces `@evolu/web`, which is incompatible with Obsidian's CJS plugin
 * context (`import.meta.url` unavailable, no SharedWebWorker, no OPFS).
 *
 * @param dataDir Absolute directory path where `.db` files are stored.
 *                Typically `<vault>/.obsidian/plugins/obsidian-local-sync/`.
 */
export function createPersistentSqlJsDriver(
  dataDir: string,
): CreateSqliteDriver {
  return async (name, options) => {
    const SQL = await getSql();

    const dbPath = path.join(dataDir, `${String(name)}.db`);
    let existingData: Buffer | null = null;
    try {
      existingData = fs.readFileSync(dbPath);
    } catch {
      // No existing database — start fresh
    }

    const db =
      existingData && !options?.memory
        ? new SQL.Database(existingData)
        : new SQL.Database();

    let isDisposed = false;
    // Set to true after flush() — prevents stale post-reload disk writes from
    // an old driver instance overwriting the new instance's saved state.
    let isFlushed = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    function saveToDisk() {
      if (isDisposed) return;
      try {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
      } catch (e) {
        console.error("[obsidian-local-sync] ERROR: Failed to save database", e);
      }
    }

    function scheduleSave() {
      // Don't arm new saves after the plugin has been unloaded.
      if (isFlushed || isDisposed) return;
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveToDisk();
      }, SAVE_DEBOUNCE_MS);
    }

    /**
     * Cancels any pending debounce timer and immediately writes the current
     * in-memory database to disk, **without** closing the sql.js instance.
     *
     * Call this on plugin unload.  After returning, the driver enters a "sealed"
     * state: in-memory queries and mutations still succeed (so Evolu's async
     * callbacks don't throw), but no further disk writes are scheduled.  This
     * prevents a stale old-plugin-instance from overwriting the new instance's
     * cursor and mutation state on disk.
     */
    function flushToDisk() {
      if (isDisposed) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      saveToDisk();
      isFlushed = true;
    }

    return {
      flush: flushToDisk,

      exec: (query, isMutation) => {
        // After dispose the sql.js DB is closed; return empty results rather
        // than letting db.run/exec throw "Database closed" which would bubble
        // up as an Evolu SqliteError on every relay message received by a stale
        // plugin instance.
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
        saveToDisk();
        db.close();
      },
    };
  };
}
