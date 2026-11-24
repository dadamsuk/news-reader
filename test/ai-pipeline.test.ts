/**
 * The sections-layout pipeline (PRD "Ingestion and processing"): prefilter, cluster, enrich (one
 * call per story, batched, style rules), significance, relevance, sections, expiry, late coverage,
 * the budget cap and the six-minute background limit.
 */
import { ensureSession, loadFeed, recordImpressions } from '../src/core/feed';
import { AI_MODE_ID, saveModeSettings, loadSectionsSettings } from '../src/core/modes';
import { loadSections, otherNewsCount, relevanceThreshold } from '../src/core/sections';
import { loadSettings, saveSettings } from '../src/core/settings';
import { countWords } from '../src/core/util';
import { enrichSystem, significance, styled } from '../src/pipeline/sections';
import { aiWorld, digestFeedXml, digestIssueHtml, hnFixtures } from './helpers/ai';
import { T0 } from './helpers/world';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
type W = Awaited<ReturnType<typeof aiWorld>>;

async function view(s: W) {
  const { sessionId } = await ensureSession(s.db, s.world.now);
  const v = await loadSections(s.db, AI_MODE_ID, sessionId, s.world.now);
  return { sessionId, main: v.sections[0].cards, other: v.sections[1].cards, v };
}
const enrichCalls = (s: W) => s.world.chatCalls.filter((c) => c.purpose === 'enrich');

