import {
  SESSION_GAP_MS, classifyReading, dismiss, ensureSession, highWaterMark, loadDigest, loadFeed, loadHistory,
  loadReadLater, noteBackground, recordImpressions, recordOpen, recordReading, saveForLater, undoDismiss, unsave,
} from '../src/core/feed';
import { loadSettings } from '../src/core/settings';
import { HOUR, SRC, feedUrl, setup } from './helpers/world';

async function feedTitles(db: any, now: number, sessionId: string) {
  return (await loadFeed(db, await loadSettings(db), sessionId, now)).map((c) => c.article.title);
}

describe('seen rule', () => {
  test('viewability high-water mark: everything scrolled past counts as seen', () => {
    expect(highWaterMark(-1, [0, 1])).toBe(1);
    // A fast fling reports only the cards where it stopped.
    expect(highWaterMark(1, [7, 8])).toBe(8);
    // Scrolling back up never lowers it.
    expect(highWaterMark(8, [2, 3])).toBe(8);
    expect(highWaterMark(3, [])).toBe(3);
  });

  test('seen cards stay for the session, then never return after 10 minutes in the background', async () => {
    const { db, world, run } = await setup([]);
    world.addGuardian([
      { title: 'Story A', topic: 1, hoursAgo: 1 }, { title: 'Story B', topic: 2, hoursAgo: 2 },
      { title: 'Story C', topic: 3, hoursAgo: 3 }, { title: 'Story D', topic: 4, hoursAgo: 4 },
    ]);
    await run();
    const s1 = await ensureSession(db, world.now);
    expect(s1.isNew).toBe(true);
    const feed = await loadFeed(db, await loadSettings(db), s1.sessionId, world.now);
    expect(feed.map((c) => c.article.title)).toEqual(['Story A', 'Story B', 'Story C', 'Story D']);

    // A and B are at least half on screen. The write is immediate and never overwritten.
    await recordImpressions(db, feed.slice(0, 2).map((c) => ({ articleId: c.article.id, surface: 'feed' as const })), s1.sessionId, world.now);
    await recordImpressions(db, [{ articleId: feed[0].article.id, surface: 'feed' }], s1.sessionId, world.now + 5000);
    const imp = await db.get<{ first_seen_at: number }>('SELECT first_seen_at FROM impression WHERE article_id = ?', [feed[0].article.id]);
    expect(imp!.first_seen_at).toBe(world.now);

    // Same session: scrolling back up still shows them, in place.
    expect(await feedTitles(db, world.now + 60_000, s1.sessionId)).toEqual(['Story A', 'Story B', 'Story C', 'Story D']);

    // 9 minutes in the background: same session.
    await noteBackground(db, world.now);
    const s2 = await ensureSession(db, world.now + 9 * 60_000);
    expect(s2).toEqual({ sessionId: s1.sessionId, isNew: false });

    // 10 minutes in the background: a new session with only unseen articles.
    await noteBackground(db, world.now + 20 * 60_000);
    const s3 = await ensureSession(db, world.now + 20 * 60_000 + SESSION_GAP_MS);
    expect(s3.isNew).toBe(true);
    expect(await feedTitles(db, world.now + 31 * 60_000, s3.sessionId)).toEqual(['Story C', 'Story D']);
  });

  test('pull-to-refresh ends the session', async () => {
    const { db, world, run } = await setup([]);
    world.addGuardian([{ title: 'Story A', topic: 1, hoursAgo: 1 }, { title: 'Story B', topic: 2, hoursAgo: 2 }]);
    await run();
    const s1 = await ensureSession(db, world.now);
    const feed = await loadFeed(db, await loadSettings(db), s1.sessionId, world.now);
    await recordImpressions(db, [{ articleId: feed[0].article.id, surface: 'feed' }], s1.sessionId, world.now);
    const s2 = await ensureSession(db, world.now + 1000, true);
    expect(s2.isNew).toBe(true);
    expect(await feedTitles(db, world.now + 1000, s2.sessionId)).toEqual(['Story B']);
  });

  test('an article seen as a second-source strip or in Right press never appears as a feed card', async () => {
    const { db, world, ids, run } = await setup([SRC.rss('BBC News', 'centre'), SRC.rss('Daily Mail', 'right'), SRC.rss('Daily Express', 'right')]);
    world.addGuardian([{ title: 'Guardian: budget row', topic: 1, hoursAgo: 1 }]);
    world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget row', topic: 1, hoursAgo: 2 }, { title: 'BBC: unrelated', topic: 9, hoursAgo: 3 }]);
    world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: bins scandal', topic: 5, hoursAgo: 2 }]);
    world.addFeed(feedUrl('Daily Express'), [{ title: 'Express: bins scandal', topic: 5, hoursAgo: 2 }]);
    await run();
    const s1 = await ensureSession(db, world.now);
    const settings = await loadSettings(db);
    const feed = await loadFeed(db, settings, s1.sessionId, world.now);
    expect(feed).toHaveLength(1);
    expect(feed[0].second).toMatchObject({ sourceName: 'BBC News' });
    const digest = await loadDigest(db, settings, s1.sessionId, world.now);
    expect(digest).toHaveLength(1);

    // The card (with its strip) and the digest item are seen.
    await recordImpressions(db, [
      { articleId: feed[0].article.id, surface: 'feed' },
      { articleId: feed[0].second!.articleId, surface: 'second_source' },
      ...digest[0].outlets.map((o) => ({ articleId: o.articleId, surface: 'digest' as const })),
    ], s1.sessionId, world.now);

    // Later, BBC and the Mail become primary sources. Their seen articles must not turn up as cards.
    for (const name of ['BBC News', 'Daily Mail']) {
      await db.run("UPDATE source SET role = 'primary' WHERE id = ?", [ids[name]]);
    }
    world.now += HOUR;
    await run();
    const s2 = await ensureSession(db, world.now, true);
    const titles = await feedTitles(db, world.now, s2.sessionId);
    expect(titles).toEqual(['BBC: unrelated']);
    // And the digest item is gone for good.
    expect(await loadDigest(db, await loadSettings(db), s2.sessionId, world.now)).toHaveLength(0);
  });

  test('once a cluster is seen, perspective articles in it are suppressed for 72 hours; new primary pieces still appear', async () => {
    const { db, world, run } = await setup([SRC.rss('BBC News', 'centre'), SRC.rss('Daily Mail', 'right')]);
    world.addGuardian([{ title: 'Guardian: minister resigns', topic: 1, hoursAgo: 1 }]);
    world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: minister resigns', topic: 1, hoursAgo: 1 }]);
    await run();
    const s1 = await ensureSession(db, world.now);
    const settings = await loadSettings(db);
    const feed1 = await loadFeed(db, settings, s1.sessionId, world.now);
    expect(feed1[0].second).toMatchObject({ sourceName: 'BBC News' });
    // Only the primary card is recorded here: the cluster rule alone must hide later strips.
    await recordImpressions(db, [{ articleId: feed1[0].article.id, surface: 'feed' }], s1.sessionId, world.now);

    // Two hours on: the Guardian publishes an analysis piece on the same story, and the Mail catches up.
    world.now += 2 * HOUR;
    world.addGuardian([{ title: 'Guardian analysis: what the resignation means', topic: 1, hoursAgo: 0.1, tone: 'analysis' }]);
    world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: minister resigns in disgrace', topic: 1, hoursAgo: 0.2 }]);
    await run();
    const s2 = await ensureSession(db, world.now, true);
    const feed2 = await loadFeed(db, await loadSettings(db), s2.sessionId, world.now);
    // The new primary piece is a different article, so it appears...
    expect(feed2.map((c) => c.article.title)).toEqual(['Guardian analysis: what the resignation means']);
    // ...and it was matched to another outlet in the pipeline...
    const ss = await db.get<any>('SELECT other_article_id FROM second_source WHERE primary_article_id = ?', [feed2[0].article.id]);
    expect(ss.other_article_id).not.toBeNull();
    // ...but other outlets' articles on the already-seen story are suppressed.
    expect(feed2[0].second).toBeNull();

    // After 72 hours the suppression lapses.
    const later = world.now + 73 * HOUR;
    const s3 = await ensureSession(db, later, true);
    const feed3 = await loadFeed(db, await loadSettings(db), s3.sessionId, later);
    expect(feed3[0].second).not.toBeNull();
  });

  test('History lists everything seen and finds it by headline; opening from History does not return it to the feed', async () => {
    const { db, world, run } = await setup([]);
    world.addGuardian([
      { title: 'Budget: chancellor raises taxes', topic: 1, hoursAgo: 1 }, { title: 'Storm hits the coast', topic: 2, hoursAgo: 2 },
      { title: 'Unseen story', topic: 3, hoursAgo: 3 },
    ]);
    await run();
    const s1 = await ensureSession(db, world.now);
    const feed = await loadFeed(db, await loadSettings(db), s1.sessionId, world.now);
    await recordImpressions(db, feed.slice(0, 2).map((c) => ({ articleId: c.article.id, surface: 'feed' as const })), s1.sessionId, world.now);
    expect((await loadHistory(db, world.now)).map((r) => r.article.title).sort()).toEqual(['Budget: chancellor raises taxes', 'Storm hits the coast']);
    expect((await loadHistory(db, world.now, 'storm')).map((r) => r.article.title)).toEqual(['Storm hits the coast']);
    expect(await loadHistory(db, world.now, '100%_nothing')).toEqual([]);

    const s2 = await ensureSession(db, world.now + HOUR, true);
    await recordOpen(db, feed[1].article.id, s2.sessionId, 'feed', world.now + HOUR);
    expect(await feedTitles(db, world.now + HOUR, s2.sessionId)).toEqual(['Unseen story']);
    // Seen more than 14 days ago: out of History.
    expect(await loadHistory(db, world.now + 15 * 24 * HOUR)).toEqual([]);
  });
});

