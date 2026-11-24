import type { Db } from '../db/db';
import { BAND_LABEL, BASELINE_RATIO, loadStats, logRatio, scoreArticles } from './ranking';
import { LEAN_ORDER } from './sources';
import { DAY, NEWS_MODE_ID, type Lean } from './types';
import { decayFactor } from './util';

export type LearnedKind = 'section' | 'tag' | 'byline' | 'source' | 'tone' | 'words';

export interface LearnedItem {
  key: string;
  label: string;
  /** Decayed positive and negative weight behind it. */
  pos: number;
  neg: number;
  /** How far it moves an article's affinity, against a feature with no history. Above 0: liked. */
  effect: number;
}

export interface LearnedGroup {
  kind: LearnedKind;
  title: string;
  liked: LearnedItem[];
  disliked: LearnedItem[];
}

const GROUPS: { kind: LearnedKind; prefix: string; title: string }[] = [
  { kind: 'section', prefix: 'section:', title: 'Sections' },
  { kind: 'tag', prefix: 'tag:', title: 'Topics' },
  { kind: 'byline', prefix: 'byline:', title: 'Writers' },
  { kind: 'source', prefix: 'source:', title: 'Sources' },
  { kind: 'tone', prefix: 'tone:', title: 'Types of piece' },
  { kind: 'words', prefix: 'words:', title: 'Length' },
];

/** Below this a preference is noise (one card scrolled past moves a feature by about 0.04). */
export const LEARNED_MIN_EFFECT = 0.08;
export const LEARNED_PER_SIDE = 25;
/** What More and Less on the screen add: the same as "More like this" on a card. */
export const NUDGE_WEIGHT = 3;

const titleCase = (s: string) => s.replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

/** Everything the ranking has learned, in plain words, strongest first on each side. */
export async function loadLearned(db: Db, now: number): Promise<LearnedGroup[]> {
  const stats = await loadStats(db, now);
  const sources = new Map(
    (await db.all<{ id: number; name: string }>('SELECT id, name FROM source')).map((s) => [String(s.id), s.name]),
  );
  const out: LearnedGroup[] = [];
  for (const g of GROUPS) {
    const items: LearnedItem[] = [];
    for (const [key, stat] of stats) {
      if (!key.startsWith(g.prefix)) continue;
      const value = key.slice(g.prefix.length);
      const effect = logRatio(stat) - BASELINE_RATIO;
      if (Math.abs(effect) < LEARNED_MIN_EFFECT) continue;
      let label = titleCase(value);
      if (g.kind === 'source') {
        const name = sources.get(value);
        if (!name) continue; // a deleted source
        label = name;
      } else if (g.kind === 'words') label = BAND_LABEL[value] ?? label;
      items.push({ key, label, pos: stat.pos, neg: stat.neg, effect });
    }
    const liked = items.filter((i) => i.effect > 0).sort((a, b) => b.effect - a.effect).slice(0, LEARNED_PER_SIDE);
    const disliked = items.filter((i) => i.effect < 0).sort((a, b) => a.effect - b.effect).slice(0, LEARNED_PER_SIDE);
    if (liked.length || disliked.length) out.push({ kind: g.kind, title: g.title, liked, disliked });
  }
  return out;
}

/** Forgets one learned preference and re-ranks what is waiting in the feed. */
export async function forgetFeature(db: Db, key: string, now: number): Promise<void> {
  await db.run('DELETE FROM feature_stat WHERE feature_key = ?', [key]);
  await scoreArticles(db, now);
}

/** Pushes one preference up or down by the weight of a "More like this" or "Less like this". */
export async function nudgeFeature(db: Db, key: string, direction: 1 | -1, now: number): Promise<void> {
  const r = await db.get<{ positive_weight: number; negative_weight: number; updated_at: number }>(
    'SELECT positive_weight, negative_weight, updated_at FROM feature_stat WHERE feature_key = ?', [key],
  );
  const f = r ? decayFactor(now - r.updated_at) : 1;
  const pos = (r?.positive_weight ?? 0) * f + (direction > 0 ? NUDGE_WEIGHT : 0);
  const neg = (r?.negative_weight ?? 0) * f + (direction < 0 ? NUDGE_WEIGHT : 0);
  await db.run(
    `INSERT INTO feature_stat(feature_key, positive_weight, negative_weight, updated_at) VALUES(?,?,?,?)
     ON CONFLICT(feature_key) DO UPDATE SET positive_weight = excluded.positive_weight,
       negative_weight = excluded.negative_weight, updated_at = excluded.updated_at`,
    [key, pos, neg, now],
  );
  await scoreArticles(db, now);
}

export interface DietLine {
  label: string;
  /** Articles read in the last seven days, and in the seven before. */
  thisWeek: number;
  lastWeek: number;
}

export interface ReadingDiet {
  thisWeek: number;
  lastWeek: number;
  sections: DietLine[];
  sources: DietLine[];
  /** By the lean you gave each source in Settings, left to right. */
  leans: DietLine[];
}

/** What was actually read (not just opened) over the last two weeks, each article counted once. */
export async function readingDiet(db: Db, now: number): Promise<ReadingDiet> {
  const rows = await db.all<{ section: string | null; name: string; lean: Lean; at: number }>(
    `SELECT a.section, s.name, s.lean, MIN(x.at) at
     FROM interaction x JOIN article a ON a.id = x.article_id JOIN source s ON s.id = a.source_id
     WHERE a.mode_id = ? AND x.kind = 'read' AND x.at > ? GROUP BY x.article_id`,
    [NEWS_MODE_ID, now - 14 * DAY],
  );
  const tally = (label: (r: (typeof rows)[number]) => string): DietLine[] => {
    const m = new Map<string, DietLine>();
    for (const r of rows) {
      const l = label(r);
      const line = m.get(l) ?? { label: l, thisWeek: 0, lastWeek: 0 };
      if (r.at > now - 7 * DAY) line.thisWeek++;
      else line.lastWeek++;
      m.set(l, line);
    }
    return Array.from(m.values());
  };
  const byCount = (a: DietLine, b: DietLine) => b.thisWeek - a.thisWeek || b.lastWeek - a.lastWeek || a.label.localeCompare(b.label);
  const thisWeek = rows.filter((r) => r.at > now - 7 * DAY).length;
  return {
    thisWeek,
    lastWeek: rows.length - thisWeek,
    sections: tally((r) => r.section || 'No section').sort(byCount).slice(0, 8),
    sources: tally((r) => r.name).sort(byCount).slice(0, 8),
    leans: tally((r) => r.lean).sort((a, b) => LEAN_ORDER[a.label as Lean] - LEAN_ORDER[b.label as Lean]),
  };
}