describe('the AI pipeline', () => {
  test('runs as its own steps after News, and News is unchanged by it', async () => {
    const s = await aiWorld();
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }]);
    s.world.addFeed(s.vendorFeed, [{ title: 'Vendor ships a coding agent', topic: 10 }]);
    const res = await s.run();
    expect(res.steps.map((x) => x.name)).toEqual([
      '1-2 Fetch and de-duplicate', '3 Embed', '4 Cluster', '5 Second sources', '6 Score', '7 Right press', '7b Followed stories',
      '7c Briefing', '8 Prefetch', 'AI: 1 Fetch, split and prefilter', 'AI: 2 Embed and cluster', 'AI: 3 Enrich', 'AI: 4 Score and assign',
      'AI: 5 Profile', '9 Retention',
    ]);
    expect(res.steps.every((x) => x.ok)).toBe(true);
    const settings = await loadSettings(s.db);
    const { sessionId } = await ensureSession(s.db, s.world.now);
    expect((await loadFeed(s.db, settings, sessionId, s.world.now)).map((c) => c.article.title)).toEqual(['G: budget']);
    expect((await view(s)).main.map((c) => c.article.title)).toEqual(['Short headline for s1']);
    // AI spend is recorded against the AI mode.
    const by = await s.db.all<{ mode_id: number; purpose: string }>("SELECT DISTINCT mode_id, purpose FROM llm_usage WHERE purpose = 'enrich'");
    expect(by).toEqual([{ mode_id: AI_MODE_ID, purpose: 'enrich' }]);
  });

  test('the same story from 3 sources shows as one card with "+2 more"; the original leads', async () => {
    const s = await aiWorld();
    const post = 'https://vendor.test/blog/agents-ga';
    s.world.addFeed(s.blogFeed, [{ title: 'My take on the new agent release', topic: 10, sim: 0.95, hoursAgo: 1 }]);
    s.world.addFeed(s.vendorFeed, [{ title: 'Agents are now generally available', topic: 10, sim: 0.96, hoursAgo: 3, url: post }]);
    hnFixtures(s.world, [{ id: 7, title: 'Agents are now generally available', score: 320, url: post }]);
    await s.run();
    const { main } = await view(s);
    expect(main).toHaveLength(1);
    expect(main[0].sourceName).toBe('Vendor');
    expect(main[0].more.map((m) => m.sourceName).sort()).toEqual(['Blog', 'Hacker News']);
    expect(main[0].more.find((m) => m.sourceName === 'Hacker News')!.url).toBe('https://news.ycombinator.com/item?id=7');
    expect(main[0].outletCount).toBe(3);
    expect(enrichCalls(s)).toHaveLength(1);
  });

  test('a story first seen on Hacker News is taken over by the vendor when its own post arrives', async () => {
    const s = await aiWorld();
    const post = 'https://vendor.test/blog/new-model';
    hnFixtures(s.world, [{ id: 9, title: 'Vendor releases a new model', score: 500, url: post }]);
    await s.run();
    expect((await view(s)).main[0].sourceName).toBe('Hacker News');
    s.world.now += HOUR;
    s.world.addFeed(s.vendorFeed, [{ title: 'Introducing our new model', topic: 11, url: post, hoursAgo: 0.5 }]);
    await s.run();
    const card = (await view(s)).main[0];
    expect(card.sourceName).toBe('Vendor');
    expect(card.more.map((m) => m.sourceName)).toEqual(['Hacker News']);
  });

  test('a digest issue with 12 linked stories becomes 12 stories', async () => {
    const s = await aiWorld();
    s.world.pages.set('https://digest.test/rss.xml', digestFeedXml(s.world, [{ url: 'https://digest.test/issues/42', title: 'Issue 42', html: digestIssueHtml(12), hoursAgo: 2 }]));
    await s.run();
    expect(await s.db.get("SELECT COUNT(*) n FROM article WHERE source_id = ? AND digest_context IS NOT NULL", [s.ids.Digest])).toEqual({ n: 12 });
    expect((await view(s)).main).toHaveLength(12);
    // The digest's own words go to the model as context.
    expect(enrichCalls(s)[0].user).toContain("Digest's words: Story 1: A lab released something numbered 1");
  });

  test('prefilter: nothing older than the max age, no Hacker News story below the threshold, nothing seen comes back', async () => {
    const s = await aiWorld();
    s.world.addFeed(s.vendorFeed, [{ title: 'Fresh release', topic: 12, hoursAgo: 5 }, { title: 'Stale release', topic: 13, hoursAgo: 8 * 24 }]);
    hnFixtures(s.world, [{ id: 1, title: 'An AI agent for spreadsheets', score: 149, url: 'https://sheets.test/' }]);
    await s.run();
    const titles = (await s.db.all<{ title: string }>('SELECT title FROM article WHERE mode_id = ?', [AI_MODE_ID])).map((r) => r.title);
    expect(titles).toEqual(['Fresh release']);
    // Seen, then fetched again: still one row, and the card does not return.
    const { sessionId, main } = await view(s);
    await recordImpressions(s.db, [{ articleId: main[0].article.id, surface: 'feed' }], sessionId, s.world.now);
    s.world.now += 2 * HOUR;
    await ensureSession(s.db, s.world.now, true);
    await s.run();
    expect(await s.db.get('SELECT COUNT(*) n FROM article WHERE mode_id = ?', [AI_MODE_ID])).toEqual({ n: 1 });
    expect((await view(s)).main).toHaveLength(0);
  });

  test('one model call per story, never per item, batched; nothing is enriched twice', async () => {
    const s = await aiWorld();
    s.world.addFeed(s.vendorFeed, Array.from({ length: 12 }, (_, i) => ({ title: `Release number ${i}`, topic: 2 + i, hoursAgo: 1 + i })));
    s.world.addFeed(s.blogFeed, [{ title: 'Blog on release number 0', topic: 2, sim: 0.96 }]); // joins a story
    await s.run();
    expect(enrichCalls(s)).toHaveLength(3); // 12 stories, 5 to a call
    expect(enrichCalls(s).reduce((n, c) => n + (c.user.match(/^ITEM /gm) ?? []).length, 0)).toBe(12);
    s.world.now += HOUR;
    await s.run('manual');
    expect(enrichCalls(s)).toHaveLength(3);
  });

  test('every card: headline of 10 words or fewer, summary of 20 or fewer, and the checkable style rules', async () => {
    const s = await aiWorld();
    s.world.onChat = (purpose, user) => {
      const ids = Array.from(user.matchAll(/^ITEM (s\d+)$/gm)).map((m) => m[1]);
      return JSON.stringify({ items: ids.map((id) => ({
        id, headline: 'A groundbreaking new model — and it is twice as fast as the last one, truly amazing!',
        summary: 'The company released a model that runs twice as fast as its predecessor on the same hardware while costing 40% less per million tokens processed by customers!',
        why: 'Cheaper inference changes what your team can afford to run in production every single day of the week.',
        tags: ['model releases', 'not a real tag'], type: 'release', profile_match: 0.8, impact: 0.6, profile_lines: [],
      })) });
    };
    s.world.addFeed(s.vendorFeed, [{ title: 'Model two', topic: 3 }, { title: 'Model three', topic: 4 }]);
    await s.run();
    const { main } = await view(s);
    expect(main).toHaveLength(2);
    for (const c of main) {
      expect(countWords(c.article.title)).toBeLessThanOrEqual(10);
      expect(countWords(c.article.summary)).toBeLessThanOrEqual(20);
      expect(countWords(c.why!)).toBeLessThanOrEqual(15);
      expect(c.article.title + c.article.summary + c.why).not.toMatch(/[!—]|groundbreaking/i);
      expect(c.tags).toEqual(['model releases']);
    }
    expect(styled('Plain text — with a dash!', 10)).toBe('Plain text, with a dash.');
  });

  test('the enrichment prompt carries the style rules and the current profile', async () => {
    const s = await aiWorld();
    s.world.addFeed(s.vendorFeed, [{ title: 'A release', topic: 3 }]);
    await s.run();
    const call = enrichCalls(s)[0];
    expect(call.user).toContain('Headline: A release');
    // The system prompt is not recorded by the fake; check the builder directly.
    const text = enrichSystem(await loadSectionsSettings(s.db, AI_MODE_ID), '## Interested in\n- Coding agents');
    expect(text).toMatch(/British spelling/);
    expect(text).toMatch(/No exclamation marks and no em dashes/);
    expect(text).toContain('- Coding agents');
  });
});

