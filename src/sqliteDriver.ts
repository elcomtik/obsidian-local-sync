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
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveToDisk();
      }, SAVE_DEBOUNCE_MS);
    }

    return {
      exec: (query, isMutation) => {
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
