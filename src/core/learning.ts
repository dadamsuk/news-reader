import type { Db } from '../db/db';
import { loadSectionsSettings, saveModeSettings, type SectionsSettings } from './modes';
import { addProfileVersion, getProfile } from './profile';
import { DAY, type InteractionKind } from './types';
import { countWords, safeJson, stripHtml } from './util';

/**
 * Layer 1 of a sections-layout mode's learning: a weight per tag and per source, each an
 * exponential moving average of the signals on stories carrying it. Everything is keyed by mode,
 * so a signal in one mode never touches another.
 */

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number) => Math.max(-1, Math.min(1, x));
export const normTag = (t: string) => t.toLowerCase().trim();

export interface StoryRef {
  modeId: number;
  clusterId: number | null;
  /** The source of the story's primary item (or of the item itself when it is not in a story). */
  sourceId: number;
  tags: string[];
  /** Where the card was: 'main', 'other', or null. */
  section: string | null;
}

/** The story an article belongs to, as far as learning is concerned. */
export async function storyOf(db: Db, articleId: number): Promise<StoryRef | null> {
  const r = await db.get<any>(
    `SELECT a.mode_id, a.source_id, a.cluster_id, c.tags, c.section, p.source_id primary_source
     FROM article a LEFT JOIN cluster c ON c.id = a.cluster_id LEFT JOIN article p ON p.id = c.primary_article_id
     WHERE a.id = ?`,
    [articleId],
  );
  if (!r) return null;
  return {
    modeId: r.mode_id,
    clusterId: r.cluster_id ?? null,
    sourceId: r.primary_source ?? r.source_id,
    tags: Array.from(new Set(safeJson<string[]>(r.tags, []).map(normTag).filter(Boolean))),
    section: r.section ?? null,
  };
}

/**
 * For an article in a sections-layout mode: its estimated read time (from its length) and the share
 * of it that counts as read. Null for News articles, which keep News's own rule.
 */
export async function readEstimate(db: Db, articleId: number): Promise<{ seconds: number; fraction: number } | null> {
  const r = await db.get<any>(
    'SELECT a.mode_id, a.word_count, a.body_html, m.layout FROM article a JOIN mode m ON m.id = a.mode_id WHERE a.id = ?',
    [articleId],
  );
  if (!r || safeJson<{ type?: string }>(r.layout, {}).type !== 'sections') return null;
  const s = await loadSectionsSettings(db, r.mode_id);
  const words = r.word_count || (r.body_html ? countWords(stripHtml(r.body_html)) : 0);
  return { seconds: (words / s.wordsPerMinute) * 60, fraction: s.readFraction };
}

export function signalWeight(kind: InteractionKind, section: string | null, s: SectionsSettings): number {
  const base = s.signalWeights[kind] ?? 0;
  // Ignoring a left-field story is expected: it must barely count, or the section would shrink away.
  if (kind === 'ignored' && section === 'other') return base * s.otherNewsIgnoreFactor;
  return base;
}

