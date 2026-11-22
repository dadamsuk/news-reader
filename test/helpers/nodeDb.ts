import Database from 'better-sqlite3';
import { makeTx, migrate, type Db, type Param } from '../../src/db/db';
import type { Secrets } from '../../src/core/sources';
import type { FetchFn } from '../../src/core/types';

export function openNodeDb(file = ':memory:'): Db & { close(): void; raw: Database.Database } {
  const raw = new Database(file);
  const exec = async (sql: string) => {
    raw.exec(sql);
  };
  return {
    raw,
    exec,
    async run(sql: string, params: Param[] = []) {
      const r = raw.prepare(sql).run(...(params as any[]));
      return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async all<T>(sql: string, params: Param[] = []) {
      return raw.prepare(sql).all(...(params as any[])) as T[];
    },
    async get<T>(sql: string, params: Param[] = []) {
      const stmt = raw.prepare(sql);
      if (!stmt.reader) {
        stmt.run(...(params as any[]));
        return null;
      }
      return (stmt.get(...(params as any[])) as T) ?? null;
    },
    tx: makeTx(exec),
    close() {
      raw.close();
    },
  };
}

export async function freshDb() {
  const db = openNodeDb();
  await migrate(db);
  return db;
}

export function memorySecrets(initial: Record<string, string> = {}): Secrets & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(ref) {
      return store.get(ref) ?? null;
    },
    async set(ref, v) {
      store.set(ref, v);
    },
    async remove(ref) {
      store.delete(ref);
    },
  };
}

/** Real network fetch with a timeout, for the live smoke run. */
export const nodeFetch: FetchFn = async (url, init = {}) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', ...(init.headers ?? {}) },
      body: init.body,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, text: () => res.text(), json: () => res.json() };
  } finally {
    clearTimeout(t);
  }
};
