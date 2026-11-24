import {
  BLOCK_SIZE, EXPLORE_SLOTS, buildFeedOrder, ensureSession, loadFeed, moreLikeThis, recordImpressions,
  scoreIgnoredImpressions, dismiss, hideArticle, unhideArticle, lessBecause, lessLikeThis, markInterested, undoDismiss, undoLess, undoLessBecause,
  unmarkInterested, type RankItem,
} from '../src/core/feed';
import {
  BASELINE_RATIO, affinity, applySignal, coldFactor, finalScore, freshness, goodFits, importance, loadStats, resetLearning,
  scoreArticles, whyThis, featureKeys,
} from '../src/core/ranking';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/core/settings';
import { DAY } from '../src/core/types';
import { decayFactor, mulberry32 } from '../src/core/util';
import { HOUR, setup } from './helpers/world';

describe('score', () => {
  test('freshness halves every 8 hours; importance is log(1 + outlets)', () => {
    expect(freshness(0, 0)).toBe(1);
    expect(freshness(0, 8 * HOUR)).toBeCloseTo(0.5);
    expect(freshness(0, 24 * HOUR)).toBeCloseTo(0.125);
    expect(importance(1)).toBeCloseTo(Math.log(2));
    expect(importance(5)).toBeCloseTo(Math.log(6));
  });

  test('score = 1.0*A + 1.5*S + 1.0*F + 0.5*I, with A and S scaled by 0.3 for the first 14 days', () => {
    const parts = { a: 0.4, s: 0.2, i: Math.log(3), publishedAt: 0 };
    const warm = { ...DEFAULT_SETTINGS, learningStartedAt: -20 * DAY };
    expect(finalScore(parts, warm, 0)).toBeCloseTo(0.4 + 1.5 * 0.2 + 1 + 0.5 * Math.log(3));
    const cold = { ...DEFAULT_SETTINGS, learningStartedAt: -2 * DAY };
    expect(coldFactor(cold, 0)).toBe(0.3);
    expect(finalScore(parts, cold, 0)).toBeCloseTo(0.3 * 0.4 + 0.3 * 1.5 * 0.2 + 1 + 0.5 * Math.log(3));
    // Weights are settings.
    expect(finalScore(parts, { ...warm, weightF: 0, weightI: 0, weightS: 0, weightA: 2 }, 0)).toBeCloseTo(0.8);
  });

  test('signals decay with a 30-day half-life', () => {
    expect(decayFactor(30 * DAY)).toBeCloseTo(0.5);
    expect(decayFactor(60 * DAY)).toBeCloseTo(0.25);
  });

  test('affinity is the mean of log((positive + 1) / (negative + 5)) over features', () => {
    const a = { sourceId: 1, section: 'Politics', tags: [], tone: null, byline: null, wordCount: null };
    expect(featureKeys(a)).toEqual(['source:1', 'section:politics']);
    expect(affinity(a, new Map())).toBeCloseTo(BASELINE_RATIO);
    const stats = new Map([['section:politics', { pos: 9, neg: 0 }], ['source:1', { pos: 0, neg: 5 }]]);
    expect(affinity(a, stats)).toBeCloseTo((Math.log(10 / 5) + Math.log(1 / 10)) / 2);
  });

  test('word-count bands', () => {
    const base = { sourceId: 1, section: null, tags: [], tone: null, byline: null };
    expect(featureKeys({ ...base, wordCount: 599 })).toContain('words:short');
    expect(featureKeys({ ...base, wordCount: 600 })).toContain('words:medium');
    expect(featureKeys({ ...base, wordCount: 1500 })).toContain('words:medium');
    expect(featureKeys({ ...base, wordCount: 1501 })).toContain('words:long');
  });
});