async function emaUpdate(
  db: Db, table: 'tag_weight' | 'source_weight', key: 'tag' | 'source_id', modeId: number, k: string | number,
  w: number, alpha: number, reverse: boolean, now: number,
): Promise<void> {
  const row = await db.get<{ weight: number }>(`SELECT weight FROM ${table} WHERE mode_id = ? AND ${key} = ?`, [modeId, k]);
  const old = row?.weight ?? 0;
  // Taking a signal back runs the average backwards: the weight it had before that signal.
  const next = clamp(reverse ? (old - alpha * w) / (1 - alpha) : (1 - alpha) * old + alpha * w);
  await db.run(
    `INSERT INTO ${table}(mode_id, ${key}, weight, updated_at) VALUES(?,?,?,?)
     ON CONFLICT(mode_id, ${key}) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
    [modeId, k, next, now],
  );
}

/**
 * Applies one signal on a sections-layout article: every tag of its story and the story's primary
 * source move towards the signal's weight. "Less like this, because…" moves only the part named.
 * With `reverseOf`, takes the signal back (undo). The signal's weight and section are written on
 * its interaction row, which is the mode's signal log.
 */
export async function applySectionSignal(
  db: Db, articleId: number, kind: InteractionKind, now: number, reverseOf?: number,
): Promise<void> {
  const story = await storyOf(db, articleId);
  if (!story) return;
  const s = await loadSectionsSettings(db, story.modeId);
  const w = signalWeight(kind, story.section, s);
  if (!w) return;
  const reverse = reverseOf != null;
  const tags = kind === 'less_source' ? [] : story.tags;
  const source = kind === 'less_topic' ? null : story.sourceId;
  await db.tx(async () => {
    for (const t of tags) await emaUpdate(db, 'tag_weight', 'tag', story.modeId, t, w, s.emaAlpha, reverse, now);
    if (source != null) await emaUpdate(db, 'source_weight', 'source_id', story.modeId, source, w, s.emaAlpha, reverse, now);
    if (!reverse) {
      await db.run(
        `UPDATE interaction SET weight = ?, section = ?
         WHERE id = (SELECT MAX(id) FROM interaction WHERE article_id = ? AND kind = ?) AND weight IS NULL`,
        [w, story.section, articleId, kind],
      );
    }
  });
  if (!reverse && kind === 'open' && story.section === 'other') await graduate(db, story.modeId, s, now);
}

/**
 * Graduation from left field: three or more opened "In other news" stories sharing a tag within the
 * window raise that tag's weight by one step (once per window), and the next profile rewrite is
 * told about it. This is how a new interest moves into the main section.
 */
export async function graduate(db: Db, modeId: number, s: SectionsSettings, now: number): Promise<string[]> {
  const since = now - s.graduationDays * DAY;
  const rows = await db.all<{ article_id: number; tags: string | null }>(
    `SELECT DISTINCT x.article_id, c.tags FROM interaction x
     JOIN article a ON a.id = x.article_id AND a.mode_id = ?
     LEFT JOIN cluster c ON c.id = a.cluster_id
     WHERE x.kind = 'open' AND x.section = 'other' AND x.at > ?`,
    [modeId, since],
  );
  const counts = new Map<string, Set<number>>();
  for (const r of rows) {
    for (const t of new Set(safeJson<string[]>(r.tags, []).map(normTag))) {
      if (!t) continue;
      const set = counts.get(t) ?? new Set<number>();
      set.add(r.article_id);
      counts.set(t, set);
    }
  }
  const raised: string[] = [];
  const graduated = { ...s.graduated };
  for (const [tag, ids] of counts) {
    if (ids.size < s.graduationOpens) continue;
    if (graduated[tag] && graduated[tag] > since) continue;
    const row = await db.get<{ weight: number }>('SELECT weight FROM tag_weight WHERE mode_id = ? AND tag = ?', [modeId, tag]);
    await db.run(
      `INSERT INTO tag_weight(mode_id, tag, weight, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(mode_id, tag) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
      [modeId, tag, clamp((row?.weight ?? 0) + s.graduationStep), now],
    );
    graduated[tag] = now;
    raised.push(tag);
  }
  if (raised.length) await saveModeSettings(db, modeId, { graduated });
  return raised;
}

export interface Weights {
  tags: Map<string, number>;
  sources: Map<number, number>;
}

export async function loadWeights(db: Db, modeId: number): Promise<Weights> {
  const tags = await db.all<{ tag: string; weight: number }>('SELECT tag, weight FROM tag_weight WHERE mode_id = ?', [modeId]);
  const sources = await db.all<{ source_id: number; weight: number }>('SELECT source_id, weight FROM source_weight WHERE mode_id = ?', [modeId]);
  return { tags: new Map(tags.map((r) => [r.tag, r.weight])), sources: new Map(sources.map((r) => [r.source_id, r.weight])) };
}

/** The learned part of relevance: σ(mean tag weight + source weight), 0 to 1 (0.5 with nothing learned). */
export function learnedScore(tags: string[], sourceId: number | null, w: Weights): number {
  const ts = tags.map(normTag).filter(Boolean);
  const mean = ts.length ? ts.reduce((a, t) => a + (w.tags.get(t) ?? 0), 0) / ts.length : 0;
  return sigmoid(mean + (sourceId != null ? w.sources.get(sourceId) ?? 0 : 0));
}

