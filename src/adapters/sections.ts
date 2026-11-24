import { parseHTML } from 'linkedom';
import { containsTerm } from '../core/topics';
import type { FetchFn, RawItem } from '../core/types';
import { canonicalUrl, countWords, decodeEntities, mapLimit } from '../core/util';

/**
 * Adapters and splitting used by the sections-layout modes: Hacker News (`hn_api`), a list of
 * links read from a web page (`html_list`), and digests (an issue that links to many stories),
 * which are split into one item per story. Plain TypeScript, no timers.
 */

interface Ctx {
  fetch: FetchFn;
  since: number;
  now: number;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------- hn_api

export const HN_DEFAULTS = { minPoints: 150, limit: 60 };

/**
 * Hacker News: the stories on the configured lists (front page and best by default), keeping those
 * at or above the points threshold whose title matches the keyword prefilter. Points grow, so a
 * story below the threshold now is looked at again on the next fetch.
 */
export async function fetchHn(endpoints: string[], config: Record<string, unknown>, ctx: Ctx): Promise<RawItem[]> {
  const minPoints = num(config.minPoints, HN_DEFAULTS.minPoints);
  const limit = num(config.limit, HN_DEFAULTS.limit);
  const keywords = Array.isArray(config.keywords) ? (config.keywords as unknown[]).map(String).filter(Boolean) : [];
  const ids: number[] = [];
  let base = 'https://hacker-news.firebaseio.com/v0';
  for (const url of endpoints) {
    const res = await ctx.fetch(url, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error(`${url}: not a list of stories`);
    base = url.replace(/\/[^/]*$/, '');
    for (const id of list.slice(0, limit)) if (typeof id === 'number' && !ids.includes(id)) ids.push(id);
  }
  const out: RawItem[] = [];
  await mapLimit(ids, 12, async (id) => {
    try {
      const res = await ctx.fetch(`${base}/item/${id}.json`, { timeoutMs: 15000 });
      if (!res.ok) return;
      const it = await res.json();
      if (!it || it.type !== 'story' || it.dead || it.deleted || !it.title) return;
      const points = Number(it.score) || 0;
      if (points < minPoints) return;
      const title = decodeEntities(String(it.title));
      if (keywords.length && !keywords.some((k) => containsTerm(title, k))) return;
      const thread = `https://news.ycombinator.com/item?id=${id}`;
      out.push({
        url: typeof it.url === 'string' && /^https?:/i.test(it.url) ? it.url : thread,
        title,
        summary: `${points} points and ${Number(it.descendants) || 0} comments on Hacker News.`,
        publishedAt: (Number(it.time) || 0) * 1000 || undefined,
        hnPoints: points,
        mentionUrl: thread,
        externalId: `hn:${id}`,
        tags: [],
      });
    } catch {
      // one story failing never stops the rest
    }
  });
  return out.sort((a, b) => (b.hnPoints ?? 0) - (a.hnPoints ?? 0));
}

// ---------------------------------------------------------------- html_list

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DATE_TEXT = new RegExp(`\\b(${MONTHS})[a-z]*\\.? \\d{1,2},? \\d{4}\\b|\\b\\d{1,2} (${MONTHS})[a-z]* \\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');

function dateNear(el: any): number | undefined {
  // The nearest <time> (or a date written out) in the link's card: the link itself, then up to five parents.
  let node = el;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const time = node.querySelector?.('time');
    if (time) {
      const v = Date.parse(time.getAttribute('datetime') || time.textContent || '');
      if (Number.isFinite(v)) return v;
    }
    const m = DATE_TEXT.exec(node.textContent ?? '');
    if (m && (node.textContent ?? '').length < 600) {
      const v = Date.parse(m[0]);
      if (Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * A page that lists articles but has no feed: each link whose path matches `linkPattern` (a
 * regular expression; default: any link on the same site), with a title of at least `minTitleWords`
 * words (a heading inside the link, else the link text), and a date from the card it sits in.
 */
export function parseHtmlList(html: string, pageUrl: string, config: Record<string, unknown>, now: number): RawItem[] {
  const { document } = parseHTML(html);
  const origin = /^https?:\/\/[^/]+/i.exec(pageUrl)?.[0] ?? '';
  const pattern = typeof config.linkPattern === 'string' && config.linkPattern ? new RegExp(config.linkPattern) : null;
  const minWords = num(config.minTitleWords, 4);
  const seen = new Set<string>();
  const out: RawItem[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')) as any[]) {
    const href = String(a.getAttribute('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|javascript):/i.test(href)) continue;
    const abs = /^https?:/i.test(href) ? href : href.startsWith('/') ? origin + href : `${pageUrl.replace(/\/[^/]*$/, '')}/${href}`;
    const path = abs.slice(origin.length).split(/[?#]/)[0];
    if (pattern ? !(abs.startsWith(origin) && pattern.test(path)) : !abs.startsWith(origin) || path === '/' || abs === pageUrl) continue;
    const heading = a.querySelector('h1, h2, h3, h4');
    const title = clean(heading?.textContent || a.textContent || '');
    if (countWords(title) < minWords) continue;
    const key = canonicalUrl(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    const p = a.querySelector('p');
    out.push({ url: abs, title: title.slice(0, 300), summary: p ? clean(p.textContent ?? '').slice(0, 400) : '', publishedAt: dateNear(a) ?? now, tags: [] });
  }
  return out;
}

export async function fetchHtmlList(endpoints: string[], config: Record<string, unknown>, ctx: Ctx): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (const url of endpoints) {
    const res = await ctx.fetch(url, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    out.push(...parseHtmlList(await res.text(), url, config, ctx.now));
  }
  return out;
}

// ---------------------------------------------------------------- digests

/** Hosts whose links are discussion of a story rather than the story (used only when nothing better is linked). */
const SOCIAL = /(^|\.)(x\.com|twitter\.com|reddit\.com|discord\.(gg|com)|youtube\.com|youtu\.be|linkedin\.com|threads\.net|bsky\.app|instagram\.com|facebook\.com|news\.ycombinator\.com|t\.co)$/i;
/** Links that are never a story: sign-ups, shares, sponsors' own tracking, forms. */
const NOT_STORY = /(unsubscribe|subscribe|signup|sign-up|preferences|manage|advertise|sponsor|share|intent\/|typeform|forms\.gle|mailto:)/i;

const hostOf = (u: string) => /^https?:\/\/([^/?#]+)/i.exec(u)?.[1].toLowerCase().replace(/^www\./, '') ?? '';

/**
 * Splits one digest issue into one item per story. A story is a block of the issue (an <article>,
 * or a top-level list item, or a paragraph, whichever the issue is built from) holding a link
 * away from the digest's own site. Its link is the first one that is not social discussion (the
 * first link, if all are); its title is the block's heading, the link text, or the block's first
 * sentence; the block's text is kept as the digest's context. Sponsored blocks are skipped.
 */
export function splitDigestIssue(
  html: string, issue: { url: string; title: string; publishedAt?: number }, maxPerIssue = 30,
): RawItem[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const own = hostOf(issue.url);
  const external = (el: any) => (Array.from(el.querySelectorAll('a[href]')) as any[])
    .map((a) => ({ href: String(a.getAttribute('href') ?? '').trim(), text: clean(a.textContent ?? '') }))
    .filter((l) => /^https?:/i.test(l.href) && hostOf(l.href) !== own && !NOT_STORY.test(l.href));
  const pick = (sel: string, topLevel = false) => (Array.from(document.querySelectorAll(sel)) as any[])
    .filter((el) => !topLevel || !el.parentElement?.closest('li'))
    .filter((el) => external(el).length > 0);
  let blocks = pick('article');
  if (blocks.length < 2) blocks = pick('li', true);
  if (blocks.length < 2) blocks = pick('p');
  const out: RawItem[] = [];
  const seen = new Set<string>();
  for (const el of blocks) {
    if (out.length >= maxPerIssue) break;
    const text = clean(el.textContent ?? '');
    if (/\((sponsor|sponsored|ad)\)|^sponsored\b/i.test(text)) continue;
    const links = external(el);
    const link = links.find((l) => !SOCIAL.test(hostOf(l.href))) ?? links[0];
    const key = canonicalUrl(link.href);
    if (seen.has(key)) continue;
    seen.add(key);
    const heading = clean(el.querySelector('h1, h2, h3, h4')?.textContent ?? '');
    const firstSentence = (/^.*?[.!?](\s|$)/.exec(text)?.[0] ?? text).trim().split(/\s+/).slice(0, 22).join(' ');
    let title = heading || (countWords(link.text) >= 4 ? link.text : firstSentence);
    title = title.replace(/\s*\(\d+\s+minute\s+(read|watch|listen)\)\s*$/i, '').trim();
    if (!title) continue;
    out.push({
      url: link.href,
      title: title.slice(0, 300),
      summary: '',
      publishedAt: issue.publishedAt,
      digestContext: text.slice(0, 700),
      mentionUrl: issue.url,
      tags: [],
    });
  }
  return out;
}

/**
 * Digest sources: each issue becomes its stories. An issue whose feed entry carries its content is
 * split from that; one that is only a link (TLDR's feed) is fetched and split from its page.
 */
export async function splitDigests(items: RawItem[], config: Record<string, unknown>, ctx: Ctx): Promise<RawItem[]> {
  const max = num(config.maxPerIssue, 30);
  const out: RawItem[] = [];
  for (const issue of items) {
    if (issue.publishedAt != null && issue.publishedAt < ctx.since) continue;
    let html = issue.contentHtml ?? issue.adapterBody ?? '';
    // An entry that is only a link (or a teaser with no links in it) is read from the issue's page.
    if (!/<a\s[^>]*href=/i.test(html) || countWords(html.replace(/<[^>]*>/g, ' ')) < 30) {
      try {
        const res = await ctx.fetch(issue.url, { timeoutMs: 20000 });
        if (res.ok) html = await res.text();
      } catch {
        // the issue page did not load: try again at the next fetch
        continue;
      }
    }
    out.push(...splitDigestIssue(html, issue, max));
  }
  return out;
}
