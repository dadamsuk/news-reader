/**
 * Display and learning in a sections-layout mode (PRD "Display" and "Learning"): the two sections,
 * the seen rule, In other news holding up while ignored, signal weights, EMA tag and source
 * weights, graduation, the versioned profile with pinned lines, rescoring, and isolation from News.
 */
import {
  dismiss, ensureSession, hideArticle, lessBecause, markInterested, moreLikeThis, noteBackground, recordImpressions, recordOpen,
  recordReading, saveForLater, undoDismiss,
} from '../src/core/feed';
import { learnedScore, loadWeights, recentSignals } from '../src/core/learning';
import { AI_MODE_ID, loadSectionsSettings, saveModeSettings } from '../src/core/modes';
import { contentLines, enforcePinned, getProfile, listProfileVersions, restoreProfileVersion, saveProfileEdit } from '../src/core/profile';
import { loadCentroids, loadStats } from '../src/core/ranking';
import { loadSections, whySection } from '../src/core/sections';
import { loadFeed } from '../src/core/feed';
import { loadSettings } from '../src/core/settings';
import { aiWorld, hnFixtures } from './helpers/ai';
import type { ChatPurpose } from './helpers/world';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
type W = Awaited<ReturnType<typeof aiWorld>>;

/** The model, scripted by headline: stories whose headline starts "Left:" are off-profile but high-impact. */
function script(s: W, tagsFor: (title: string) => string[] = () => ['coding agents']) {
  s.world.onChat = (purpose: ChatPurpose, user: string) => {
    if (purpose === 'enrich') {
      const blocks = user.split(/\n\n(?=ITEM )/);
      return JSON.stringify({ items: blocks.map((b) => {
        const id = /^ITEM (s\d+)/.exec(b)![1];
        const title = /Headline: (.*)/.exec(b)![1];
        const left = title.startsWith('Left:');
        return { id, headline: title.slice(0, 60), summary: `About ${title}.`, why: left ? '' : 'It fits your work.',
          tags: tagsFor(title), type: 'release', profile_match: left ? 0.05 : 0.85, impact: left ? 1 : 0.3, profile_lines: left ? [] : ['- Coding agents and tools'] };
      }) });
    }
    if (purpose === 'rescore') {
      const ids = Array.from(user.matchAll(/^ID (r\d+)$/gm)).map((m) => m[1]);
      return JSON.stringify({ items: ids.map((id) => ({ id, profile_match: 0.95, profile_lines: ['- Robots in warehouses'] })) });
    }
    return JSON.stringify({ markdown: '## Interested in\n- Something the model wrote\n\n## Not interested in\n\n## Sources I value\n\n## Notes\n' });
  };
}

/** Publishes stories for the day: `main` on-profile ones, and `left` significant off-profile ones (vendor release, big on HN). */
function publish(s: W, day: number, main: number, left: number, leftTag = 'robotics') {
  const stories = [
    ...Array.from({ length: main }, (_, i) => ({ title: `Day ${day} story ${i}`, topic: (day * 7 + i) % 30, hoursAgo: 1 + i * 0.1 })),
    ...Array.from({ length: left }, (_, i) => ({ title: `Left: day ${day} ${leftTag} ${i}`, topic: (day * 7 + 3 + i) % 30, hoursAgo: 1 + i * 0.1, url: `https://vendor.test/d${day}-left-${i}` })),
  ];
  s.world.addFeed(s.vendorFeed, stories.map((x) => ({ ...x, sim: 0.6 })));
  hnFixtures(s.world, Array.from({ length: left }, (_, i) => ({ id: day * 100 + i, title: `AI model news ${day} ${i}`, score: 600, url: `https://vendor.test/d${day}-left-${i}` })));
}

async function view(s: W) {
  const { sessionId } = await ensureSession(s.db, s.world.now);
  const v = await loadSections(s.db, AI_MODE_ID, sessionId, s.world.now);
  return { sessionId, main: v.sections[0].cards, other: v.sections[1].cards, v };
}

async function newSession(s: W) {
  await noteBackground(s.db, s.world.now);
  s.world.now += 11 * 60_000;
}

