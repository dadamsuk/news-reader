import { fetchGuardianBody } from '../adapters';
import { loadSettings, saveSettings } from '../core/settings';
import { effectiveReaderMode, type Secrets } from '../core/sources';
import type { FetchFn } from '../core/types';
import { errMsg, safeJson } from '../core/util';
import type { Db } from '../db/db';
import { extractArticle, sanitizeHtml } from './extract';

/** Offline image storage. Implemented with expo-file-system on the phone. */
export interface Files {
  saveImage(articleId: number, url: string, index: number): Promise<string | null>;
  removeArticles(articleIds: number[]): Promise<void>;
}

export interface BodyDeps {
  db: Db;
  fetch: FetchFn;
  secrets: Secrets;
  now: () => number;
  files: Files | null;
}

export type BodySource = 'extract' | 'api' | 'live';

export interface BodyResult {
  status: 'ok' | 'browser' | 'failed';
  source?: BodySource;
  cached?: boolean;
}

const MAX_OFFLINE_IMAGES = 14;
const LIVE_TTL_MS = 5 * 60_000;

async function saveBody(d: BodyDeps, id: number, html: string, source: BodySource): Promise<void> {
  await d.db.run('UPDATE article SET body_html = ?, body_source = ?, body_tried_at = ?, offline_images = NULL WHERE id = ?',
    [html, source, d.now(), id]);
}

async function noteExtractFailure(d: BodyDeps, articleId: number, title: string, reason: string): Promise<void> {
  const s = await loadSettings(d.db);
  await saveSettings(d.db, { extractFailures: s.extractFailures + 1 });
  await d.db.run('INSERT INTO decision_log(at, kind, ref_id, summary, detail) VALUES(?,?,?,?,?)',
    [d.now(), 'extract', articleId, `Extraction failed: ${title}`.slice(0, 300), JSON.stringify({ reason })]);
}

/** Downloads the article's images for offline reading and records where they are. */
export async function cacheImages(d: BodyDeps, articleId: number): Promise<number> {
  if (!d.files) return 0;
  const row = await d.db.get<any>('SELECT body_html, image_url, offline_images FROM article WHERE id = ?', [articleId]);
  if (!row) return 0;
  const map = safeJson<Record<string, string>>(row.offline_images, {});
  const urls: string[] = [];
  if (row.image_url) urls.push(row.image_url);
  const re = /<img src="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(row.body_html ?? ''))) {
    const u = m[1].replace(/&amp;/g, '&');
    if (/^https?:/i.test(u) && !urls.includes(u)) urls.push(u);
  }
  let added = 0;
  const wanted = urls.slice(0, MAX_OFFLINE_IMAGES);
  for (let i = 0; i < wanted.length; i++) {
    if (map[wanted[i]]) continue;
    const local = await d.files.saveImage(articleId, wanted[i], i).catch(() => null);
    if (local) {
      map[wanted[i]] = local;
      added++;
    }
  }
  if (added) await d.db.run('UPDATE article SET offline_images = ? WHERE id = ?', [JSON.stringify(map), articleId]);
  return added;
}

/**
 * Makes sure an article has a readable body, in the order the spec gives:
 * extraction from the public page, then the adapter's own body, then (status "browser"/"failed")
 * the in-app browser. Guardian live blogs use the API's latest 20 blocks.
 */
export async function ensureBody(
  d: BodyDeps, articleId: number, opts: { withImages?: boolean; force?: boolean } = {},
): Promise<BodyResult> {
  const row = await d.db.get<any>(
    `SELECT a.id, a.url, a.title, a.tone, a.external_id, a.body_html, a.body_source, a.body_tried_at, a.adapter_body,
            s.adapter, s.endpoint, s.api_key_ref, s.reader_mode, s.paywalled
     FROM article a JOIN source s ON s.id = a.source_id WHERE a.id = ?`,
    [articleId],
  );
  if (!row) return { status: 'failed' };
  const mode = effectiveReaderMode({ readerMode: row.reader_mode, paywalled: !!row.paywalled });
  if (mode === 'browser') return { status: 'browser' };

  const isGuardian = row.adapter === 'guardian_content_api';
  const live = row.tone === 'live' && isGuardian && !!row.external_id;
  const liveFresh = live && row.body_source === 'live' && d.now() - (row.body_tried_at ?? 0) < LIVE_TTL_MS;
  if (row.body_html && !opts.force && (!live || liveFresh)) {
    if (opts.withImages) await cacheImages(d, articleId);
    return { status: 'ok', source: row.body_source, cached: true };
  }

  let key: string | null = null;
  const getKey = async () => {
    if (key == null && row.api_key_ref) key = await d.secrets.get(row.api_key_ref).catch(() => null);
    return key;
  };
  const finish = async (html: string, source: BodySource): Promise<BodyResult> => {
    await saveBody(d, articleId, html, source);
    if (opts.withImages) await cacheImages(d, articleId);
    return { status: 'ok', source };
  };

  if (live && (await getKey())) {
    try {
      const r = await fetchGuardianBody(d.fetch, row.endpoint, key!, row.external_id, true);
      const clean = r.html ? sanitizeHtml(r.html, row.url) : null;
      if (clean && clean.textLength > 100) return await finish(clean.html, 'live');
    } catch {
      // fall through to the page, then the cached copy
    }
    if (row.body_html) return { status: 'ok', source: row.body_source, cached: true };
  }

  if (mode === 'extract') {
    let reason = '';
    try {
      const res = await d.fetch(row.url, { timeoutMs: 25000, headers: { Accept: 'text/html,application/xhtml+xml' } });
      if (!res.ok) reason = `HTTP ${res.status}`;
      else {
        const ex = extractArticle(await res.text(), row.url);
        if (ex) return await finish(ex.html, 'extract');
        reason = 'no article content found';
      }
    } catch (e) {
      reason = errMsg(e);
    }
    await noteExtractFailure(d, articleId, row.title, reason);
  }

  // The adapter's own body: from the feed, or the Guardian item endpoint.
  let apiHtml: string | null = row.adapter_body ?? null;
  if (!apiHtml && isGuardian && row.external_id && (await getKey())) {
    try {
      apiHtml = (await fetchGuardianBody(d.fetch, row.endpoint, key!, row.external_id, false)).html;
    } catch {
      apiHtml = null;
    }
  }
  if (apiHtml) {
    const clean = sanitizeHtml(apiHtml, row.url);
    if (clean.textLength > 200) return await finish(clean.html, 'api');
  }
  await d.db.run('UPDATE article SET body_tried_at = ? WHERE id = ?', [d.now(), articleId]);
  return { status: 'failed' };
}
