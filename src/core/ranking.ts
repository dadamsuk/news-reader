import type { Db } from '../db/db';
import { placeholders } from '../db/db';
import type { Settings } from './settings';
import { DAY, HOUR, type InteractionKind } from './types';
import { blobToVec, cosine, decayFactor, safeJson, vecToBlob } from './util';

export const SIGNAL_WEIGHTS: Partial<Record<InteractionKind, number>> = {
  more: 3,
  read: 1,
  save: 1,
  bounce: -0.3,
  ignored: -0.2,
  dismiss: -1,
  less: -3,
};

export interface FeatureInput {
  sourceId: number;
  section: string | null;
  tags: string[];
  tone: string | null;
  byline: string | null;
  wordCount: number | null;
}

export interface FeatureGroup {
  label: string;
  keys: string[];
}

const norm = (s: string) => s.toLowerCase().trim();

export function wordBand(wc: number | null): string | null {
  if (wc == null || wc <= 0) return null;
  if (wc < 600) return 'short';
  if (wc <= 1500) return 'medium';
  return 'long';
}

const BAND_LABEL: Record<string, string> = { short: 'Short reads', medium: 'Medium-length pieces', long: 'Long reads' };

/**
 * Feature values of an article, grouped by kind. Affinity averages the groups, and a group with
 * several values (tags) is averaged first, so a piece with twelve keywords is not all keywords.
 */
export function featureGroups(a: FeatureInput, sourceName?: string): FeatureGroup[] {
  const groups: FeatureGroup[] = [{ label: `Source: ${sourceName ?? a.sourceId}`, keys: [`source:${a.sourceId}`] }];
  if (a.section) groups.push({ label: `Section: ${a.section}`, keys: [`section:${norm(a.section)}`] });
  const tags = Array.from(new Set(a.tags.map(norm).filter(Boolean))).slice(0, 12);
  if (tags.length) groups.push({ label: 'Topics', keys: tags.map((t) => `tag:${t}`) });
  if (a.tone) groups.push({ label: `Type: ${a.tone}`, keys: [`tone:${a.tone}`] });
  if (a.byline) groups.push({ label: `Writer: ${a.byline}`, keys: [`byline:${norm(a.byline)}`] });
  const band = wordBand(a.wordCount);
  if (band) groups.push({ label: BAND_LABEL[band], keys: [`words:${band}`] });
  return groups;
}

export function featureKeys(a: FeatureInput): string[] {
  return featureGroups(a).flatMap((g) => g.keys);
}

export interface Stat {
  pos: number;
  neg: number;
}

export type StatMap = Map<string, Stat>;

/** All feature stats, decayed to `now`. */
export async function loadStats(db: Db, now: number): Promise<StatMap> {
  const rows = await db.all<{ feature_key: string; positive_weight: number; negative_weight: number; updated_at: number }>(
    'SELECT * FROM feature_stat',
  );
  const m: StatMap = new Map();
  for (const r of rows) {
    const f = decayFactor(now - r.updated_at);
    m.set(r.feature_key, { pos: r.positive_weight * f, neg: r.negative_weight * f });
  }
  return m;
}

export const BASELINE_RATIO = Math.log(1 / 5);

export function logRatio(stat: Stat | undefined): number {
  return Math.log(((stat?.pos ?? 0) + 1) / ((stat?.neg ?? 0) + 5));
}

function groupValue(g: FeatureGroup, stats: StatMap): number {
  let s = 0;
  for (const k of g.keys) s += logRatio(stats.get(k));
  return s / g.keys.length;
}

/** A: mean log((positive + 1) / (negative + 5)) over the article's features. */
export function affinity(a: FeatureInput, stats: StatMap): number {
  const groups = featureGroups(a);
  if (!groups.length) return BASELINE_RATIO;
  let s = 0;
  for (const g of groups) s += groupValue(g, stats);
  return s / groups.length;
}

export interface Centroids {
  read: Float32Array | null;
  dismissed: Float32Array | null;
}

export async function loadCentroids(db: Db): Promise<Centroids> {
  const rows = await db.all<{ key: string; vector: Uint8Array; weight: number }>('SELECT key, vector, weight FROM centroid');
  const out: Centroids = { read: null, dismissed: null };
  for (const r of rows) {
    if (r.weight <= 0.01) continue;
    if (r.key === 'read') out.read = blobToVec(r.vector);
    if (r.key === 'dismissed') out.dismissed = blobToVec(r.vector);
  }
  return out;
}

/** S: similarity to what he reads, minus half the similarity to what he swipes away. */
export function interest(embedding: Float32Array | null, c: Centroids): number {
  if (!embedding) return 0;
  const r = c.read ? cosine(embedding, c.read) : 0;
  const d = c.dismissed ? cosine(embedding, c.dismissed) : 0;
  return r - 0.5 * d;
}