describe('the two sections', () => {
  test('"In other news" sits below the main section, shows 3 to 5, carries a reason label, and is hidden when nothing qualifies', async () => {
    const s = await aiWorld();
    script(s);
    publish(s, 1, 3, 6);
    await s.run();
    const { v, other, main } = await view(s);
    expect(v.sections.map((x) => x.def.type)).toEqual(['ranked', 'other_news']);
    expect(main).toHaveLength(3);
    expect(other).toHaveLength(4); // six qualify; the default is four
    expect(other.every((c) => c.reason && ['Widely covered', 'Major release', 'Trending on HN', 'High impact'].includes(c.reason))).toBe(true);
    expect(other.map((c) => c.significance)).toEqual(other.map((c) => c.significance).slice().sort((a, b) => b - a));
    expect(other.every((c) => c.why == null || c.why === '')).toBe(true);

    // Nothing qualifies: the section is empty (the screen hides it rather than padding it).
    const t = await aiWorld();
    script(t);
    publish(t, 1, 3, 0);
    await t.run();
    expect((await view(t)).other).toHaveLength(0);
  });

  test('main: by relevance; 15 to a page is the screen\'s job, the feed holds them all; seen cards stay for the session then go', async () => {
    const s = await aiWorld();
    script(s);
    publish(s, 1, 20, 0);
    await s.run();
    const { main, sessionId } = await view(s);
    expect(main).toHaveLength(20);
    expect((await loadSectionsSettings(s.db, AI_MODE_ID)).pageSize).toBe(15);
    await recordImpressions(s.db, main.slice(0, 15).map((c) => ({ articleId: c.article.id, surface: 'feed' as const })), sessionId, s.world.now);
    // Same session: all 20 still there, the seen ones first.
    const again = await view(s);
    expect(again.main).toHaveLength(20);
    expect(again.main.slice(0, 15).every((c) => c.seenAt != null)).toBe(true);
    expect(again.v.unseen).toBe(5);
    // Next session: only the five never revealed (so never seen) remain.
    await newSession(s);
    expect((await view(s)).main.map((c) => c.article.id)).toEqual(main.slice(15).map((c) => c.article.id));
  });

  test('ignoring "In other news" for two weeks does not stop the section appearing', async () => {
    const s = await aiWorld();
    script(s, (t) => (t.startsWith('Left:') ? ['robotics'] : ['coding agents']));
    for (let day = 1; day <= 14; day++) {
      publish(s, day, 2, 5);
      await s.run('manual');
      const { main, other, sessionId } = await view(s);
      expect([day, other.length >= 3]).toEqual([day, true]);
      // Everything goes past on screen and nothing is opened.
      await recordImpressions(s.db, [...main, ...other].map((c) => ({ articleId: c.article.id, surface: 'feed' as const })), sessionId, s.world.now);
      await newSession(s);
      s.world.now += DAY;
    }
    // It counted, barely: the left-field tag moved far less than the main one.
    const w = await loadWeights(s.db, AI_MODE_ID);
    expect(w.tags.get('robotics') ?? 0).toBeLessThan(0);
    expect(Math.abs(w.tags.get('robotics')!)).toBeLessThan(Math.abs(w.tags.get('coding agents')!));
  });

  test('"Why am I seeing this" shows the profile lines and tag weights behind the card', async () => {
    const s = await aiWorld();
    script(s);
    publish(s, 1, 1, 0);
    await s.run();
    const { main } = await view(s);
    await moreLikeThis(s.db, main[0].article.id, s.world.now);
    const lines = await whySection(s.db, main[0], AI_MODE_ID);
    expect(lines[0]).toBe('Your profile: "Coding agents and tools"');
    expect(lines).toContain('Topic "coding agents": learned weight +0.10');
  });
});

