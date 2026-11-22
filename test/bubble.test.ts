import {
  BUBBLE_MIN_DROP, dismiss, ensureSession, loadBubble, loadFeed, recordImpressions,
} from '../src/core/feed';
import { lowerReasons } from '../src/core/ranking';
import { loadSettings } from '../src/core/settings';
import { setup } from './helpers/world';

/** Gives an article its own cluster with this many outlets, and stored scores. */
async function shape(db: any, title: string, outlets: number, scoreA: number) {
  const a = await db.get('SELECT id, published_at FROM article WHERE title = ?', [title]);
  const r = await db.run(
    'INSERT INTO cluster(created_at, last_article_at, size, outlet_count) VALUES(?,?,?,?)',
    [a.published_at, a.published_at, outlets, outlets],
  );
  await db.run('UPDATE article SET cluster_id = ?, score_a = ?, score_s = 0, score_i = ? WHERE id = ?',
    [r.lastInsertRowId, scoreA, Math.log(1 + outlets), a.id]);
  return a.id as number;
}

describe('outside your bubble', () => {
  async function makeWorld() {
    const { db, world, run } = await setup([]);
    const stories = [
      { title: 'Big rugby story', topic: 1, hoursAgo: 1, section: 'Sport' },
      { title: 'Big liked story', topic: 2, hoursAgo: 1.2 },
      { title: 'Big dismissed story', topic: 3, hoursAgo: 1.4, section: 'Sport' },
      { title: 'Small disliked story', topic: 4, hoursAgo: 1.6, section: 'Sport' },
    ];
    // Ordinary filler, enough that a story can drop more than BUBBLE_MIN_DROP places.
    for (let i = 0; i < BUBBLE_MIN_DROP + 15; i++) stories.push({ title: `Filler ${i}`, topic: 10 + i, hoursAgo: 2 + i * 0.5, section: 'News' });
    world.addGuardian(stories);
    await run();
    await db.run('UPDATE article SET score_a = 0, score_s = 0, score_i = ?', [Math.log(2)]);
    const ids = {
      rugby: await shape(db, 'Big rugby story', 5, -6),
      liked: await shape(db, 'Big liked story', 5, 0),
      dismissed: await shape(db, 'Big dismissed story', 5, -6),
      small: await shape(db, 'Small disliked story', 1, -6),
    };
    const s = await ensureSession(db, world.now);
    await dismiss(db, ids.dismissed, s.sessionId, world.now);
    return { db, world, ids };
  }

  test('lists widely covered stories that preferences pushed far down, and nothing else', async () => {
    const { db, world, ids } = await makeWorld();
    const s = await ensureSession(db, world.now);
    const items = await loadBubble(db, await loadSettings(db), s.sessionId, world.now);
    expect(items.map((i) => i.card.article.title)).toEqual(['Big rugby story']);
    const [rugby] = items;
    expect(rugby.outletCount).toBe(5);
    expect(rugby.neutralRank).toBeLessThan(3);
    expect(rugby.personalRank - rugby.neutralRank).toBeGreaterThanOrEqual(BUBBLE_MIN_DROP);
  });

  test('seen here: stays in this tab for the session, never becomes a For you card, then is gone', async () => {
    const { db, world, ids } = await makeWorld();
    const settings = await loadSettings(db);
    const s1 = await ensureSession(db, world.now);
    await recordImpressions(db, [{ articleId: ids.rugby, surface: 'bubble' }], s1.sessionId, world.now);

    expect((await loadBubble(db, settings, s1.sessionId, world.now)).map((i) => i.card.article.id)).toEqual([ids.rugby]);
    const feed = await loadFeed(db, settings, s1.sessionId, world.now);
    expect(feed.map((c) => c.article.id)).not.toContain(ids.rugby);

    const s2 = await ensureSession(db, world.now + 1000, true);
    expect(await loadBubble(db, settings, s2.sessionId, world.now + 1000)).toEqual([]);
  });

  test('a story already seen in For you is not offered here', async () => {
    const { db, world, ids } = await makeWorld();
    const s = await ensureSession(db, world.now);
    await recordImpressions(db, [{ articleId: ids.rugby, surface: 'feed' }], s.sessionId, world.now);
    expect(await loadBubble(db, await loadSettings(db), s.sessionId, world.now)).toEqual([]);
  });

  test('reasons name the disliked labels, most first', () => {
    const settings = { weightA: 1, weightS: 1.5, learningStartedAt: 1, coldStartDays: 14, coldStartFactor: 0.3 } as any;
    const stats = new Map([
      ['section:sport', { pos: 0, neg: 2 }],
      ['tag:rugby union', { pos: 0, neg: 60 }],
      ['tag:six nations', { pos: 2, neg: 0 }],
    ]);
    const reasons = lowerReasons(
      { sourceId: 1, section: 'Sport', tags: ['Rugby union', 'Six Nations'], tone: null, byline: null, wordCount: null },
      'Guardian', stats, 0, settings, Date.now(),
    );
    expect(reasons).toEqual(['Rugby union', 'Sport']);
  });
});
