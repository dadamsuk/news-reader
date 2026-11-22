import type { Db } from '../db/db';
import { placeholders } from '../db/db';
import { ARTICLE_COLS, rowToArticle } from './feed';
import { LEAN_ORDER } from './sources';
import type { Article, Lean } from './types';

export interface CoverageRow {
  article: Article;
  sourceName: string;
  paywalled: boolean;
  /** The article the view was opened from. */
  isThis: boolean;
}

export interface CoverageNote {
  agree: string;
  differ: string;
  /** Outlets in the story when the note was written; more since then means it can be redone. */
  outlets: number;
  at: number;
}

export interface Coverage {
  articleId: number;
  title: string;
  /** Where a comparison is cached: the story's cluster, or the article when it has none. */
  key: string;
  rows: CoverageRow[];
  outletCount: number;
  note: CoverageNote | null;
}

/**
 * Every outlet's piece on the story an article reports: the other articles in its cluster, plus
 * any article the model confirmed as the same event (a second source can sit just outside the
 * cluster). Ordered along the source leans set in Settings, then newest first, so the spread of
 * coverage reads from one end to the other. Leans order the list; they are not shown.
 */
export async function loadCoverage(db: Db, articleId: number): Promise<Coverage | null> {
  const base = await db.get<{ id: number; title: string; cluster_id: number | null }>(
    'SELECT id, title, cluster_id FROM article WHERE id = ?', [articleId],
  );
  if (!base) return null;
  const ids = new Set<number>([articleId]);
  if (base.cluster_id != null) {
    const members = await db.all<{ id: number }>('SELECT id FROM article WHERE cluster_id = ?', [base.cluster_id]);
    for (const m of members) ids.add(m.id);
  }
  // Confirmed same-event partners of any article found so far, in either direction.
  const seed = Array.from(ids).slice(0, 400);
  const marks = placeholders(seed.length);
  const partners = await db.all<{ a: number; b: number }>(
    `SELECT primary_article_id a, other_article_id b FROM match_pair
       WHERE same_event = 1 AND (primary_article_id IN (${marks}) OR other_article_id IN (${marks}))
     UNION
     SELECT primary_article_id a, other_article_id b FROM second_source
       WHERE other_article_id IS NOT NULL AND (primary_article_id IN (${marks}) OR other_article_id IN (${marks}))`,
    [...seed, ...seed, ...seed, ...seed],
  );
  for (const p of partners) {
    ids.add(p.a);
    ids.add(p.b);
  }
  const all = Array.from(ids).slice(0, 400);
  const rows = await db.all<any>(
    `SELECT ${ARTICLE_COLS}, s.name source_name, s.lean, s.paywalled
     FROM article a JOIN source s ON s.id = a.source_id AND s.enabled = 1
     WHERE a.id IN (${placeholders(all.length)})`,
    all,
  );
  rows.sort((x, y) =>
    LEAN_ORDER[x.lean as Lean] - LEAN_ORDER[y.lean as Lean] ||
    String(x.source_name).localeCompare(String(y.source_name)) ||
    y.published_at - x.published_at);
  const key = base.cluster_id != null ? `c${base.cluster_id}` : `a${articleId}`;
  const note = await db.get<any>('SELECT agree, differ, outlets, at FROM coverage_note WHERE key = ?', [key]);
  return {
    articleId,
    title: base.title,
    key,
    rows: rows.map((r) => ({
      article: rowToArticle(r), sourceName: r.source_name, paywalled: !!r.paywalled, isThis: r.id === articleId,
    })),
    outletCount: new Set(rows.map((r) => r.source_id)).size,
    note: note ? { agree: note.agree, differ: note.differ, outlets: note.outlets, at: note.at } : null,
  };
}

export async function saveCoverageNote(db: Db, key: string, agree: string, differ: string, outlets: number, now: number): Promise<void> {
  await db.run(
    `INSERT INTO coverage_note(key, agree, differ, outlets, at) VALUES(?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET agree = excluded.agree, differ = excluded.differ, outlets = excluded.outlets, at = excluded.at`,
    [key, agree, differ, outlets, now],
  );
}