describe('significance, sections and expiry', () => {
  test('significance is a weighted sum of coverage, Hacker News, a major release and impact', () => {
    const s = { sigSourcesWeight: 0.35, sigHnWeight: 0.2, sigReleaseWeight: 0.2, sigImpactWeight: 0.25, sourcesSaturate: 5, hnPointsFull: 500 } as any;
    expect(significance({ sources: 5, hnPoints: 500, release: true, impact: 1 }, s).value).toBeCloseTo(1);
    expect(significance({ sources: 1, hnPoints: 0, release: false, impact: 0 }, s)).toEqual({ value: 0, reason: null });
    expect(significance({ sources: 4, hnPoints: 100, release: false, impact: 0.2 }, s).reason).toBe('Widely covered');
    expect(significance({ sources: 1, hnPoints: 450, release: false, impact: 0.2 }, s).reason).toBe('Trending on HN');
    expect(significance({ sources: 2, hnPoints: 0, release: true, impact: 0.2 }, s).reason).toBe('Major release');
    expect(significance({ sources: 1, hnPoints: 0, release: false, impact: 0.9 }, s).reason).toBe('High impact');
  });

  test('late-arriving coverage adds a source and raises significance without summarising again', async () => {
    const s = await aiWorld();
    s.world.onChat = (purpose, user) => JSON.stringify({ items: Array.from(user.matchAll(/^ITEM (s\d+)$/gm)).map((m) => ({
      id: m[1], headline: 'Vendor ships a model', summary: 'It is faster.', why: 'Speed.', tags: ['model releases'], type: 'release', profile_match: 0.1, impact: 0.9, profile_lines: [],
    })) });
    s.world.addFeed(s.vendorFeed, [{ title: 'Vendor ships a model', topic: 20, hoursAgo: 2 }]);
    await s.run();
    let v = await view(s);
    expect(v.main).toHaveLength(0);
    expect(v.other).toHaveLength(0); // 0.2 release + 0.225 impact: not yet significant enough
    const before = (await s.db.get<{ significance: number }>('SELECT significance FROM cluster WHERE mode_id = ?', [AI_MODE_ID]))!.significance;
    // Over the day, two more sources cover it: it moves into In other news.
    s.world.now += 5 * HOUR;
    s.world.addFeed(s.blogFeed, [{ title: 'Blog: the vendor model', topic: 20, sim: 0.95, hoursAgo: 1 }]);
    s.world.pages.set('https://digest.test/rss.xml', digestFeedXml(s.world, [{
      url: 'https://digest.test/issues/9', title: 'Issue 9', hoursAgo: 1,
      html: '<ul><li><p>Vendor ships a model that is faster (<a href="https://vendor.test/vendor-ships-a-model">post</a>).</p></li><li><p>Other (<a href="https://o.test/x">x</a>)</p></li></ul>',
    }]));
    await s.run();
    const after = (await s.db.get<{ significance: number; source_count: number }>('SELECT significance, source_count FROM cluster WHERE mode_id = ? ORDER BY id LIMIT 1', [AI_MODE_ID]))!;
    expect(after.source_count).toBe(3);
    expect(after.significance).toBeGreaterThan(before);
    v = await view(s);
    // The label is the significance input that scored most: a release from a high-priority vendor (0.2) beats three sources (0.175).
    expect(v.other.map((c) => [c.article.title, c.reason])).toEqual([['Vendor ships a model', 'Major release']]);
    expect(enrichCalls(s).filter((c) => c.user.includes('Vendor ships a model'))).toHaveLength(1);
  });

  test('with the app closed for 3 days, opening it shows a processed feed with no expired items', async () => {
    const s = await aiWorld();
    s.world.addFeed(s.vendorFeed, [{ title: 'Five days old', topic: 30, hoursAgo: 5 * 24 }, { title: 'One day old', topic: 31, hoursAgo: 24 }]);
    await s.run('background');
    expect((await view(s)).main).toHaveLength(2);
    // Three days later; no refresh has run meanwhile. The feed opens at once, already processed,
    // and the story now 8 days old is gone.
    s.world.now += 3 * DAY;
    const t0 = Date.now();
    const v = await view(s);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(v.main.map((c) => c.article.canonicalUrl)).toEqual(['https://vendor.test/one-day-old']);
    expect(v.main.every((c) => c.enriched)).toBe(true);
  });

  test('a very significant story lasts 14 days instead of 7', async () => {
    const s = await aiWorld();
    s.world.onChat = (purpose, user) => JSON.stringify({ items: Array.from(user.matchAll(/^ITEM (s\d+)$/gm)).map((m) => ({
      id: m[1], headline: 'Big', summary: 'Big.', why: '', tags: ['model releases'], type: 'release', profile_match: 0.1, impact: 1, profile_lines: [],
    })) });
    const post = 'https://vendor.test/big';
    s.world.addFeed(s.vendorFeed, [{ title: 'A very big release', topic: 40, hoursAgo: 6 * 24, url: post }]);
    s.world.addFeed(s.blogFeed, [{ title: 'On the big release', topic: 40, sim: 0.95, hoursAgo: 6 * 24 }]);
    hnFixtures(s.world, [{ id: 3, title: 'A very big AI model release', score: 900, url: post, hoursAgo: 6 * 24 }]);
    await s.run();
    const c = (await s.db.get<any>('SELECT significance, expires_at, section FROM cluster WHERE mode_id = ?', [AI_MODE_ID]))!;
    expect(c.significance).toBeGreaterThanOrEqual(0.8);
    expect(c.expires_at - (s.world.now - 6 * DAY)).toBe(14 * DAY);
    s.world.now += 3 * DAY;
    expect((await view(s)).other.map((x) => x.article.title)).toEqual(['Big']);
  });
});

