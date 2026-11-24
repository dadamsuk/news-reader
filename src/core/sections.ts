import type { Db } from '../db/db';
import { placeholders } from '../db/db';
import { HIDING_KINDS } from './ranking';
import { inColdStart, loadWeights, normTag } from './learning';
import { getMode, loadSectionsSettings, sectionDefs, type Mode, type SectionDef, type SectionsSettings } from './modes';
import type { FeedCard, InteractionKind } from './types';
import { countWords, safeJson, stripHtml } from './util';
import { ARTICLE_COLS, loadFeed, rowToArticle } from './feed';
import type { Settings } from './settings';

/** Where a story goes: the main section, In other news, or held back (never shown). */
export type Placement = 'main' | 'other' | 'held';

/** The relevance a story needs for the main section now (lower during the cold start). */
export function relevanceThreshold(s: SectionsSettings, now: number): number {
  return inColdStart(s, now) ? s.coldRelevanceThreshold : s.relevanceThreshold;
}

/** How many In other news stories to show: 3 to 5 (more during the cold start). */
export function otherNewsCount(s: SectionsSettings, now: number): number {
  const n = inColdStart(s, now) ? s.coldOtherNewsCount : s.otherNewsCount;
  return Math.max(3, Math.min(5, Math.round(n)));
}

export function placement(relevance: number, significance: number, s: SectionsSettings, now: number): Placement {
  if (relevance >= relevanceThreshold(s, now)) return 'main';
  if (significance >= s.otherNewsMinSignificance) return 'other';
  return 'held';
}

/** Another source covering the story, behind "+N more". */
export interface MoreSource {
  sourceName: string;
  /** An article of the mode to open in the reader, or null when only a link is known (a mention). */
  articleId: number | null;
  url: string;
  title: string;
}

export interface SectionCard extends FeedCard {
  clusterId: number;
  placement: Placement;
  /** "Why it matters to you" (main section only). */
  why: string | null;
  more: MoreSource[];
  readMinutes: number | null;
  /** In other news: "Widely covered", "Major release", "Trending on HN" or "High impact". */
  reason: string | null;
  relevance: number;
  significance: number;
  /** False until the model has written the headline and summary (the source's headline shows meanwhile). */
  enriched: boolean;
  tags: string[];
  itemType: string | null;
  whyLines: string[];
}

export interface SectionsView {
  sections: { def: SectionDef; cards: SectionCard[] }[];
  /** Unseen cards across the sections, for the mode bar. */
  unseen: number;
  settings: SectionsSettings;
}

const HIDING: InteractionKind[] = [...HIDING_KINDS, 'viewed', 'hidden'];

/**
 * A sections-layout mode's feed: every story placed in a section, unseen or seen in this session
 * (seen cards stay in place for the session), not expired, not put away. Main: by relevance, then
 * significance. In other news: by significance, 3 to 5 of them, after the main section, and empty
 * (so hidden) when nothing qualifies. The main section is returned whole; the screen shows it 15 at
 * a time ("Show more").
 */