describe('signals and layer 1 weights', () => {
  test('each signal has its starting weight, recorded in the signal log, and moves tags and source by an EMA', async () => {
    const s = await aiWorld();
    script(s);
    publish(s, 1, 6, 0);
    await s.run();
    const { main, sessionId } = await view(s);
    const [a, b, c, d, e, f] = main.map((x) => x.article.id);
    await markInterested(s.db, a, s.world.now);
    await saveForLater(s.db, b, sessionId, s.world.now);
    await recordOpen(s.db, c, sessionId, 'feed', s.world.now);
    await recordReading(s.db, c, 400, 100, s.world.now); // read to the end
    await dismiss(s.db, d, sessionId, s.world.now);
    await lessBecause(s.db, e, 'source', sessionId, s.world.now);
    await recordImpressions(s.db, [{ articleId: f, surface: 'feed' }], sessionId, s.world.now);
    await newSession(s);
    await ensureSession(s.db, s.world.now);
    const log = (await recentSignals(s.db, AI_MODE_ID)).map((x) => [x.kind, x.weight]).sort();
    expect(log).toEqual([
      ['dismiss', -1], ['ignored', -0.15], ['interested', 1], ['less_source', -1], ['open', 0.4], ['read', 0.6], ['save', 0.7],
    ].sort());
    // Six signals touched "coding agents" (all but less_source); the EMA runs over them in order.
    let tag = 0;
    for (const w of [1, 0.7, 0.4, 0.6, -1, -0.15]) tag = 0.9 * tag + 0.1 * w;
    expect((await loadWeights(s.db, AI_MODE_ID)).tags.get('coding agents')).toBeCloseTo(tag, 10);
    // The source took all seven.
    let src = 0;
    for (const w of [1, 0.7, 0.4, 0.6, -1, -1, -0.15]) src = 0.9 * src + 0.1 * w;
    expect((await loadWeights(s.db, AI_MODE_ID)).sources.get(s.ids.Vendor)).toBeCloseTo(src, 10);
  });

  test('hidden counts as seen, not opened; in In other news that weighs a fifth', async () => {
    const s = await aiWorld();
    script(s, (t) => (t.startsWith('Left:') ? ['robotics'] : ['coding agents']));
    publish(s, 1, 1, 3);
    await s.run();
    const { main, other, sessionId } = await view(s);
    await hideArticle(s.db, main[0].article.id, sessionId, s.world.now);
    await hideArticle(s.db, other[0].article.id, sessionId, s.world.now);
    await newSession(s);
    await ensureSession(s.db, s.world.now);
    const log = await recentSignals(s.db, AI_MODE_ID);
    expect(log.map((x) => [x.kind, x.section, x.weight]).sort()).toEqual([['ignored', 'main', -0.15], ['ignored', 'other', -0.03]].sort());
  });

  test('undo takes a signal back', async () => {
    const s = await aiWorld();
    script(s);
    publish(s, 1, 1, 0);
    await s.run();
    const { main, sessionId } = await view(s);
    await dismiss(s.db, main[0].article.id, sessionId, s.world.now);
    expect((await loadWeights(s.db, AI_MODE_ID)).tags.get('coding agents')).toBeCloseTo(-0.1);
    await undoDismiss(s.db, main[0].article.id, s.world.now);
    expect((await loadWeights(s.db, AI_MODE_ID)).tags.get('coding agents')).toBeCloseTo(0, 10);
  });

  test('graduation: opening 3 left-field items with a shared tag raises that tag\'s weight, and the next rewrite is told', async () => {
    const s = await aiWorld();
    script(s, (t) => (t.startsWith('Left:') ? ['robotics'] : ['coding agents']));
    publish(s, 1, 1, 5);
    await s.run();
    const { other, sessionId } = await view(s);
    for (const c of other.slice(0, 2)) await recordOpen(s.db, c.article.id, sessionId, 'feed', s.world.now);
    const after2 = (await loadWeights(s.db, AI_MODE_ID)).tags.get('robotics')!;
    expect(after2).toBeCloseTo(0.9 * 0.04 + 0.04, 10); // two opens, EMA only
    await recordOpen(s.db, other[2].article.id, sessionId, 'feed', s.world.now);
    const after3 = (await loadWeights(s.db, AI_MODE_ID)).tags.get('robotics')!;
    expect(after3).toBeCloseTo(0.9 * after2 + 0.04 + 0.25, 10); // plus one graduation step
    expect(Object.keys((await loadSectionsSettings(s.db, AI_MODE_ID)).graduated)).toEqual(['robotics']);
    // A fourth open within the 30 days does not raise it again.
    await recordOpen(s.db, other[3].article.id, sessionId, 'feed', s.world.now);
    expect((await loadWeights(s.db, AI_MODE_ID)).tags.get('robotics')).toBeCloseTo(0.9 * after3 + 0.04, 10);
    // The rewrite is told to consider it.
    await saveModeSettings(s.db, AI_MODE_ID, { lastProfileRewriteAt: s.world.now - 8 * DAY, graduated: { robotics: s.world.now } });
    s.world.now += HOUR;
    await s.run('manual');
    expect(s.world.chatCalls.find((c) => c.purpose === 'profile')!.user).toContain('NEW INTERESTS TO CONSIDER (opened repeatedly from In other news): robotics');
  });

  test('a thumbs-down in AI changes no weight, profile or ranking in News, and the reverse', async () => {
    const s = await aiWorld();
    script(s);
    s.world.addGuardian([{ title: 'G: one', topic: 1, section: 'Politics' }, { title: 'G: two', topic: 2, section: 'Sport' }]);
    publish(s, 1, 2, 0);
    await s.run();
    const settings = await loadSettings(s.db);
    const { sessionId, main } = await view(s);
    const news = async () => ({
      stats: Array.from((await loadStats(s.db, s.world.now)).entries()),
      cents: await loadCentroids(s.db),
      feed: (await loadFeed(s.db, settings, sessionId, s.world.now)).map((c) => [c.article.id, c.score, c.match]),
      scores: await s.db.all('SELECT id, score_a, score_s FROM article WHERE mode_id = 1 ORDER BY id'),
    });
    const ai = async () => ({
      w: await loadWeights(s.db, AI_MODE_ID),
      profile: (await getProfile(s.db, AI_MODE_ID))!.markdown,
      order: (await view(s)).main.map((c) => [c.article.id, c.relevance]),
    });
    const newsBefore = await news();
    await dismiss(s.db, main[0].article.id, sessionId, s.world.now);
    await s.run('manual');
    expect(await news()).toEqual(newsBefore);

    const aiBefore = await ai();
    const g = (await s.db.get<{ id: number }>("SELECT id FROM article WHERE title = 'G: one'"))!.id;
    await dismiss(s.db, g, sessionId, s.world.now);
    await s.run('manual');
    expect(await ai()).toEqual(aiBefore);
  });
});