describe('budget and background', () => {
  test('at the monthly cap AI cards show source headlines and both modes still load; unseen stories are enriched when the month turns', async () => {
    const s = await aiWorld();
    s.world.now = Date.UTC(2026, 10, 29, 12); // two days before the month turns
    s.world.addGuardian([{ title: 'G: news story', topic: 1 }]);
    s.world.addFeed(s.vendorFeed, [{ title: 'Vendor: the source headline as published', topic: 50 }]);
    await saveSettings(s.db, { monthlyBudgetUsd: 0.000001 });
    await s.db.run("INSERT INTO llm_usage(at, model, purpose, input_tokens, output_tokens, cost_usd) VALUES(?, 'm', 'x', 1, 1, 0.01)", [s.world.now]);
    await s.run();
    expect(enrichCalls(s)).toHaveLength(0);
    const { main } = await view(s);
    expect(main.map((c) => [c.article.title, c.enriched])).toEqual([['Vendor: the source headline as published', false]]);
    const { sessionId } = await ensureSession(s.db, s.world.now);
    expect((await loadFeed(s.db, await loadSettings(s.db), sessionId, s.world.now)).map((c) => c.article.title)).toEqual(['G: news story']);
    // The 1st of next month.
    s.world.now = Date.UTC(2026, 11, 1, 9, 0, 0);
    await s.run('manual');
    expect(enrichCalls(s)).toHaveLength(1);
  });

  test('a background run starts no new step after its time is up; unfinished enrichment carries over', async () => {
    const s = await aiWorld();
    s.world.addFeed(s.vendorFeed, Array.from({ length: 10 }, (_, i) => ({ title: `Item ${i}`, topic: 2 + i })));
    // Out of time once the AI items are embedded (News has nothing to embed here).
    s.deps.shouldStop = () => s.world.embedCalls >= 1;
    const first = await s.run('background');
    expect(first.steps.find((x) => x.name === 'AI: 3 Enrich')).toMatchObject({ ok: false, error: 'stopped: out of background time' });
    expect(enrichCalls(s)).toHaveLength(0);
    s.deps.shouldStop = undefined;
    s.world.now += HOUR;
    await s.run('background');
    expect(enrichCalls(s)).toHaveLength(2);
    expect(await s.db.get('SELECT COUNT(*) n FROM cluster WHERE mode_id = ? AND enriched_at IS NULL', [AI_MODE_ID])).toEqual({ n: 0 });
  });
});