/** relevance = 0.6 · profile match + 0.4 · σ(mean tag weight + source weight) (weights in settings). */
export function relevance(profileMatch: number, tags: string[], sourceId: number | null, w: Weights, s: SectionsSettings): number {
  return s.relevanceProfileWeight * profileMatch + s.relevanceLearnedWeight * learnedScore(tags, sourceId, w);
}

/** True during the first two weeks (by default) after learning starts or is reset. */
export function inColdStart(s: SectionsSettings, now: number): boolean {
  return now - (s.learningStartedAt || now) < s.coldStartDays * DAY;
}

export interface SignalRow {
  at: number;
  kind: InteractionKind;
  weight: number;
  section: string | null;
  headline: string;
}

/** The mode's signal log, newest first. */
export async function recentSignals(db: Db, modeId: number, limit = 50): Promise<SignalRow[]> {
  const rows = await db.all<any>(
    `SELECT x.at, x.kind, x.weight, x.section, COALESCE(c.headline, a.title) headline
     FROM interaction x JOIN article a ON a.id = x.article_id AND a.mode_id = ?
     LEFT JOIN cluster c ON c.id = a.cluster_id
     WHERE x.weight IS NOT NULL ORDER BY x.at DESC, x.id DESC LIMIT ?`,
    [modeId, limit],
  );
  return rows.map((r) => ({ at: r.at, kind: r.kind, weight: r.weight, section: r.section, headline: r.headline }));
}

export async function signalsSince(db: Db, modeId: number, since: number): Promise<number> {
  const r = await db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM interaction x JOIN article a ON a.id = x.article_id AND a.mode_id = ?
     WHERE x.weight IS NOT NULL AND x.at > ?`,
    [modeId, since],
  );
  return r?.n ?? 0;
}

/** Top and bottom tag weights, for the Learning screen. */
export async function tagWeightExtremes(db: Db, modeId: number, n = 10): Promise<{ top: [string, number][]; bottom: [string, number][] }> {
  const top = await db.all<{ tag: string; weight: number }>(
    'SELECT tag, weight FROM tag_weight WHERE mode_id = ? AND weight > 0 ORDER BY weight DESC LIMIT ?', [modeId, n]);
  const bottom = await db.all<{ tag: string; weight: number }>(
    'SELECT tag, weight FROM tag_weight WHERE mode_id = ? AND weight < 0 ORDER BY weight ASC LIMIT ?', [modeId, n]);
  return { top: top.map((r) => [r.tag, r.weight]), bottom: bottom.map((r) => [r.tag, r.weight]) };
}

/**
 * Reset learning for one sections-layout mode: its tag and source weights go, the cold start runs
 * again, graduation starts over, signals before now stop counting towards a rewrite, and the
 * starter profile comes back as the newest version (earlier versions can still be restored).
 * Item state (seen, saved, hidden, History) and every other mode are untouched.
 */
export async function resetModeLearning(db: Db, modeId: number, now: number): Promise<void> {
  await db.tx(async () => {
    await db.run('DELETE FROM tag_weight WHERE mode_id = ?', [modeId]);
    await db.run('DELETE FROM source_weight WHERE mode_id = ?', [modeId]);
  });
  const first = await db.get<{ markdown: string }>('SELECT markdown FROM profile WHERE mode_id = ? ORDER BY version ASC LIMIT 1', [modeId]);
  if (first && (await getProfile(db, modeId))) await addProfileVersion(db, modeId, first.markdown, [], 'starter', now);
  await saveModeSettings(db, modeId, { learningStartedAt: now, graduated: {}, lastProfileRewriteAt: now });
  // Stories waiting to be shown are scored again against the starter profile at the next refresh.
  await db.run('UPDATE cluster SET profile_version = NULL WHERE mode_id = ? AND enriched_at IS NOT NULL', [modeId]);
}