describe('layer 2: the interest profile', () => {
  test('lines he writes or edits are pinned; versions can be restored', async () => {
    const s = await aiWorld();
    const start = (await getProfile(s.db, AI_MODE_ID))!;
    const edited = start.markdown.replace('- Coding agents and tools', '- Coding agents, especially for code review').replace('## Notes', '## Notes\n- I run a team of 40 engineers.');
    const p = await saveProfileEdit(s.db, AI_MODE_ID, edited, s.world.now);
    expect(p.pinned.sort()).toEqual(['- Coding agents, especially for code review', '- I run a team of 40 engineers.']);
    expect(p.createdBy).toBe('user');
    const r = (await restoreProfileVersion(s.db, AI_MODE_ID, start.version, s.world.now + 1))!;
    expect(r.markdown).toBe(start.markdown);
    expect((await listProfileVersions(s.db, AI_MODE_ID)).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  test('pinned profile lines survive an LLM profile rewrite word for word', async () => {
    const s = await aiWorld();
    script(s);
    const start = (await getProfile(s.db, AI_MODE_ID))!;
    await saveProfileEdit(s.db, AI_MODE_ID, start.markdown.replace('## Not interested in', '## Not interested in\n- Crypto, in any form.'), s.world.now);
    publish(s, 1, 3, 0);
    await s.run();
    // 50 signals since the last rewrite make one due (the weekly rule is tested by the graduation case).
    const { main, sessionId } = await view(s);
    for (let i = 0; i < 50; i++) await s.db.run("INSERT INTO interaction(article_id, kind, at, weight, section) VALUES(?, 'open', ?, 0.4, 'main')", [main[i % 3].article.id, s.world.now]);
    void sessionId;
    // The model drops the pinned line entirely.
    s.world.now += HOUR;
    await s.run('manual');
    const p = (await getProfile(s.db, AI_MODE_ID))!;
    expect(p.createdBy).toBe('llm');
    expect(contentLines(p.markdown)).toContain('- Crypto, in any form.');
    expect(contentLines(p.markdown)).toContain('- Something the model wrote');
    expect(p.pinned).toEqual(['- Crypto, in any form.']);
    expect(p.markdown).toMatch(/## Not interested in\n- Crypto, in any form\./);
    // A reworded copy is replaced by the original.
    expect(enforcePinned('## Interested in\n- crypto in any form\n## Notes', '## Interested in\n- Crypto, in any form.', ['- Crypto, in any form.']))
      .toBe('## Interested in\n- Crypto, in any form.\n\n## Notes\n\n## Not interested in\n\n## Sources I value\n');
    expect((await loadSectionsSettings(s.db, AI_MODE_ID)).lastProfileRewriteAt).toBe(s.world.now);
  });

  test('after an edit, unseen stories are scored again against the new profile with a cheap batched call', async () => {
    const s = await aiWorld();
    script(s);
    publish(s, 1, 3, 0);
    await s.run();
    const before = (await view(s)).main.map((c) => c.relevance);
    await saveProfileEdit(s.db, AI_MODE_ID, (await getProfile(s.db, AI_MODE_ID))!.markdown + '\n- Robots in warehouses\n', s.world.now);
    s.world.now += HOUR;
    await s.run('manual');
    const calls = s.world.chatCalls.filter((c) => c.purpose === 'rescore');
    expect(calls).toHaveLength(1);
    expect((calls[0].user.match(/^ID /gm) ?? []).length).toBe(3);
    const after = (await view(s)).main;
    expect(after.every((c, i) => c.relevance > before[i])).toBe(true);
    expect(after[0].whyLines).toEqual(['- Robots in warehouses']);
  });

  test('learned weights alone: σ(mean tag weight + source weight)', () => {
    const w = { tags: new Map([['a', 0.5], ['b', -0.1]]), sources: new Map([[1, 0.2]]) };
    expect(learnedScore(['a', 'b'], 1, w)).toBeCloseTo(1 / (1 + Math.exp(-(0.2 + 0.2))));
    expect(learnedScore([], null, w)).toBe(0.5);
  });
});