describe('privacy', () => {
  test('no API key appears in any model request', async () => {
    const s = await aiWorld();
    const keys = ['sk-or-test-key-123456', 'good-guardian-key'];
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const inner = s.world.fetch;
    s.deps.fetch = async (url, init = {}) => {
      if (/\/(chat\/completions|embeddings)/.test(url)) seen.push({ url, headers: init.headers ?? {}, body: init.body ?? '' });
      return inner(url, init);
    };
    s.world.addGuardian([{ title: 'G: budget raises taxes', topic: 1 }]);
    s.world.addFeed(s.vendorFeed, [{ title: 'Vendor release', topic: 60 }]);
    await s.run();
    expect(seen.length).toBeGreaterThan(1);
    for (const r of seen) {
      for (const k of keys) {
        expect(r.url).not.toContain(k);
        expect(r.body).not.toContain(k);
        // The OpenRouter key goes only where it must: the Authorization header of a call to OpenRouter.
        for (const [h, v] of Object.entries(r.headers)) if (h !== 'Authorization') expect(v).not.toContain(k);
      }
      expect(r.headers.Authorization).toBe('Bearer sk-or-test-key-123456');
    }
  });

  test('the cold start: relevance threshold 0.4 and five In other news stories for the first two weeks', async () => {
    const s = await aiWorld({ cold: true });
    const st = await loadSectionsSettings(s.db, AI_MODE_ID);
    expect(relevanceThreshold(st, s.world.now)).toBe(0.4);
    expect(otherNewsCount(st, s.world.now)).toBe(5);
    await saveModeSettings(s.db, AI_MODE_ID, { learningStartedAt: T0 - 15 * DAY });
    const later = await loadSectionsSettings(s.db, AI_MODE_ID);
    expect(relevanceThreshold(later, s.world.now)).toBe(0.5);
    expect(otherNewsCount(later, s.world.now)).toBe(4);
  });
});
