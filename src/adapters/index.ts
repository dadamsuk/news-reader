import { XMLParser } from 'fast-xml-parser';
import { splitEndpoints } from '../core/sources';
import type { FetchFn, RawItem, Source, Tone } from '../core/types';
import { countWords, decodeEntities, stripHtml } from '../core/util';
import { fetchHn, fetchHtmlList, splitDigests } from './sections';

export interface AdapterCtx {
  fetch: FetchFn;
  apiKey?: string | null;
  /** Only items published after this time are wanted. */
  since: number;
  now: number;
  /** Page limit for paged APIs (default 6). */
  maxPages?: number;
}

type AdapterSource = Pick<Source, 'adapter' | 'endpoint' | 'name' | 'includeSections' | 'excludeSections'>
  & Partial<Pick<Source, 'isDigest' | 'config'>>;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: false,
});

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Text of an XML node that may be a string, a CDATA wrapper, or an object with attributes. */
function text(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') {
    if (v['#cdata'] != null) return text(v['#cdata']);
    if (v['#text'] != null) return text(v['#text']);
  }
  return '';
}

function parseDate(s: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

const SKIP_PATH = new Set(['news', 'article', 'articles', 'story', 'www', 'uk', 'world', 'home', 'index']);

/** A section guess from the URL path, for feeds that carry no category. */
export function sectionFromUrl(url: string): string | undefined {
  const m = /^https?:\/\/[^/]+\/([^?#]*)/.exec(url);
  if (!m) return undefined;
  const parts = m[1].split('/').filter((p) => p && !/^\d+$/.test(p) && !/\.\w{2,5}$/.test(p));
  // The last path part is normally the article slug.
  const candidates = parts.slice(0, -1).filter((p) => p.length < 30 && !/^article-/.test(p));
  const pick = candidates.find((p) => !SKIP_PATH.has(p.toLowerCase())) ?? candidates[0];
  return pick ? pick.toLowerCase() : undefined;
}

function urlPathParts(url: string): string[] {
  const m = /^https?:\/\/[^/]+\/([^?#]*)/.exec(url);
  return m ? m[1].toLowerCase().split('/').filter(Boolean) : [];
}

/** include/exclude match on section, any tag or category, or a URL path part (case-insensitive). */
export function passesSectionFilter(item: RawItem, include: string[], exclude: string[]): boolean {
  if (!include.length && !exclude.length) return true;
  const hay = new Set<string>();
  const add = (s?: string) => {
    if (!s) return;
    const v = s.toLowerCase().trim();
    hay.add(v);
    hay.add(v.replace(/\s+/g, '-'));
  };
  add(item.section);
  (item.tags ?? []).forEach(add);
  urlPathParts(item.url).slice(0, -1).forEach(add);
  const norm = (s: string) => s.toLowerCase().trim();
  if (exclude.some((e) => hay.has(norm(e)))) return false;
  if (include.length && !include.some((e) => hay.has(norm(e)))) return false;
  return true;
}

function firstImg(html: string): string | undefined {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return m ? decodeEntities(m[1]) : undefined;
}

function bestMedia(nodes: any[]): string | undefined {
  let best: string | undefined;
  let bestW = -1;
  for (const n of nodes) {
    const url = n?.['@_url'];
    if (!url) continue;
    const type = String(n['@_type'] ?? n['@_medium'] ?? '');
    if (type && !/image/i.test(type) && !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) continue;
    const w = parseInt(n['@_width'] ?? '0', 10) || 0;
    if (w > bestW) {
      bestW = w;
      best = url;
    }
  }
  return best;
}

export function parseFeed(xmlText: string): RawItem[] {
  let doc: any;
  try {
    doc = xml.parse(xmlText);
  } catch {
    throw new Error('Feed is not valid XML');
  }
  const out: RawItem[] = [];
  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'];
  if (channel) {
    for (const it of arr<any>(channel.item ?? doc?.['rdf:RDF']?.item)) {
      const link = text(it.link) || text(it.guid);
      const title = stripHtml(text(it.title));
      if (!link || !/^https?:/i.test(link) || !title) continue;
      const descHtml = text(it.description);
      const content = text(it['content:encoded']);
      const media = [
        ...arr<any>(it['media:content']),
        ...arr<any>(it['media:thumbnail']),
        ...arr<any>(it['media:group']?.['media:content']),
        ...arr<any>(it.enclosure),
      ];
      const cats = arr<any>(it.category).map((c) => stripHtml(text(c))).filter(Boolean);
      const summary = stripHtml(descHtml);
      out.push({
        url: link.trim(),
        title,
        summary: summary.length > 600 ? summary.slice(0, 600) + '…' : summary,
        imageUrl: bestMedia(media) ?? firstImg(content) ?? firstImg(descHtml),
        publishedAt: parseDate(text(it.pubDate) || text(it['dc:date'])),
        section: cats[0] ?? sectionFromUrl(link),
        tags: cats,
        byline: stripHtml(text(it['dc:creator']) || text(it.author)) || undefined,
        wordCount: content ? countWords(stripHtml(content)) : undefined,
        adapterBody: content && stripHtml(content).length > 600 ? content : undefined,
        contentHtml: content || descHtml || undefined,
      });
    }
    return out;
  }
  const feed = doc?.feed;
  if (feed) {
    for (const e of arr<any>(feed.entry)) {
      const links = arr<any>(e.link);
      const alt = links.find((l) => (l?.['@_rel'] ?? 'alternate') === 'alternate') ?? links[0];
      const link = alt?.['@_href'] ?? text(alt);
      const title = stripHtml(text(e.title));
      if (!link || !/^https?:/i.test(link) || !title) continue;
      const content = text(e.content);
      const summaryHtml = text(e.summary);
      const summary = stripHtml(summaryHtml || content);
      const cats = arr<any>(e.category).map((c) => c?.['@_term'] ?? text(c)).filter(Boolean);
      const media = [...arr<any>(e['media:content']), ...arr<any>(e['media:thumbnail'])];
      out.push({
        url: String(link).trim(),
        title,
        summary: summary.length > 600 ? summary.slice(0, 600) + '…' : summary,
        imageUrl: bestMedia(media) ?? firstImg(content) ?? firstImg(summaryHtml),
        publishedAt: parseDate(text(e.published) || text(e.updated)),
        section: cats[0] ?? sectionFromUrl(String(link)),
        tags: cats,
        byline: stripHtml(text(e.author?.name ?? arr<any>(e.author)[0]?.name)) || undefined,
        wordCount: content ? countWords(stripHtml(content)) : undefined,
        adapterBody: content && stripHtml(content).length > 600 ? content : undefined,
        contentHtml: content || summaryHtml || undefined,
      });
    }
    return out;
  }
  throw new Error('Not an RSS or Atom feed');
}

async function getText(ctx: AdapterCtx, url: string): Promise<string> {
  const res = await ctx.fetch(url, { timeoutMs: 20000, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchRss(source: AdapterSource, ctx: AdapterCtx): Promise<RawItem[]> {
  const urls = splitEndpoints(source.endpoint);
  const out: RawItem[] = [];
  let firstError: unknown = null;
  let okCount = 0;
  // A source's feeds are fetched at the same time (on a phone each is mostly network wait);
  // their items are still taken in the order the feeds are listed.
  const results = await Promise.allSettled(urls.map(async (url) => parseFeed(await getText(ctx, url))));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      out.push(...r.value);
      okCount++;
    } else {
      const e = r.reason;
      firstError = firstError ?? new Error(`${urls[i]}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  // Any failing feed marks the source red, but the items that did arrive are still used.
  if (firstError && okCount === 0) throw firstError;
  if (firstError) (out as any).partialError = firstError;
  return out;
}

export function googleNewsUrl(query: string): string {
  const q = query.trim();
  if (/^https?:\/\//i.test(q)) return q;
  const withWindow = /\bwhen:\w+/.test(q) ? q : `${q} when:2d`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(withWindow)}&hl=en-GB&gl=GB&ceid=GB:en`;
}

async function fetchGoogleNews(source: AdapterSource, ctx: AdapterCtx): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (const q of splitEndpoints(source.endpoint)) {
    const items = parseFeed(await getText(ctx, googleNewsUrl(q)));
    for (const it of items) {
      // Google appends " - Outlet name" to every headline and its description is only a link list.
      const title = it.title.replace(/\s+[-–|]\s+[^-–|]{2,40}$/, '').trim();
      out.push({ ...it, title: title || it.title, summary: '', section: undefined, tags: [], imageUrl: undefined });
    }
  }
  return out;
}

const TONE_MAP: Record<string, Tone> = {
  'tone/news': 'news',
  'tone/comment': 'comment',
  'tone/editorials': 'comment',
  'tone/letters': 'comment',
  'tone/analysis': 'analysis',
  'tone/explainers': 'analysis',
  'tone/minutebyminute': 'live',
};

export function guardianItem(r: any): RawItem | null {
  const url = r?.webUrl;
  const f = r?.fields ?? {};
  const title = stripHtml(f.headline || r?.webTitle);
  if (!url || !title) return null;
  const tags: any[] = arr<any>(r.tags);
  let tone: Tone | undefined;
  for (const t of tags) {
    if (t?.type === 'tone' && TONE_MAP[t.id]) {
      // A live blog is the most specific label; otherwise keep the first recognised tone.
      if (TONE_MAP[t.id] === 'live') tone = 'live';
      else tone = tone ?? TONE_MAP[t.id];
    }
  }
  if (r.type === 'liveblog') tone = 'live';
  const wc = parseInt(f.wordcount ?? '', 10);
  return {
    url,
    title,
    summary: stripHtml(f.trailText),
    imageUrl: f.thumbnail || undefined,
    publishedAt: parseDate(r.webPublicationDate),
    section: r.sectionName || r.sectionId || undefined,
    tags: [
      ...(r.sectionId ? [String(r.sectionId)] : []),
      ...tags.filter((t) => t?.type === 'keyword').map((t) => String(t.webTitle)).slice(0, 12),
    ],
    tone: tone ?? 'news',
    byline: stripHtml(f.byline) || undefined,
    wordCount: Number.isFinite(wc) ? wc : undefined,
    externalId: r.id,
    adapterBody: typeof f.body === 'string' && f.body.length > 0 ? f.body : undefined,
  };
}

export function guardianBaseUrl(endpoint: string): string {
  return (splitEndpoints(endpoint)[0] ?? 'https://content.guardianapis.com/search').trim();
}

function withParams(url: string, params: Record<string, string>): string {
  const [base, query = ''] = url.split('?');
  const existing = query.split('&').filter(Boolean).filter((kv) => !(kv.split('=')[0] in params));
  const added = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `${base}?${[...existing, ...added].join('&')}`;
}

async function fetchGuardian(source: AdapterSource, ctx: AdapterCtx): Promise<RawItem[]> {
  if (!ctx.apiKey) throw new Error('No API key set for this source');
  const out: RawItem[] = [];
  const from = new Date(ctx.since).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const maxPages = ctx.maxPages ?? 6;
  for (let page = 1; page <= maxPages; page++) {
    const url = withParams(guardianBaseUrl(source.endpoint), {
      'api-key': ctx.apiKey,
      'from-date': from,
      'use-date': 'published',
      'order-by': 'newest',
      'page-size': '100',
      page: String(page),
      'show-fields': 'headline,trailText,byline,wordcount,thumbnail',
      'show-tags': 'keyword,tone',
    });
    const res = await ctx.fetch(url, { timeoutMs: 20000 });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.message || j?.response?.message || '';
      } catch {}
      throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    const body = (await res.json())?.response;
    if (!body || body.status !== 'ok') throw new Error(body?.message || 'Unexpected Guardian API response');
    for (const r of arr<any>(body.results)) {
      const it = guardianItem(r);
      if (it) out.push(it);
    }
    if (page >= (body.pages ?? 1)) break;
  }
  return out;
}

/** Guardian item endpoint: the API's own body, and the latest blocks for live blogs. */
export async function fetchGuardianBody(
  fetchFn: FetchFn, endpoint: string, apiKey: string, externalId: string, live: boolean,
): Promise<{ html: string | null; thumbnail: string | null }> {
  // Items live beside the search endpoint: .../search -> .../<content id>
  const origin = guardianBaseUrl(endpoint).split('?')[0].replace(/\/search\/?$/, '').replace(/\/+$/, '')
    || 'https://content.guardianapis.com';
  const params: Record<string, string> = { 'api-key': apiKey, 'show-fields': 'body,thumbnail' };
  if (live) params['show-blocks'] = 'body:latest:20';
  const res = await fetchFn(withParams(`${origin}/${externalId}`, params), { timeoutMs: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const content = (await res.json())?.response?.content;
  const thumbnail = content?.fields?.thumbnail ?? null;
  if (live) {
    const blocks: any[] = arr<any>(content?.blocks?.requestedBodyBlocks?.['body:latest:20'] ?? content?.blocks?.body);
    if (blocks.length) {
      const html = blocks.slice(0, 20).map((b) => {
        const when = b.firstPublishedDate || b.publishedDate || b.createdDate;
        const t = when ? new Date(when) : null;
        const stamp = t && Number.isFinite(t.getTime())
          ? `<p class="block-time">${t.toISOString().slice(0, 16).replace('T', ' ')} UTC</p>` : '';
        const title = b.title ? `<h3>${b.title}</h3>` : '';
        return `<section class="live-block">${stamp}${title}${b.bodyHtml ?? ''}</section>`;
      }).join('<hr>');
      return { html, thumbnail };
    }
  }
  return { html: content?.fields?.body || null, thumbnail };
}

/** Fetches a source and applies its section filters and the time window. */
export async function fetchSource(source: AdapterSource, ctx: AdapterCtx): Promise<{ items: RawItem[]; partialError?: string }> {
  let items: RawItem[];
  switch (source.adapter) {
    case 'guardian_content_api':
      items = await fetchGuardian(source, ctx);
      break;
    case 'rss':
      items = await fetchRss(source, ctx);
      break;
    case 'google_news_search':
      items = await fetchGoogleNews(source, ctx);
      break;
    case 'hn_api':
      items = await fetchHn(splitEndpoints(source.endpoint), source.config ?? {}, ctx);
      break;
    case 'html_list':
      items = await fetchHtmlList(splitEndpoints(source.endpoint), source.config ?? {}, ctx);
      break;
    default:
      throw new Error(`Unknown adapter: ${String((source as any).adapter)}`);
  }
  const partial = (items as any).partialError as Error | undefined;
  // A digest issue links to many stories: one item per story, never one item per issue.
  if (source.isDigest) items = await splitDigests(items, source.config ?? {}, ctx);
  const filtered = items.filter(
    (it) =>
      passesSectionFilter(it, source.includeSections, source.excludeSections) &&
      (it.publishedAt == null || it.publishedAt >= ctx.since) &&
      (it.publishedAt == null || it.publishedAt <= ctx.now + 3600_000),
  );
  return { items: filtered, partialError: partial ? partial.message : undefined };
}
