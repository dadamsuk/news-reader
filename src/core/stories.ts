import type { Db } from '../db/db';
import { ARTICLE_COLS, rowToArticle, type ListRow } from './feed';
import { HOUR, NEWS_MODE_ID, type StoryView } from './types';
import { blobToVec, dot, normalize } from './util';

/** New articles are matched to followed stories while they are this recent (the embedding window). */
export const STORY_SCAN_MS = 84 * HOUR;

export class StoryError extends Error {}

/**
 * Attaches recent articles to followed stories. An article joins a story when it is close enough
 * to the story's starting point (the follow threshold, looser than "same event", because a running
 * story moves on), or when it reports the same event as an article already in the story (it shares
 * that article's cluster). The starting point never moves, so a story cannot drift into its topic.
 */
export async function attachToStories(db: Db, followThreshold: number, now: number, onlyStoryId?: number): Promise<number> {
  const stories = await db.all<{ id: number; centroid: Uint8Array }>(
    onlyStoryId == null ? 'SELECT id, centroid FROM story' : 'SELECT id, centroid FROM story WHERE id = ?',
    onlyStoryId == null ? [] : [onlyStoryId],
  );
  if (!stories.length) return 0;
  const arts = await db.all<{ id: number; embedding: Uint8Array; cluster_id: number | null }>(
    `SELECT a.id, a.embedding, a.cluster_id FROM article a JOIN source s ON s.id = a.source_id AND s.enabled = 1
     WHERE a.mode_id = ? AND a.embedding IS NOT NULL AND a.published_at > ?`,
    [NEWS_MODE_ID, now - STORY_SCAN_MS],
  );
  const vecs = arts.map((a) => blobToVec(a.embedding));
  let added = 0;
  for (const st of stories) {
    const c = blobToVec(st.centroid);
    if (!c) continue;
    const unit = normalize(c);
    const have = await db.all<{ article_id: number; cluster_id: number | null }>(
      'SELECT sa.article_id, a.cluster_id FROM story_article sa LEFT JOIN article a ON a.id = sa.article_id WHERE sa.story_id = ?',
      [st.id],
    );
    const attached = new Set(have.map((h) => h.article_id));
    const clusters = new Set(have.map((h) => h.cluster_id).filter((x): x is number => x != null));
    const join: number[] = [];
    // First by closeness to the starting point, then anything sharing a cluster with the story.
    for (let i = 0; i < arts.length; i++) {
      const v = vecs[i];
      if (attached.has(arts[i].id) || !v || v.length !== unit.length) continue;
      if (dot(unit, v) >= followThreshold) {
        join.push(arts[i].id);
        attached.add(arts[i].id);
        if (arts[i].cluster_id != null) clusters.add(arts[i].cluster_id!);
      }
    }
    for (const a of arts) {
      if (attached.has(a.id) || a.cluster_id == null || !clusters.has(a.cluster_id)) continue;
      join.push(a.id);
      attached.add(a.id);
    }
    if (!join.length) continue;
    await db.tx(async () => {
      for (const id of join) {
        await db.run('INSERT OR IGNORE INTO story_article(story_id, article_id, added_at) VALUES(?,?,?)', [st.id, id, now]);
      }
    });
    added += join.length;
  }
  return added;
}

/** The story an article belongs to, if it is being followed. */
export async function storyOfArticle(db: Db, articleId: number): Promise<number | null> {
  const r = await db.get<{ story_id: number }>('SELECT story_id FROM story_article WHERE article_id = ? ORDER BY story_id LIMIT 1', [articleId]);
  return r?.story_id ?? null;
}

/**
 * Starts following the story an article reports. What is already published joins as background;
 * only what arrives afterwards counts as new. Returns the story id (the existing one if the
 * article is already part of a followed story).
 */