/** F: 0.5 ^ (age in hours / 8). */
export function freshness(publishedAt: number, now: number): number {
  return Math.pow(0.5, Math.max(0, now - publishedAt) / HOUR / 8);
}

/** I: log(1 + distinct outlets in the cluster). */
export function importance(outletCount: number): number {
  return Math.log(1 + Math.max(1, outletCount));
}

export function coldFactor(settings: Settings, now: number): number {
  const start = settings.learningStartedAt || now;
  return now - start < settings.coldStartDays * DAY ? settings.coldStartFactor : 1;
}

export function finalScore(
  parts: { a: number; s: number; i: number; publishedAt: number },
  settings: Settings,
  now: number,
): number {
  const cold = coldFactor(settings, now);
  return (
    settings.weightA * cold * parts.a +
    settings.weightS * cold * parts.s +
    settings.weightF * freshness(parts.publishedAt, now) +
    settings.weightI * parts.i
  );
}

async function bumpCentroid(db: Db, key: 'read' | 'dismissed', embedding: Float32Array, w: number, now: number): Promise<void> {
  const row = await db.get<{ vector: Uint8Array; weight: number; updated_at: number }>('SELECT * FROM centroid WHERE key = ?', [key]);
  const prev = row ? blobToVec(row.vector) : null;
  const vec = new Float32Array(embedding.length);
  let weight = w;
  if (prev && prev.length === embedding.length && row) {
    const f = decayFactor(now - row.updated_at);
    for (let i = 0; i < vec.length; i++) vec[i] = prev[i] * f + embedding[i] * w;
    weight = row.weight * f + w;
  } else {
    for (let i = 0; i < vec.length; i++) vec[i] = embedding[i] * w;
  }
  await db.run(
    `INSERT INTO centroid(key, vector, weight, updated_at) VALUES(?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET vector = excluded.vector, weight = excluded.weight, updated_at = excluded.updated_at`,
    [key, vecToBlob(vec), weight, now],
  );
}

/** Applies one learning signal for an article to the decayed feature stats and interest centroids. */
export async function applySignal(db: Db, articleId: number, kind: InteractionKind, now: number): Promise<void> {
  const w = SIGNAL_WEIGHTS[kind];
  if (!w) return;
  const row = await db.get<any>(
    'SELECT source_id, section, tags, tone, byline, word_count, embedding FROM article WHERE id = ?',
    [articleId],
  );
  if (!row) return;
  const keys = featureKeys({
    sourceId: row.source_id, section: row.section, tags: safeJson<string[]>(row.tags, []),
    tone: row.tone, byline: row.byline, wordCount: row.word_count,
  });
  await db.tx(async () => {
    const existing = keys.length
      ? await db.all<{ feature_key: string; positive_weight: number; negative_weight: number; updated_at: number }>(
          `SELECT * FROM feature_stat WHERE feature_key IN (${placeholders(keys.length)})`, keys)
      : [];
    const byKey = new Map(existing.map((r) => [r.feature_key, r]));
    for (const k of keys) {
      const r = byKey.get(k);
      const f = r ? decayFactor(now - r.updated_at) : 1;
      const pos = (r?.positive_weight ?? 0) * f + (w > 0 ? w : 0);
      const neg = (r?.negative_weight ?? 0) * f + (w < 0 ? -w : 0);
      await db.run(
        `INSERT INTO feature_stat(feature_key, positive_weight, negative_weight, updated_at) VALUES(?,?,?,?)
         ON CONFLICT(feature_key) DO UPDATE SET positive_weight = excluded.positive_weight,
           negative_weight = excluded.negative_weight, updated_at = excluded.updated_at`,
        [k, pos, neg, now],
      );
    }
    const emb = blobToVec(row.embedding);
    if (emb) {
      if (w > 0) await bumpCentroid(db, 'read', emb, w, now);
      else if (kind === 'dismiss' || kind === 'less') await bumpCentroid(db, 'dismissed', emb, -w, now);
    }
  });
}