export async function loadSections(db: Db, modeId: number, sessionId: string, now: number): Promise<SectionsView> {
  const mode = await getMode(db, modeId);
  const s = await loadSectionsSettings(db, modeId);
  const defs = mode ? sectionDefs(mode) : [];
  const rows = await db.all<any>(
    `SELECT c.id cid, c.headline, c.summary c_summary, c.why_it_matters, c.tags c_tags, c.item_type, c.relevance, c.significance,
            c.reason, c.source_count, c.enriched_at, c.why_lines, c.profile_match,
            ${ARTICLE_COLS}, LENGTH(a.body_html) body_len, s.name source_name,
            (rl.article_id IS NOT NULL AND rl.done_at IS NULL) saved,
            EXISTS (SELECT 1 FROM interaction m WHERE m.article_id = a.id AND m.kind IN ('interested', 'more')) interested,
            (SELECT MIN(i.first_seen_at) FROM impression i JOIN article m2 ON m2.id = i.article_id
              WHERE m2.cluster_id = c.id AND i.session_id = ? AND i.surface = 'feed') seen_now,
            EXISTS (SELECT 1 FROM impression i JOIN article m3 ON m3.id = i.article_id
              WHERE m3.cluster_id = c.id AND i.session_id != ? AND i.surface IN ('feed', 'coverage')) seen_before
     FROM cluster c
     JOIN article a ON a.id = c.primary_article_id
     JOIN source s ON s.id = a.source_id AND s.enabled = 1
     LEFT JOIN read_later rl ON rl.article_id = a.id
     WHERE c.mode_id = ? AND (c.enriched_at IS NOT NULL OR c.enrich_tried_at IS NOT NULL)
       AND (c.expires_at IS NULL OR c.expires_at > ?)
       AND NOT EXISTS (SELECT 1 FROM interaction x JOIN article m4 ON m4.id = x.article_id
                       WHERE m4.cluster_id = c.id AND x.kind IN (${HIDING.map((k) => `'${k}'`).join(',')}))`,
    [sessionId, sessionId, modeId, now],
  );
  const cards: SectionCard[] = [];
  for (const r of rows) {
    if (r.seen_before && r.seen_now == null) continue; // seen in an earlier session: gone for good
    const relevance = r.relevance ?? 0;
    const significance = r.significance ?? 0;
    // Not yet enriched (budget cap, failed call): shown in the main section with the source's headline.
    const place = r.enriched_at != null ? placement(relevance, significance, s, now) : 'main';
    if (place === 'held') continue;
    const article = rowToArticle(r);
    const enriched = r.enriched_at != null && !!r.headline;
    const words = article.wordCount || (r.body_len ? Math.round(r.body_len / 6.5) : 0);
    cards.push({
      article: { ...article, title: enriched ? r.headline : article.title, summary: enriched ? r.c_summary ?? '' : article.summary },
      sourceName: r.source_name,
      score: place === 'main' ? relevance : significance,
      explore: false,
      seenAt: r.seen_now ?? null,
      saved: !!r.saved,
      interested: !!r.interested,
      goodFit: false,
      second: null,
      outletCount: r.source_count ?? 1,
      watch: null,
      following: false,
      clusterId: r.cid,
      placement: place,
      why: enriched ? r.why_it_matters ?? null : null,
      more: [],
      readMinutes: words > 0 ? Math.max(1, Math.round(words / s.wordsPerMinute)) : null,
      reason: r.reason ?? null,
      relevance,
      significance,
      enriched,
      tags: safeJson<string[]>(r.c_tags, []).map(normTag),
      itemType: r.item_type ?? null,
      whyLines: safeJson<string[]>(r.why_lines, []),
    });
  }
  await attachMore(db, cards);

  const bySeen = (a: SectionCard, b: SectionCard) => a.seenAt! - b.seenAt! || a.clusterId - b.clusterId;
  const main = cards.filter((c) => c.placement === 'main');
  const mainOut = [
    ...main.filter((c) => c.seenAt != null).sort(bySeen),
    ...main.filter((c) => c.seenAt == null).sort((a, b) => b.relevance - a.relevance || b.significance - a.significance || b.article.publishedAt - a.article.publishedAt),
  ];
  const other = cards.filter((c) => c.placement === 'other');
  const seenOther = other.filter((c) => c.seenAt != null).sort(bySeen);
  const room = Math.max(0, otherNewsCount(s, now) - seenOther.length);
  const otherOut = [
    ...seenOther,
    ...other.filter((c) => c.seenAt == null).sort((a, b) => b.significance - a.significance || b.article.publishedAt - a.article.publishedAt).slice(0, room),
  ];
  const sections = defs.map((def) => ({ def, cards: def.type === 'ranked' ? mainOut : otherOut }));
  const unseen = sections.reduce((n, sec) => n + sec.cards.filter((c) => c.seenAt == null).length, 0);
  return { sections, unseen, settings: s };
}

