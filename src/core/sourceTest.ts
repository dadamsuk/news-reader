import { fetchSource } from '../adapters';
import { adapterNeedsKey } from './sources';
import { DAY, type FetchFn, type Source } from './types';
import { errMsg } from './util';

export interface SourceTestResult {
  ok: boolean;
  items: { title: string; publishedAt: number | null; section: string | null }[];
  total: number;
  error: string | null;
}

/** The Test button: fetch once and show the first five items, or the error. Nothing is stored. */
export async function testSource(
  fetchFn: FetchFn,
  source: Pick<Source, 'adapter' | 'endpoint' | 'name' | 'includeSections' | 'excludeSections'> & Partial<Pick<Source, 'isDigest' | 'config'>>,
  apiKey: string | null,
  now: number,
): Promise<SourceTestResult> {
  try {
    if (adapterNeedsKey(source.adapter) && !apiKey) throw new Error('No API key set for this source');
    const { items, partialError } = await fetchSource(source, { fetch: fetchFn, apiKey, since: now - 7 * DAY, now, maxPages: 1 });
    const sorted = items.slice().sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return {
      ok: !partialError,
      items: sorted.slice(0, 5).map((i) => ({ title: i.title, publishedAt: i.publishedAt ?? null, section: i.section ?? null })),
      total: items.length,
      error: partialError ? errMsg(partialError, [apiKey]) : items.length ? null : 'The source answered but returned no items.',
    };
  } catch (e) {
    return { ok: false, items: [], total: 0, error: errMsg(e, [apiKey]) };
  }
}

/** Validates a source key with one small call. Returns null when it works, else a message. */
export async function validateSourceKey(
  fetchFn: FetchFn,
  source: Pick<Source, 'adapter' | 'endpoint' | 'name'>,
  apiKey: string,
  now: number,
): Promise<string | null> {
  try {
    await fetchSource({ ...source, includeSections: [], excludeSections: [] }, { fetch: fetchFn, apiKey, since: now - DAY, now, maxPages: 1 });
    return null;
  } catch (e) {
    const m = errMsg(e, [apiKey]);
    return /401|403/.test(m) ? `${source.name} rejected this key.` : `${source.name}: ${m}`;
  }
}