describe('exploration', () => {
  function items(n: number): RankItem[] {
    // Half the articles are in sections he reads a lot, half in sections he rarely opens.
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1, score: 100 - i * 0.1, publishedAt: 1_000_000 - i * 1000,
      section: i % 2 === 0 ? (i % 4 === 0 ? 'Politics' : 'World') : (i % 4 === 1 ? 'Gardening' : 'Chess'),
    }));
  }
  const sectionPositive = new Map([['politics', 40], ['world', 25], ['gardening', 0.2], ['chess', 0]]);

  test('3 of every 20 feed slots are exploration items from rarely-opened sections', () => {
    const order = buildFeedOrder(items(200), sectionPositive, mulberry32(42));
    expect(order).toHaveLength(200);
    expect(new Set(order.map((o) => o.id)).size).toBe(200); // nothing repeated, nothing lost
    const all = new Map(items(200).map((i) => [i.id, i]));
    for (let block = 0; block < 4; block++) {
      const slots = order.slice(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE);
      const explore = slots.filter((o) => o.explore);
      expect(explore).toHaveLength(3);
      expect(slots.map((o, i) => (o.explore ? i : -1)).filter((i) => i >= 0)).toEqual(EXPLORE_SLOTS);
      for (const e of explore) expect(['Gardening', 'Chess']).toContain(all.get(e.id)!.section);
    }
  });

  test('exploration picks come from the fresher half of the rare-section articles still unplaced', () => {
    const list = items(200);
    const rare = list.filter((i) => i.section === 'Gardening' || i.section === 'Chess').sort((a, b) => b.publishedAt - a.publishedAt);
    const order = buildFeedOrder(list, sectionPositive, mulberry32(7));
    const placed = new Set<number>();
    let picks = 0;
    for (const o of order.slice(0, 100)) {
      if (o.explore) {
        const remaining = rare.filter((r) => !placed.has(r.id));
        const fresherHalf = remaining.slice(0, Math.ceil(remaining.length / 2)).map((r) => r.id);
        expect(fresherHalf).toContain(o.id);
        picks++;
      }
      placed.add(o.id);
    }
    expect(picks).toBe(15);
  });

  test('the order is stable for a session and differs between sessions', () => {
    const a = buildFeedOrder(items(100), sectionPositive, mulberry32(1)).map((o) => o.id);
    const b = buildFeedOrder(items(100), sectionPositive, mulberry32(1)).map((o) => o.id);
    const c = buildFeedOrder(items(100), sectionPositive, mulberry32(2)).map((o) => o.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('the remaining slots follow the score', () => {
    const order = buildFeedOrder(items(40), sectionPositive, mulberry32(3));
    const ranked = order.filter((o) => !o.explore).map((o) => o.id);
    expect(ranked).toEqual(ranked.slice().sort((x, y) => x - y));
  });

  test('For you, filtered, is in match order with no exploration picks (the Outside tab does that job)', async () => {
    const s = await setup([]);
    for (let i = 0; i < 60; i++) {
      s.world.addGuardian([{ title: `Story ${i}`, topic: i % 30, section: ['Politics', 'World', 'Culture', 'Science'][i % 4], hoursAgo: 1 + i * 0.2 }]);
    }
    await s.run();
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const feed = await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now);
    expect(feed.filter((c) => c.explore)).toHaveLength(0);
    const matches = feed.map((c) => c.match!);
    expect(matches).toEqual(matches.slice().sort((a, b) => b - a));
  });
});