/** Recomputes the stored A, S and I parts for articles that can still be shown. */
export async function scoreArticles(db: Db, now: number): Promise<number> {
  const stats = await loadStats(db, now);
  const cents = await loadCentroids(db);
  const rows = await db.all<any>(
    `SELECT a.id, a.source_id, a.section, a.tags, a.tone, a.byline, a.word_count, a.embedding,
            COALESCE(c.outlet_count, 1) outlets
     FROM article a JOIN source s ON s.id = a.source_id AND s.enabled = 1
     LEFT JOIN cluster c ON c.id = a.cluster_id
     LEFT JOIN impression i ON i.article_id = a.id
     WHERE i.article_id IS NULL AND a.published_at > ?
       AND (s.role = 'primary' OR (c.right_outlet_count >= 2 AND c.has_primary = 0))`,
    [now - 5 * DAY],
  );
  await db.tx(async () => {
    for (const r of rows) {
      const a = affinity({
        sourceId: r.source_id, section: r.section, tags: safeJson<string[]>(r.tags, []),
        tone: r.tone, byline: r.byline, wordCount: r.word_count,
      }, stats);
      const s = interest(blobToVec(r.embedding), cents);
      await db.run('UPDATE article SET score_a = ?, score_s = ?, score_i = ? WHERE id = ?', [a, s, importance(r.outlets), r.id]);
    }
  });
  return rows.length;
}

export interface WhyLine {
  text: string;
  value: number;
}

/** The three largest positive contributions to an article's score, in plain words. */
export async function whyThis(db: Db, articleId: number, settings: Settings, now: number): Promise<WhyLine[]> {
  const row = await db.get<any>(
    `SELECT a.*, s.name source_name, COALESCE(c.outlet_count, 1) outlets
     FROM article a JOIN source s ON s.id = a.source_id LEFT JOIN cluster c ON c.id = a.cluster_id WHERE a.id = ?`,
    [articleId],
  );
  if (!row) return [];
  const stats = await loadStats(db, now);
  const cents = await loadCentroids(db);
  const cold = coldFactor(settings, now);
  const input: FeatureInput = {
    sourceId: row.source_id, section: row.section, tags: safeJson<string[]>(row.tags, []),
    tone: row.tone, byline: row.byline, wordCount: row.word_count,
  };
  const groups = featureGroups(input, row.source_name);
  const lines: WhyLine[] = [];
  for (const g of groups) {
    // Measured against a feature he has no history with, so only real preferences show up.
    let value = (settings.weightA * cold * (groupValue(g, stats) - BASELINE_RATIO)) / groups.length;
    let label = g.label;
    if (g.label === 'Topics') {
      let best = g.keys[0];
      for (const k of g.keys) if (logRatio(stats.get(k)) > logRatio(stats.get(best))) best = k;
      label = `Topic: ${best.slice(4)}`;
    }
    if (value > 0.005) lines.push({ text: label, value });
  }
  const emb = blobToVec(row.embedding);
  const s = interest(emb, cents);
  if (emb && s > 0) {
    const reads = await db.all<{ embedding: Uint8Array }>(
      `SELECT a.embedding FROM article a WHERE a.embedding IS NOT NULL AND a.id != ? AND a.id IN
         (SELECT article_id FROM interaction WHERE kind IN ('read','save','more') AND at > ?)`,
      [articleId, now - 30 * DAY],
    );
    let similar = 0;
    for (const r of reads) {
      const v = blobToVec(r.embedding);
      if (v && cosine(emb, v) >= 0.45) similar++;
    }
    lines.push({
      text: similar > 0 ? `Similar to ${similar} ${similar === 1 ? 'story' : 'stories'} you read` : 'Close to what you usually read',
      value: settings.weightS * cold * s,
    });
  }
  const f = freshness(row.published_at, now);
  const hours = Math.max(0, Math.round((now - row.published_at) / HOUR));
  lines.push({ text: hours < 1 ? 'Published in the last hour' : `Published ${hours}h ago`, value: settings.weightF * f });
  if (row.outlets > 1) {
    lines.push({ text: `Covered by ${row.outlets} outlets`, value: settings.weightI * (importance(row.outlets) - importance(1)) });
  }
  // Equal contributions are common (one tap moves every feature of an article alike), so the more
  // specific reason wins: a section says more than the source the whole feed shares.
  const specificity = (t: string) =>
    t.startsWith('Section:') ? 0 : t.startsWith('Topic:') ? 1 : t.startsWith('Writer:') ? 2 : t.startsWith('Similar') ? 3
      : t.startsWith('Type:') ? 4 : t.startsWith('Source:') ? 6 : 5;
  return lines
    .sort((a, b) => (Math.abs(b.value - a.value) > 1e-6 ? b.value - a.value : specificity(a.text) - specificity(b.text)))
    .slice(0, 3);
}

export async function resetLearning(db: Db, now: number): Promise<void> {
  await db.tx(async () => {
    await db.run('DELETE FROM feature_stat');
    await db.run('DELETE FROM centroid');
    await db.run('UPDATE article SET score_a = ?, score_s = 0', [BASELINE_RATIO]);
    await db.run(
      "INSERT INTO setting(key, value) VALUES('learningStartedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [JSON.stringify(now)],
    );
  });
}
