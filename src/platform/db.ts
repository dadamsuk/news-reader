import * as SQLite from 'expo-sqlite';
import { seedDefaultSources } from '../core/sources';
import { makeTx, migrate, type Db, type Param } from '../db/db';

export const DB_NAME = 'news.db';

let opening: Promise<Db> | null = null;
let rawDb: SQLite.SQLiteDatabase | null = null;

function wrap(raw: SQLite.SQLiteDatabase): Db {
  const exec = (sql: string) => raw.execAsync(sql);
  return {
    exec,
    async run(sql: string, params: Param[] = []) {
      const r = await raw.runAsync(sql, params);
      return { changes: r.changes, lastInsertRowId: r.lastInsertRowId };
    },
    all<T>(sql: string, params: Param[] = []) {
      return raw.getAllAsync<T>(sql, params);
    },
    get<T>(sql: string, params: Param[] = []) {
      return raw.getFirstAsync<T>(sql, params);
    },
    tx: makeTx(exec),
  };
}

/** Opens (once) the app database, applies migrations and seeds the default sources on first run. */
export function getDb(): Promise<Db> {
  if (!opening) {
    opening = (async () => {
      const raw = await SQLite.openDatabaseAsync(DB_NAME);
      await raw.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      rawDb = raw;
      const db = wrap(raw);
      await migrate(db);
      await seedDefaultSources(db);
      return db;
    })();
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

/** Path of the SQLite file, after folding the write-ahead log into it (for Export database). */
export async function checkpointAndGetPath(): Promise<string> {
  await getDb();
  await rawDb!.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  return rawDb!.databasePath;
}
