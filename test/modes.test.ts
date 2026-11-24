import { loadBriefing } from '../src/core/briefing';
import {
  LATEST_LIMIT, dismiss, ensureSession, hideArticle, loadFeed, moreLikeThis, noteBackground, recordImpressions, recordReading,
} from '../src/core/feed';
import { relativeMatch, scoreArticles } from '../src/core/ranking';
import { loadSettings, saveSettings } from '../src/core/settings';
import { addRule } from '../src/core/topics';
import { HOUR, feedUrl, setup } from './helpers/world';

type S = Awaited<ReturnType<typeof setup>>;
const idOf = async (db: any, title: string) => (await db.get('SELECT id FROM article WHERE title = ?', [title])).id as number;

async function feedOf(s: S) {
  const { sessionId } = await ensureSession(s.db, s.world.now);
  return { sessionId, cards: await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now) };
}

/** Starts a new session the way ten minutes in the background does. */
async function nextSession(s: S) {
  await noteBackground(s.db, s.world.now);
  s.world.now += 11 * 60_000;
}

describe('Latest first', () => {
  test('newest first, and a story stays after it has been on screen or read; one put away by hand goes', async () => {
    const s = await setup();
    s.world.addGuardian([
      { title: 'G: oldest', topic: 1, hoursAgo: 6 },
      { title: 'G: middle', topic: 2, hoursAgo: 3 },
      { title: 'G: newest', topic: 3, hoursAgo: 1 },
      { title: 'G: hidden', topic: 4, hoursAgo: 2 },
      { title: 'G: dismissed', topic: 5, hoursAgo: 2.5 },
    ]);
    await s.run();
    await saveSettings(s.db, { chronological: true });
    const { sessionId, cards } = await feedOf(s);
    expect(cards.map((c) => c.article.title)).toEqual(['G: newest', 'G: hidden', 'G: dismissed', 'G: middle', 'G: oldest']);

    // Everything on screen, one read, one hidden, one dismissed; then a new session.
    await recordImpressions(s.db, cards.map((c) => ({ articleId: c.article.id, surface: 'feed' as const })), sessionId, s.world.now);
    await recordReading(s.db, await idOf(s.db, 'G: middle'), 60, 100, s.world.now);
    await hideArticle(s.db, await idOf(s.db, 'G: hidden'), sessionId, s.world.now);
    await dismiss(s.db, await idOf(s.db, 'G: dismissed'), sessionId, s.world.now);
    await nextSession(s);
    const after = (await feedOf(s)).cards;
    expect(after.map((c) => c.article.title)).toEqual(['G: newest', 'G: middle', 'G: oldest']);
    expect(after.find((c) => c.article.title === 'G: middle')!.opened).toBe(true);
    expect(after.every((c) => c.seenAt == null)).toBe(true);

    // Back to the seen rule: all of them have been on screen in an earlier session, so all are gone.
    await saveSettings(s.db, { chronological: false });
    expect((await feedOf(s)).cards).toHaveLength(0);
  });

  test('at most 100: filtered the best matches, best first; unfiltered simply the newest 100, newest first', async () => {
    const s = await setup();
    const stories = Array.from({ length: LATEST_LIMIT + 20 }, (_, i) => ({
      title: `G: story ${i}`, topic: i % 30, hoursAgo: 1 + i * 0.25, section: i === LATEST_LIMIT + 10 ? 'Favourite' : 'Other',
    }));
    s.world.addGuardian(stories);
    await s.run();
    // Teach it to like the one old story's section, strongly.
    const fav = await idOf(s.db, `G: story ${LATEST_LIMIT + 10}`);
    for (let i = 0; i < 6; i++) await moreLikeThis(s.db, fav, s.world.now + i);
    await s.db.run("DELETE FROM interaction WHERE kind = 'more'"); // keep the learning, allow re-use of the card
    await saveSettings(s.db, { chronological: true, coldStartDays: 0 });
    await scoreArticles(s.db, s.world.now);

    await saveSettings(s.db, { filterThreshold: 0 });
    const ranked = (await feedOf(s)).cards;
    expect(ranked).toHaveLength(LATEST_LIMIT);
    expect(ranked[0].article.id).toBe(fav);
    const matches = ranked.map((c) => c.match!);
    expect(matches).toEqual(matches.slice().sort((a, b) => b - a));

    await saveSettings(s.db, { unfiltered: true });
    const plain = (await feedOf(s)).cards;
    expect(plain.map((c) => c.article.title)).toEqual(stories.slice(0, LATEST_LIMIT).map((x) => x.title));
    expect(plain.some((c) => c.article.id === fav)).toBe(false);
  });
});