/** "+N more": the story's other sources, one per source (articles first, then mentions). */
async function attachMore(db: Db, cards: SectionCard[]): Promise<void> {
  if (!cards.length) return;
  const byCluster = new Map(cards.map((c) => [c.clusterId, c]));
  const ids = cards.map((c) => c.clusterId);
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const arts = await db.all<any>(
      `SELECT a.id, a.cluster_id, a.source_id, a.url, a.title, s.name FROM article a JOIN source s ON s.id = a.source_id
       WHERE a.cluster_id IN (${placeholders(chunk.length)}) ORDER BY a.published_at`,
      chunk,
    );
    const mentions = await db.all<any>(
      `SELECT a.cluster_id, m.source_id, m.url, a.title, s.name FROM article_mention m
       JOIN article a ON a.id = m.article_id JOIN source s ON s.id = m.source_id
       WHERE a.cluster_id IN (${placeholders(chunk.length)}) ORDER BY m.at`,
      chunk,
    );
    const used = new Map<number, Set<number>>();
    for (const c of chunk) used.set(c, new Set([byCluster.get(c)!.article.sourceId]));
    for (const r of arts) {
      const card = byCluster.get(r.cluster_id);
      if (!card || r.id === card.article.id || used.get(r.cluster_id)!.has(r.source_id)) continue;
      used.get(r.cluster_id)!.add(r.source_id);
      card.more.push({ sourceName: r.name, articleId: r.id, url: r.url, title: r.title });
    }
    for (const r of mentions) {
      const card = byCluster.get(r.cluster_id);
      if (!card || used.get(r.cluster_id)!.has(r.source_id)) continue;
      used.get(r.cluster_id)!.add(r.source_id);
      card.more.push({ sourceName: r.name, articleId: null, url: r.url, title: r.title });
    }
  }
  for (const c of cards) c.outletCount = Math.max(c.outletCount, c.more.length + 1);
}

/** Estimated words of an article body. */
export function bodyWords(html: string | null): number {
  return html ? countWords(stripHtml(html)) : 0;
}

/** "Why am I seeing this" for a sections-layout card: profile lines and the tag weights behind it. */
export async function whySection(db: Db, card: Pick<SectionCard, 'clusterId' | 'tags' | 'whyLines' | 'relevance' | 'significance' | 'placement' | 'reason' | 'article'>, modeId: number): Promise<string[]> {
  const w = await loadWeights(db, modeId);
  const lines: string[] = [];
  for (const l of card.whyLines.slice(0, 3)) lines.push(`Your profile: "${l.replace(/^[-*]\s*/, '')}"`);
  const tagged = card.tags.map((t) => [t, w.tags.get(t) ?? 0] as const).filter(([, v]) => Math.abs(v) >= 0.005)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4);
  for (const [t, v] of tagged) lines.push(`Topic "${t}": learned weight ${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
  const sw = w.sources.get(card.article.sourceId);
  if (sw != null && Math.abs(sw) >= 0.005) lines.push(`Source: learned weight ${sw >= 0 ? '+' : ''}${sw.toFixed(2)}`);
  lines.push(card.placement === 'main'
    ? `Relevance ${card.relevance.toFixed(2)}`
    : `In other news: significance ${card.significance.toFixed(2)}${card.reason ? ` (${card.reason.toLowerCase()})` : ''}, relevance ${card.relevance.toFixed(2)}`);
  return lines;
}

/**
 * The mode bar's counts: unseen cards per mode. News counts the For you cards not yet on screen;
 * a sections-layout mode counts the unseen cards across its sections.
 */
export async function unseenCounts(db: Db, modes: Mode[], settings: Settings, sessionId: string, now: number): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  for (const m of modes) {
    if (m.layout.type === 'news') out[m.id] = (await loadFeed(db, settings, sessionId, now)).filter((c) => c.seenAt == null).length;
    else out[m.id] = (await loadSections(db, m.id, sessionId, now)).unseen;
  }
  return out;
}