export async function followStory(db: Db, articleId: number, followThreshold: number, now: number): Promise<number> {
  const existing = await storyOfArticle(db, articleId);
  if (existing != null) return existing;
  const a = await db.get<{ id: number; title: string; embedding: Uint8Array | null; cluster_id: number | null }>(
    'SELECT id, title, embedding, cluster_id FROM article WHERE id = ?', [articleId],
  );
  if (!a) throw new StoryError('That article is no longer stored');
  const cluster = a.cluster_id != null
    ? await db.get<{ centroid: Uint8Array | null }>('SELECT centroid FROM cluster WHERE id = ?', [a.cluster_id])
    : null;
  const centroid = cluster?.centroid ?? a.embedding;
  if (!centroid || !blobToVec(centroid)) throw new StoryError('This story cannot be followed until the next refresh has processed it');
  const r = await db.run(
    'INSERT INTO story(title, centroid, followed_at, last_checked_at) VALUES(?,?,?,?)',
    [a.title, centroid, now, now],
  );
  const storyId = r.lastInsertRowId;
  await db.run('INSERT OR IGNORE INTO story_article(story_id, article_id, added_at) VALUES(?,?,?)', [storyId, articleId, now]);
  await attachToStories(db, followThreshold, now, storyId);
  return storyId;
}

export async function unfollowStory(db: Db, storyId: number): Promise<void> {
  await db.tx(async () => {
    await db.run('DELETE FROM story_article WHERE story_id = ?', [storyId]);
    await db.run('DELETE FROM story WHERE id = ?', [storyId]);
  });
}

/** Opening a story: everything in it now counts as read, and the update note is cleared. */
export async function markStoryChecked(db: Db, storyId: number, now: number): Promise<void> {
  await db.run('UPDATE story SET last_checked_at = ?, update_summary = NULL, update_n = 0, update_at = NULL WHERE id = ?', [now, storyId]);
}

/** Followed stories: those with new coverage first (most recent first), then the quiet ones. */
export async function loadStories(db: Db): Promise<StoryView[]> {
  const stories = await db.all<any>('SELECT * FROM story ORDER BY followed_at DESC');
  const out: StoryView[] = [];
  for (const st of stories) {
    const rows = await db.all<any>(
      `SELECT a.title, a.image_url, a.published_at, a.source_id, sa.added_at
       FROM story_article sa JOIN article a ON a.id = sa.article_id
       JOIN source s ON s.id = a.source_id AND s.enabled = 1
       WHERE sa.story_id = ? ORDER BY a.published_at DESC`,
      [st.id],
    );
    const fresh = rows.filter((r) => r.added_at > st.last_checked_at);
    out.push({
      id: st.id,
      title: st.title,
      followedAt: st.followed_at,
      articleCount: rows.length,
      newCount: fresh.length,
      newOutlets: new Set(fresh.map((r) => r.source_id)).size,
      latestAt: rows.length ? rows[0].published_at : null,
      updateSummary: fresh.length ? (st.update_summary ?? null) : null,
      latestTitle: fresh.length ? fresh[0].title : null,
      imageUrl: (fresh.find((r) => r.image_url) ?? rows.find((r) => r.image_url))?.image_url ?? null,
    });
  }
  return out.sort((a, b) =>
    Number(b.newCount > 0) - Number(a.newCount > 0) || (b.latestAt ?? 0) - (a.latestAt ?? 0) || b.id - a.id);
}

export interface StoryDetail {
  id: number;
  title: string;
  followedAt: number;
  updateSummary: string | null;
  /** Joined since the story was last opened, newest first. */
  fresh: ListRow[];
  earlier: ListRow[];
}

export async function loadStory(db: Db, storyId: number): Promise<StoryDetail | null> {
  const st = await db.get<any>('SELECT * FROM story WHERE id = ?', [storyId]);
  if (!st) return null;
  const rows = await db.all<any>(
    `SELECT ${ARTICLE_COLS}, s.name source_name, sa.added_at
     FROM story_article sa JOIN article a ON a.id = sa.article_id
     JOIN source s ON s.id = a.source_id AND s.enabled = 1
     WHERE sa.story_id = ? ORDER BY a.published_at DESC, a.id DESC`,
    [storyId],
  );
  const toRow = (r: any): ListRow => ({ article: rowToArticle(r), sourceName: r.source_name ?? '', at: r.published_at, offline: !!r.has_body });
  const fresh = rows.filter((r) => r.added_at > st.last_checked_at);
  return {
    id: st.id,
    title: st.title,
    followedAt: st.followed_at,
    updateSummary: fresh.length ? (st.update_summary ?? null) : null,
    fresh: fresh.map(toRow),
    earlier: rows.filter((r) => r.added_at <= st.last_checked_at).map(toRow),
  };
}