describe('learning', () => {
  async function learningWorld() {
    const s = await setup([]);
    const sections = ['Politics', 'Science', 'Culture', 'Business'];
    for (let i = 0; i < 80; i++) {
      s.world.addGuardian([{
        title: `${sections[i % 4]} story ${i}`, topic: i % 4, section: sections[i % 4], hoursAgo: 1 + i * 0.1,
        tags: [sections[i % 4].toLowerCase()],
      }]);
    }
    await s.run();
    return s;
  }
  const meanRank = (feed: { article: { section: string | null } }[], section: string) => {
    const idx = feed.map((c, i) => (c.article.section === section ? i : -1)).filter((i) => i >= 0);
    return idx.reduce((a, b) => a + b, 0) / idx.length;
  };

  test('after 30 More like this taps on one section it moves up the feed, and Why am I seeing this names it', async () => {
    const s = await learningWorld();
    let { sessionId } = await ensureSession(s.db, s.world.now);
    const before = await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now);
    const rankBefore = meanRank(before, 'Science');

    const science = before.filter((c) => c.article.section === 'Science').slice(-15);
    for (let i = 0; i < 30; i++) await moreLikeThis(s.db, science[i % science.length].article.id, s.world.now);
    s.world.now += 60_000;
    await s.run('open');
    ({ sessionId } = await ensureSession(s.db, s.world.now, true));
    const settings = await loadSettings(s.db);
    const after = await loadFeed(s.db, settings, sessionId, s.world.now);
    const rankAfter = meanRank(after, 'Science');
    expect(rankAfter).toBeLessThan(rankBefore - 10);
    // The top of the feed is now mostly Science.
    expect(after.slice(0, 10).filter((c) => !c.explore && c.article.section === 'Science').length).toBeGreaterThanOrEqual(6);

    const top = after.find((c) => c.article.section === 'Science')!;
    const why = await whyThis(s.db, top.article.id, settings, s.world.now);
    expect(why).toHaveLength(3);
    expect(why.map((w) => w.text)).toContain('Section: Science');
  });

  test('good fit: marked only when preferences lift a card clearly above the typical story', async () => {
    expect(goodFits([0, 0, 0, 0])).toEqual([false, false, false, false]); // nothing learned yet
    expect(goodFits([0.5, 0.02, 0, -0.4, 0.01])).toEqual([true, false, false, false, false]);

    const s = await learningWorld();
    let { sessionId } = await ensureSession(s.db, s.world.now);
    const cold = await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now);
    expect(cold.filter((c) => c.goodFit)).toHaveLength(0);

    const science = cold.filter((c) => c.article.section === 'Science');
    for (const c of science.slice(0, 10)) await moreLikeThis(s.db, c.article.id, s.world.now);
    s.world.now += 60_000;
    await s.run('open');
    ({ sessionId } = await ensureSession(s.db, s.world.now, true));
    const after = await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now);
    const fitSections = new Set(after.filter((c) => c.goodFit).map((c) => c.article.section));
    expect(fitSections).toEqual(new Set(['Science']));
    expect(after.filter((c) => c.article.section !== 'Science').every((c) => !c.goodFit)).toBe(true);
  });

  test('Reset learning returns ranking to cold-start behaviour', async () => {
    const s = await learningWorld();
    let { sessionId } = await ensureSession(s.db, s.world.now);
    const order = async () => (await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now)).map((c) => c.article.id);
    const cold = await order();
    const science = (await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now)).filter((c) => c.article.section === 'Science');
    for (let i = 0; i < 30; i++) await moreLikeThis(s.db, science[i % science.length].article.id, s.world.now);
    await scoreArticles(s.db, s.world.now);
    expect(await order()).not.toEqual(cold);
    // Pretend the 14 cold-start days were long ago.
    await saveSettings(s.db, { learningStartedAt: s.world.now - 30 * DAY });
    expect(coldFactor(await loadSettings(s.db), s.world.now)).toBe(1);

    await resetLearning(s.db, s.world.now);
    await scoreArticles(s.db, s.world.now);
    expect((await loadStats(s.db, s.world.now)).size).toBe(0);
    expect((await s.db.get<{ n: number }>('SELECT COUNT(*) n FROM centroid'))!.n).toBe(0);
    expect(coldFactor(await loadSettings(s.db), s.world.now)).toBe(0.3);
    expect(await order()).toEqual(cold);
  });

  test('signal weights: more +3, dismiss -1, shown-not-opened -0.2', async () => {
    const s = await setup([]);
    s.world.addGuardian([
      { title: 'A', topic: 1, section: 'Politics', hoursAgo: 1 }, { title: 'B', topic: 2, section: 'Sport', hoursAgo: 2 },
      { title: 'C', topic: 3, section: 'Travel', hoursAgo: 3 },
    ]);
    await s.run();
    const s1 = await ensureSession(s.db, s.world.now);
    const feed = await loadFeed(s.db, await loadSettings(s.db), s1.sessionId, s.world.now);
    const [a, b, c] = feed.map((x) => x.article.id);
    await recordImpressions(s.db, [a, b, c].map((articleId) => ({ articleId, surface: 'feed' as const })), s1.sessionId, s.world.now);
    await moreLikeThis(s.db, a, s.world.now);
    await dismiss(s.db, b, s1.sessionId, s.world.now);
    // C was shown and ignored; that is scored when the session ends.
    expect(await scoreIgnoredImpressions(s.db, 'next-session', s.world.now)).toBe(1);
    expect(await scoreIgnoredImpressions(s.db, 'next-session', s.world.now)).toBe(0);
    const stats = await loadStats(s.db, s.world.now);
    expect(stats.get('section:politics')).toEqual({ pos: 3, neg: 0 });
    expect(stats.get('section:sport')).toEqual({ pos: 0, neg: 1 });
    expect(stats.get('section:travel')!.neg).toBeCloseTo(0.2);
    // Decay: a month later the weights have halved.
    const later = await loadStats(s.db, s.world.now + 30 * DAY);
    expect(later.get('section:politics')!.pos).toBeCloseTo(1.5);
    // Applying another signal folds the decay in.
    await applySignal(s.db, a, 'read', s.world.now + 30 * DAY);
    expect((await loadStats(s.db, s.world.now + 30 * DAY)).get('section:politics')!.pos).toBeCloseTo(2.5);
  });
});

