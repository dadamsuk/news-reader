import type { Db } from '../db/db';
import {
  ADAPTERS, LEANS, READER_MODES, ROLES,
  type Lean, type ReaderMode, type Source, type SourceInput,
} from './types';
import { safeJson } from './util';

export interface Secrets {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

const NON_NEWS = ['sport', 'football', 'showbiz', 'tvshowbiz', 'celebrity', 'tv', 'femail', 'travel', 'lifestyle', 'fabulous', 'puzzles', 'entertainment'];

export const DEFAULT_SOURCES: SourceInput[] = [
  {
    // production-office=-aus leaves out Guardian Australia (UK and US pieces stay).
    name: 'Guardian', adapter: 'guardian_content_api', endpoint: 'https://content.guardianapis.com/search?production-office=-aus',
    apiKeyRef: 'source_key_guardian', role: 'primary', lean: 'left', readerMode: 'extract', paywalled: false,
    includeSections: [], excludeSections: ['crosswords', 'info', 'help', 'membership', 'guardian-masterclasses'],
    refreshMinutes: 30, enabled: true,
  },
  {
    name: 'BBC News', adapter: 'rss',
    endpoint: 'https://feeds.bbci.co.uk/news/rss.xml\nhttps://feeds.bbci.co.uk/news/politics/rss.xml',
    apiKeyRef: null, role: 'perspective', lean: 'centre', readerMode: 'extract', paywalled: false,
    includeSections: [], excludeSections: ['sport', 'sounds', 'iplayer', 'videos'], refreshMinutes: 30, enabled: true,
  },
  {
    name: 'The Economist', adapter: 'rss', endpoint: 'https://www.economist.com/latest/rss.xml',
    apiKeyRef: null, role: 'perspective', lean: 'centre', readerMode: 'browser', paywalled: true,
    includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
  },
  {
    // US: news pages are generally rated left of centre. Paywalled, so opened in the browser.
    name: 'The New York Times', adapter: 'rss',
    endpoint: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml\nhttps://rss.nytimes.com/services/xml/rss/nyt/US.xml',
    apiKeyRef: null, role: 'perspective', lean: 'left', readerMode: 'browser', paywalled: true,
    includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
  },
  {
    // US: news pages are generally rated centre (its opinion pages lean right). The old
    // feeds.a.dj.com feeds stopped in January 2025; these are the current Dow Jones ones.
    name: 'The Wall Street Journal', adapter: 'rss',
    endpoint: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews\nhttps://feeds.content.dowjones.io/public/rss/RSSUSnews',
    apiKeyRef: null, role: 'perspective', lean: 'centre', readerMode: 'browser', paywalled: true,
    includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
  },
  {
    name: 'The Telegraph', adapter: 'rss',
    endpoint: 'https://www.telegraph.co.uk/rss.xml\nhttps://www.telegraph.co.uk/news/rss.xml',
    apiKeyRef: null, role: 'perspective', lean: 'right', readerMode: 'browser', paywalled: true,
    includeSections: [], excludeSections: [...NON_NEWS, 'rugby-union', 'cricket', 'golf', 'tennis', 'food-and-drink', 'films', 'gardening'],
    refreshMinutes: 30, enabled: true,
  },
  {
    name: 'The Times', adapter: 'google_news_search', endpoint: 'site:thetimes.com',
    apiKeyRef: null, role: 'perspective', lean: 'right', readerMode: 'browser', paywalled: true,
    includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
  },
  {
    // The Spectator moved to spectator.com and no longer publishes an RSS feed (checked Nov 2026).
    name: 'The Spectator', adapter: 'google_news_search', endpoint: 'site:spectator.com',
    apiKeyRef: null, role: 'perspective', lean: 'right', readerMode: 'browser', paywalled: true,
    includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
  },
  {
    name: 'Daily Mail', adapter: 'rss',
    // dailymail.co.uk redirects to dailymail.com: asking .com directly saves a round trip per feed.
    endpoint: 'https://www.dailymail.com/news/index.rss\nhttps://www.dailymail.com/news/uk-politics/index.rss',
    apiKeyRef: null, role: 'perspective', lean: 'right', readerMode: 'extract', paywalled: false,
    includeSections: [], excludeSections: NON_NEWS, refreshMinutes: 30, enabled: true,
  },
  {
    name: 'Daily Express', adapter: 'rss',
    endpoint: 'https://www.express.co.uk/posts/rss/1/news\nhttps://www.express.co.uk/posts/rss/139/politics',
    apiKeyRef: null, role: 'perspective', lean: 'right', readerMode: 'extract', paywalled: false,
    includeSections: [], excludeSections: NON_NEWS, refreshMinutes: 30, enabled: true,
  },
  {
    name: 'The Sun', adapter: 'rss',
    endpoint: 'https://www.thesun.co.uk/news/feed/\nhttps://www.thesun.co.uk/news/politics/feed/',
    apiKeyRef: null, role: 'perspective', lean: 'right', readerMode: 'extract', paywalled: false,
    includeSections: [], excludeSections: NON_NEWS, refreshMinutes: 30, enabled: true,
  },
  {
    name: 'GB News', adapter: 'rss',
    endpoint: 'https://www.gbnews.com/feeds/news.rss\nhttps://www.gbnews.com/feeds/politics.rss',
    apiKeyRef: null, role: 'perspective', lean: 'right', readerMode: 'extract', paywalled: false,
    includeSections: [], excludeSections: NON_NEWS, refreshMinutes: 30, enabled: true,
  },
];

function rowToSource(r: any): Source {
  return {
    id: r.id,
    name: r.name,
    adapter: r.adapter,
    endpoint: r.endpoint,
    apiKeyRef: r.api_key_ref ?? null,
    role: r.role,
    lean: r.lean,
    readerMode: r.reader_mode,
    paywalled: !!r.paywalled,
    includeSections: safeJson<string[]>(r.include_sections, []),
    excludeSections: safeJson<string[]>(r.exclude_sections, []),
    refreshMinutes: r.refresh_minutes,
    enabled: !!r.enabled,
    lastOkAt: r.last_ok_at ?? null,
    lastError: r.last_error ?? null,
    lastFetchAt: r.last_fetch_at ?? null,
    lastNewAt: r.last_new_at ?? null,
  };
}

export async function listSources(db: Db): Promise<Source[]> {
  return (await db.all('SELECT * FROM source ORDER BY (role = \'primary\') DESC, id')).map(rowToSource);
}

export async function getSource(db: Db, id: number): Promise<Source | null> {
  const r = await db.get('SELECT * FROM source WHERE id = ?', [id]);
  return r ? rowToSource(r) : null;
}

export function adapterNeedsKey(adapter: string): boolean {
  return adapter === 'guardian_content_api';
}

/** Checks a source record; returns a list of problems (empty when valid). */
export function validateSource(s: SourceInput): string[] {
  const errs: string[] = [];
  if (!s.name?.trim()) errs.push('Name is required');
  if (!ADAPTERS.includes(s.adapter)) errs.push('Unknown adapter');
  if (!s.endpoint?.trim()) errs.push('Endpoint is required');
  if (s.adapter !== 'google_news_search') {
    for (const u of splitEndpoints(s.endpoint)) {
      if (!/^https?:\/\/\S+$/i.test(u)) errs.push(`Not a URL: ${u}`);
    }
  }
  if (!ROLES.includes(s.role)) errs.push('Unknown role');
  if (!LEANS.includes(s.lean)) errs.push('Unknown lean');
  if (!READER_MODES.includes(s.readerMode)) errs.push('Unknown reader mode');
  if (!(s.refreshMinutes >= 1)) errs.push('Refresh minutes must be 1 or more');
  return errs;
}

export function splitEndpoints(endpoint: string): string[] {
  return endpoint.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
}

/** Paywalled sources never use extract; an API body is not available for every adapter. */
export function effectiveReaderMode(s: Pick<Source, 'readerMode' | 'paywalled'>): ReaderMode {
  if (s.paywalled && s.readerMode === 'extract') return 'browser';
  return s.readerMode;
}

function newKeyRef(): string {
  return 'source_key_' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
}

export async function insertSource(db: Db, s: SourceInput): Promise<number> {
  const ref = adapterNeedsKey(s.adapter) ? s.apiKeyRef || newKeyRef() : s.apiKeyRef;
  const r = await db.run(
    `INSERT INTO source(name, adapter, endpoint, api_key_ref, role, lean, reader_mode, paywalled,
       include_sections, exclude_sections, refresh_minutes, enabled)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.name.trim(), s.adapter, s.endpoint.trim(), ref ?? null, s.role, s.lean, s.readerMode, s.paywalled ? 1 : 0,
      JSON.stringify(s.includeSections ?? []), JSON.stringify(s.excludeSections ?? []),
      Math.round(s.refreshMinutes), s.enabled ? 1 : 0],
  );
  return r.lastInsertRowId;
}

export class SourceRuleError extends Error {}

async function assertPrimaryRule(db: Db): Promise<void> {
  const row = await db.get<{ n: number }>("SELECT COUNT(*) n FROM source WHERE role = 'primary' AND enabled = 1");
  if (!row || row.n < 1) throw new SourceRuleError('At least one primary source must be enabled.');
}

export async function updateSource(db: Db, id: number, s: SourceInput): Promise<void> {
  const errs = validateSource(s);
  if (errs.length) throw new SourceRuleError(errs.join('. '));
  await db.tx(async () => {
    const before = await getSource(db, id);
    if (!before) throw new SourceRuleError('Source not found');
    const ref = adapterNeedsKey(s.adapter) ? before.apiKeyRef || s.apiKeyRef || newKeyRef() : before.apiKeyRef;
    const endpointChanged = before.endpoint.trim() !== s.endpoint.trim() || before.adapter !== s.adapter;
    await db.run(
      `UPDATE source SET name=?, adapter=?, endpoint=?, api_key_ref=?, role=?, lean=?, reader_mode=?, paywalled=?,
         include_sections=?, exclude_sections=?, refresh_minutes=?, enabled=?
         ${endpointChanged ? ', last_fetch_at=NULL, last_ok_at=NULL, last_error=NULL' : ''}
       WHERE id=?`,
      [s.name.trim(), s.adapter, s.endpoint.trim(), ref ?? null, s.role, s.lean, s.readerMode, s.paywalled ? 1 : 0,
        JSON.stringify(s.includeSections ?? []), JSON.stringify(s.excludeSections ?? []),
        Math.round(s.refreshMinutes), s.enabled ? 1 : 0, id],
    );
    await assertPrimaryRule(db);
  });
}

export async function createSource(db: Db, s: SourceInput): Promise<number> {
  const errs = validateSource(s);
  if (errs.length) throw new SourceRuleError(errs.join('. '));
  return insertSource(db, { ...s, apiKeyRef: null });
}

export async function duplicateSource(db: Db, id: number): Promise<number> {
  const s = await getSource(db, id);
  if (!s) throw new SourceRuleError('Source not found');
  // The copy starts as a disabled perspective source with its own (empty) key slot.
  return insertSource(db, { ...s, name: `${s.name} copy`, apiKeyRef: null, enabled: false });
}

export async function deleteSource(db: Db, secrets: Secrets, id: number): Promise<void> {
  const s = await getSource(db, id);
  if (!s) return;
  await db.tx(async () => {
    await db.run('DELETE FROM source WHERE id = ?', [id]);
    await assertPrimaryRule(db);
    await db.run('DELETE FROM second_source WHERE other_article_id IN (SELECT id FROM article WHERE source_id = ?)', [id]);
    await db.run('DELETE FROM second_source WHERE primary_article_id IN (SELECT id FROM article WHERE source_id = ?)', [id]);
    await db.run('DELETE FROM article WHERE source_id = ?', [id]);
  });
  if (s.apiKeyRef) await secrets.remove(s.apiKeyRef).catch(() => {});
}

export async function seedDefaultSources(db: Db): Promise<void> {
  const row = await db.get<{ n: number }>('SELECT COUNT(*) n FROM source');
  if (row && row.n > 0) return;
  await db.tx(async () => {
    for (const s of DEFAULT_SOURCES) await insertSource(db, s);
  });
}

// ---- JSON export / import (keys are never exported) ----

export interface SourcesExport {
  version: 1;
  sources: Omit<SourceInput, 'apiKeyRef'>[];
}

export async function exportSources(db: Db): Promise<SourcesExport> {
  const all = await listSources(db);
  return {
    version: 1,
    sources: all.map((s) => ({
      name: s.name, adapter: s.adapter, endpoint: s.endpoint, role: s.role, lean: s.lean,
      readerMode: s.readerMode, paywalled: s.paywalled, includeSections: s.includeSections,
      excludeSections: s.excludeSections, refreshMinutes: s.refreshMinutes, enabled: s.enabled,
    })),
  };
}

export function parseSourcesExport(json: string): SourceInput[] {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new SourceRuleError('Not valid JSON');
  }
  const list = Array.isArray(data) ? data : data?.sources;
  if (!Array.isArray(list) || list.length === 0) throw new SourceRuleError('No sources found in the file');
  const out: SourceInput[] = list.map((raw: any, i: number) => {
    const s: SourceInput = {
      name: String(raw?.name ?? ''),
      adapter: raw?.adapter,
      endpoint: String(raw?.endpoint ?? ''),
      apiKeyRef: null,
      role: raw?.role,
      lean: raw?.lean as Lean,
      readerMode: raw?.readerMode,
      paywalled: !!raw?.paywalled,
      includeSections: Array.isArray(raw?.includeSections) ? raw.includeSections.map(String) : [],
      excludeSections: Array.isArray(raw?.excludeSections) ? raw.excludeSections.map(String) : [],
      refreshMinutes: Number(raw?.refreshMinutes ?? 30),
      enabled: raw?.enabled !== false,
    };
    const errs = validateSource(s);
    if (errs.length) throw new SourceRuleError(`Source ${i + 1} (${s.name || 'unnamed'}): ${errs.join('. ')}`);
    return s;
  });
  if (!out.some((s) => s.role === 'primary' && s.enabled)) {
    throw new SourceRuleError('The import must contain at least one enabled primary source.');
  }
  return out;
}

/**
 * Replaces the sources table with the imported list. A source that matches an existing one by
 * name and adapter keeps its id (so its articles and stored key survive); the rest are removed.
 */
export async function importSources(db: Db, secrets: Secrets, json: string): Promise<number> {
  const incoming = parseSourcesExport(json);
  const existing = await listSources(db);
  const removedRefs: string[] = [];
  await db.tx(async () => {
    const used = new Set<number>();
    for (const s of incoming) {
      const match = existing.find((e) => !used.has(e.id) && e.name === s.name && e.adapter === s.adapter);
      if (match) {
        used.add(match.id);
        const endpointChanged = match.endpoint.trim() !== s.endpoint.trim();
        await db.run(
          `UPDATE source SET endpoint=?, role=?, lean=?, reader_mode=?, paywalled=?, include_sections=?,
             exclude_sections=?, refresh_minutes=?, enabled=?
             ${endpointChanged ? ', last_fetch_at=NULL, last_ok_at=NULL, last_error=NULL' : ''} WHERE id=?`,
          [s.endpoint.trim(), s.role, s.lean, s.readerMode, s.paywalled ? 1 : 0, JSON.stringify(s.includeSections),
            JSON.stringify(s.excludeSections), Math.round(s.refreshMinutes), s.enabled ? 1 : 0, match.id],
        );
      } else {
        await insertSource(db, s);
      }
    }
    for (const e of existing) {
      if (used.has(e.id)) continue;
      await db.run('DELETE FROM second_source WHERE other_article_id IN (SELECT id FROM article WHERE source_id = ?)', [e.id]);
      await db.run('DELETE FROM second_source WHERE primary_article_id IN (SELECT id FROM article WHERE source_id = ?)', [e.id]);
      await db.run('DELETE FROM article WHERE source_id = ?', [e.id]);
      await db.run('DELETE FROM source WHERE id = ?', [e.id]);
      if (e.apiKeyRef) removedRefs.push(e.apiKeyRef);
    }
  });
  for (const ref of removedRefs) await secrets.remove(ref).catch(() => {});
  return incoming.length;
}

export type Health = 'green' | 'amber' | 'red' | 'grey';

/** Green: fetching and producing items. Amber: nothing new in 24 hours. Red: last fetch failed. */
export function sourceHealth(s: Source, now: number): Health {
  if (!s.enabled || (!s.lastFetchAt && !s.lastError)) return 'grey';
  if (s.lastError) return 'red';
  const lastNew = s.lastNewAt ?? 0;
  if (now - lastNew > 24 * 3600_000) return 'amber';
  return 'green';
}

export const LEAN_ORDER: Record<Lean, number> = { left: 0, 'centre-left': 1, centre: 2, 'centre-right': 3, right: 4 };

export function isRightLeaning(lean: Lean): boolean {
  return lean === 'right' || lean === 'centre-right';
}