describe('Unfiltered', () => {
  test('the order ignores what has been learned, and every card carries its chance of suiting him', async () => {
    const s = await setup();
    s.world.addGuardian([
      { title: 'G: liked, older', topic: 1, hoursAgo: 8, section: 'Science' },
      { title: 'G: plain, newer', topic: 2, hoursAgo: 1, section: 'Sport' },
    ]);
    await s.run();
    const liked = await idOf(s.db, 'G: liked, older');
    for (let i = 0; i < 5; i++) await moreLikeThis(s.db, liked, s.world.now + i);
    await s.db.run("DELETE FROM interaction WHERE kind = 'more'");
    await saveSettings(s.db, { coldStartDays: 0 });
    await scoreArticles(s.db, s.world.now);

    // Filtered: best match first, so the liked one leads although it is older.
    await saveSettings(s.db, { filterThreshold: 0 });
    const ranked = (await feedOf(s)).cards;
    expect(ranked.map((c) => c.article.title)).toEqual(['G: liked, older', 'G: plain, newer']);
    expect(ranked[0].match!).toBeGreaterThan(ranked[1].match!);

    await saveSettings(s.db, { unfiltered: true });
    await nextSession(s);
    const plain = (await feedOf(s)).cards;
    expect(plain.map((c) => c.article.title)).toEqual(['G: plain, newer', 'G: liked, older']);
    const m = new Map(plain.map((c) => [c.article.title, c.match!]));
    expect(m.get('G: liked, older')!).toBeGreaterThan(m.get('G: plain, newer')!);
    expect(m.get('G: liked, older')!).toBeGreaterThan(50);
  });

  test('filtered: stories under the match threshold are left out, watched ones and those already seen stay', async () => {
    const s = await setup();
    const stories = Array.from({ length: 10 }, (_, i) => ({ title: `G: story ${i}`, topic: i, hoursAgo: 1 + i, section: `Section ${i}` }));
    s.world.addGuardian(stories);
    await s.run();
    // Teach it to dislike sections 0 and 1, and like section 9.
    for (const i of [0, 1]) await dismiss(s.db, await idOf(s.db, `G: story ${i}`), 'x', s.world.now);
    await moreLikeThis(s.db, await idOf(s.db, 'G: story 9'), s.world.now);
    await s.db.run("DELETE FROM interaction WHERE kind IN ('dismiss', 'more')");
    await s.db.run('DELETE FROM impression');
    await scoreArticles(s.db, s.world.now);
    const titles = async () => (await feedOf(s)).cards.map((c) => c.article.title);

    await saveSettings(s.db, { filterThreshold: 0 });
    expect(await titles()).toHaveLength(10);
    await saveSettings(s.db, { filterThreshold: 20 });
    const kept = await titles();
    expect(kept).not.toContain('G: story 0');
    expect(kept).not.toContain('G: story 1');
    expect(kept).toContain('G: story 9');

    // A watched topic always shows.
    await addRule(s.db, 'watch', 'story 0', null, s.world.now);
    expect(await titles()).toContain('G: story 0');

    // Unfiltered: nothing left out, whatever the threshold.
    await saveSettings(s.db, { unfiltered: true, filterThreshold: 90 });
    expect(await titles()).toHaveLength(10);
  });

  test('the percentage ranks stories against each other, 5 to 95, however small the differences', () => {
    expect(relativeMatch([0.01, -0.02, 0.03])).toEqual([50, 5, 95]);
    expect(relativeMatch([0.1, 0.1, -0.1, 0.2])).toEqual([50, 50, 5, 95]);
    expect(relativeMatch([0.4])).toEqual([50]);
    expect(relativeMatch([])).toEqual([]);
  });
});

describe('briefing written in the background', () => {
  test('away long enough: a background refresh writes it, so it is there on opening; opening adds no model call', async () => {
    const s = await setup();
    s.world.addGuardian([{ title: 'G: old news', topic: 20, hoursAgo: 3 }]);
    await s.run();
    await ensureSession(s.db, s.world.now);
    const leftAt = s.world.now;
    await noteBackground(s.db, leftAt);
    const calls = () => s.world.chatCalls.filter((c) => c.purpose === 'briefing').length;

    // Two hours away: not long enough yet.
    s.world.now += 2 * HOUR;
    await s.run('background');
    expect(await loadBriefing(s.db, s.world.now)).toBeNull();

    // Nine hours away, and the news has moved on.
    s.world.now += 7 * HOUR;
    s.world.addGuardian([{ title: 'G: budget', topic: 1, hoursAgo: 2 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1, hoursAgo: 2 }]);
    const res = await s.run('background');
    expect(res.steps.find((x) => x.name.startsWith('7c'))!.info).toMatch(/1 stories/);
    const b = (await loadBriefing(s.db, s.world.now))!;
    expect(b.sinceAt).toBe(leftAt);
    expect(b.items.map((i) => i.headline)).toEqual(['G: budget']);
    expect(calls()).toBe(1);

    // Another background run, nothing new: left as it is.
    s.world.now += HOUR;
    await s.run('background');
    expect(calls()).toBe(1);

    // He comes back: it is already there, and the refresh on opening keeps it.
    await ensureSession(s.db, s.world.now);
    expect((await loadBriefing(s.db, s.world.now))!.id).toBe(b.id);
    const open = await s.run('open');
    expect(open.steps.find((x) => x.name.startsWith('7c'))!.info).toMatch(/unchanged/);
    expect(calls()).toBe(1);
    expect((await loadSettings(s.db)).briefingSince).toBe(0);
  });

  test('new stories while still away: the briefing is rewritten to include them', async () => {
    const s = await setup();
    await s.run();
    await ensureSession(s.db, s.world.now);
    await noteBackground(s.db, s.world.now);
    s.world.now += 9 * HOUR;
    s.world.addGuardian([{ title: 'G: budget', topic: 1, hoursAgo: 2 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1, hoursAgo: 2 }]);
    await s.run('background');
    s.world.now += 2 * HOUR;
    s.world.addGuardian([{ title: 'G: storm', topic: 2, hoursAgo: 1 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: storm', topic: 2, hoursAgo: 1 }]);
    await s.run('background');
    const b = (await loadBriefing(s.db, s.world.now))!;
    expect(b.items.map((i) => i.headline).sort()).toEqual(['G: budget', 'G: storm']);
  });
});