describe('card feedback', () => {
  test('Interested (thumbs-up) is +1, counts once, and taking it back restores the model', async () => {
    const s = await setup([]);
    s.world.addGuardian([{ title: 'Liked story', topic: 1, section: 'Science', hoursAgo: 1, tags: ['space'] }]);
    await s.run();
    const { id } = (await s.db.get<{ id: number }>("SELECT id FROM article WHERE title = 'Liked story'"))!;
    const snapshot = async () => {
      const stats = await loadStats(s.db, s.world.now);
      const c = await s.db.get<{ weight: number }>("SELECT weight FROM centroid WHERE key = 'read'");
      return { science: stats.get('section:science')?.pos ?? 0, space: stats.get('tag:space')?.pos ?? 0, centroid: c?.weight ?? 0 };
    };
    const before = await snapshot();

    await markInterested(s.db, id, s.world.now);
    await markInterested(s.db, id, s.world.now); // a second tap adds nothing
    const liked = await snapshot();
    expect(liked.science).toBeCloseTo(before.science + 1);
    expect(liked.centroid).toBeCloseTo(before.centroid + 1);

    s.world.now += 5 * DAY;
    await unmarkInterested(s.db, id, s.world.now);
    const after = await snapshot();
    expect(after.science).toBeCloseTo(before.science * decayFactor(5 * DAY));
    expect(after.space).toBeCloseTo(0);
    expect(after.centroid).toBeCloseTo(0);
  });

  test('swipe "less, because": the whole -3 lands on the part named, the card goes, UNDO reverses it', async () => {
    const s = await setup([]);
    s.world.addGuardian([
      { title: 'Cat story', topic: 1, section: 'Sport', hoursAgo: 1, tags: ['sport', 'Rugby union', 'Six Nations'] },
      { title: 'Topic story', topic: 2, section: 'Sport', hoursAgo: 1, tags: ['sport', 'Cricket'] },
    ]);
    await s.run();
    const id = async (t: string) => (await s.db.get<{ id: number }>('SELECT id FROM article WHERE title = ?', [t]))!.id;
    const neg = async (k: string) => (await loadStats(s.db, s.world.now)).get(k)?.neg ?? 0;
    const dismissedWeight = async () => (await s.db.get<{ weight: number }>("SELECT weight FROM centroid WHERE key = 'dismissed'"))?.weight ?? 0;
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const cat = await id('Cat story');
    const topic = await id('Topic story');

    await lessBecause(s.db, cat, 'section', sessionId, s.world.now);
    expect(await neg('section:sport')).toBeCloseTo(3);
    expect(await neg('tag:rugby union')).toBeCloseTo(0);
    expect(await dismissedWeight()).toBeCloseTo(0); // a category complaint is not about the story's subject

    await lessBecause(s.db, topic, 'topic', sessionId, s.world.now);
    expect(await neg('tag:cricket')).toBeCloseTo(3);
    expect(await neg('tag:sport')).toBeCloseTo(0); // the section's own tag belongs to the category
    expect(await neg('section:sport')).toBeCloseTo(3); // unchanged by the topic reason
    expect(await dismissedWeight()).toBeCloseTo(3);
    const titles = async () => (await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now)).map((c) => c.article.title);
    expect(await titles()).toEqual([]);

    await undoLessBecause(s.db, cat, 'section', s.world.now);
    await undoLessBecause(s.db, topic, 'topic', s.world.now);
    expect(await neg('section:sport')).toBeCloseTo(0);
    expect(await neg('tag:cricket')).toBeCloseTo(0);
    expect(await dismissedWeight()).toBeCloseTo(0);
    expect((await titles()).sort()).toEqual(['Cat story', 'Topic story']);
  });

  test('Less like this (menu) is -3, Not interested (thumbs-down) is -1; both hide the card, and UNDO reverses either', async () => {
    const s = await setup([]);
    s.world.addGuardian([
      { title: 'Down story', topic: 1, section: 'Sport', hoursAgo: 1, tags: ['rugby'] },
      { title: 'Swiped story', topic: 2, section: 'Culture', hoursAgo: 1, tags: ['opera'] },
    ]);
    await s.run();
    const id = async (t: string) => (await s.db.get<{ id: number }>('SELECT id FROM article WHERE title = ?', [t]))!.id;
    const neg = async (k: string) => (await loadStats(s.db, s.world.now)).get(k)?.neg ?? 0;
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const down = await id('Down story');
    const swiped = await id('Swiped story');

    await lessLikeThis(s.db, down, sessionId, s.world.now);
    await lessLikeThis(s.db, down, sessionId, s.world.now); // counts once
    await dismiss(s.db, swiped, sessionId, s.world.now);
    expect(await neg('section:sport')).toBeCloseTo(3);
    expect(await neg('section:culture')).toBeCloseTo(1);
    const titles = async () => (await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now)).map((c) => c.article.title);
    expect(await titles()).toEqual([]);

    await undoLess(s.db, down, s.world.now);
    await undoDismiss(s.db, swiped, s.world.now);
    expect(await neg('section:sport')).toBeCloseTo(0);
    expect(await neg('tag:opera')).toBeCloseTo(0);
    expect((await titles()).sort()).toEqual(['Down story', 'Swiped story']);
  });

  test('swipe right (hide) removes the card but scores only as scrolled past, never more', async () => {
    const s = await setup([]);
    s.world.addGuardian([
      { title: 'Hidden story', topic: 1, section: 'Sport', hoursAgo: 1, tags: ['rugby'] },
      { title: 'Scrolled story', topic: 2, section: 'Culture', hoursAgo: 1, tags: ['opera'] },
    ]);
    await s.run();
    const id = async (t: string) => (await s.db.get<{ id: number }>('SELECT id FROM article WHERE title = ?', [t]))!.id;
    const neg = async (k: string) => (await loadStats(s.db, s.world.now)).get(k)?.neg ?? 0;
    const hidden = await id('Hidden story');
    const scrolled = await id('Scrolled story');
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const titles = async (sid: string) => (await loadFeed(s.db, await loadSettings(s.db), sid, s.world.now)).map((c) => c.article.title);

    await recordImpressions(s.db, [{ articleId: scrolled, surface: 'feed' }], sessionId, s.world.now);
    await hideArticle(s.db, hidden, sessionId, s.world.now);
    expect(await titles(sessionId)).toEqual(['Scrolled story']); // hidden at once, even this session
    expect(await neg('section:sport')).toBe(0); // nothing learned when hiding

    await unhideArticle(s.db, hidden); // UNDO
    expect((await titles(sessionId)).sort()).toEqual(['Hidden story', 'Scrolled story']);
    await hideArticle(s.db, hidden, sessionId, s.world.now);

    // The session ends: both count as "shown, not opened", the same -0.2 each.
    const { sessionId: next } = await ensureSession(s.db, s.world.now + 1000, true);
    expect(await neg('section:sport')).toBeCloseTo(0.2);
    expect(await neg('section:culture')).toBeCloseTo(0.2);
    expect(await titles(next)).toEqual([]);
  });
});