describe('actions', () => {
  test('swipe left removes the card; undo brings it back', async () => {
    const { db, world, run } = await setup([]);
    world.addGuardian([{ title: 'Story A', topic: 1, hoursAgo: 1 }, { title: 'Story B', topic: 2, hoursAgo: 2 }]);
    await run();
    const s1 = await ensureSession(db, world.now);
    const feed = await loadFeed(db, await loadSettings(db), s1.sessionId, world.now);
    await dismiss(db, feed[0].article.id, s1.sessionId, world.now);
    expect(await feedTitles(db, world.now, s1.sessionId)).toEqual(['Story B']);
    await undoDismiss(db, feed[0].article.id);
    expect(await feedTitles(db, world.now, s1.sessionId)).toEqual(['Story A', 'Story B']);
  });

  test('read later: save, undo, and done at 70% scroll moves it to History', async () => {
    const { db, world, run } = await setup([]);
    world.addGuardian([{ title: 'Long read', topic: 1, hoursAgo: 1 }, { title: 'Other', topic: 2, hoursAgo: 2 }]);
    await run();
    const s1 = await ensureSession(db, world.now);
    const feed = await loadFeed(db, await loadSettings(db), s1.sessionId, world.now);
    const [a, b] = feed.map((c) => c.article.id);
    await saveForLater(db, a, s1.sessionId, world.now);
    await saveForLater(db, b, s1.sessionId, world.now + 1000);
    expect((await loadReadLater(db)).map((r) => r.article.title)).toEqual(['Other', 'Long read']); // newest saved first
    await unsave(db, b, world.now + 2000); // undo
    expect((await loadReadLater(db)).map((r) => r.article.title)).toEqual(['Long read']);

    // Saved items survive a new session even though they have been seen.
    const s2 = await ensureSession(db, world.now + HOUR, true);
    expect(await feedTitles(db, world.now + HOUR, s2.sessionId)).toEqual([]);
    expect(await loadReadLater(db)).toHaveLength(1);

    expect((await recordReading(db, a, 30, 69, world.now + HOUR)).done).toBe(false);
    expect((await recordReading(db, a, 60, 70, world.now + HOUR)).done).toBe(true);
    expect(await loadReadLater(db)).toHaveLength(0);
    expect((await loadHistory(db, world.now + HOUR)).map((r) => r.article.title)).toContain('Long read');
  });

  test('what counts as read, bounced or neither', () => {
    expect(classifyReading(50, 10)).toBe('read');
    expect(classifyReading(20, 60)).toBe('read');
    expect(classifyReading(2, 20)).toBe('bounce');
    expect(classifyReading(2.9, 100)).toBe('bounce'); // one-screen article glanced at
    expect(classifyReading(3, 20)).toBeNull(); // 3 seconds is no longer a bounce
    expect(classifyReading(4, 100)).toBeNull(); // too quick to be read, too long to be a bounce
    expect(classifyReading(5, 20)).toBeNull();
    expect(classifyReading(20, 30)).toBeNull();
  });
});
