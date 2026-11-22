import { dismissBriefing, loadBriefing } from '../src/core/briefing';
import { loadCoverage } from '../src/core/coverage';
import {
  ensureSession, lessLikeThis, loadBubble, loadDigest, loadFeed, moreLikeThis, noteBackground, recordImpressions, recordReading,
} from '../src/core/feed';
import { forgetFeature, loadLearned, nudgeFeature, readingDiet } from '../src/core/learned';
import { loadSettings, saveSettings } from '../src/core/settings';
import { followStory, loadStories, loadStory, markStoryChecked, storyOfArticle, unfollowStory } from '../src/core/stories';
import { addRule, containsTerm, listRules, removeRule } from '../src/core/topics';
import { DAY } from '../src/core/types';
import { BudgetExceededError, type LlmDeps } from '../src/llm/openrouter';
import { compareCoverage, validateBriefing, validateCompare, validateStoryUpdate } from '../src/pipeline/extras';
import { HOUR, SRC, feedUrl, setup } from './helpers/world';

type S = Awaited<ReturnType<typeof setup>>;

const idOf = async (db: any, title: string) => (await db.get('SELECT id FROM article WHERE title = ?', [title])).id as number;

async function feedOf(s: S, now = s.world.now) {
  const { sessionId } = await ensureSession(s.db, now);
  return loadFeed(s.db, await loadSettings(s.db), sessionId, now);
}

async function llmOf(s: S): Promise<LlmDeps> {
  return { db: s.db, fetch: s.world.fetch, settings: await loadSettings(s.db), apiKey: 'sk-or-test-key-123456', now: () => s.world.now };
}

const spendBudget = async (s: S) => {
  await saveSettings(s.db, { monthlyBudgetUsd: 0.01 });
  await s.db.run("INSERT INTO llm_usage(at, model, purpose, input_tokens, output_tokens, cost_usd) VALUES(?, 'm', 'x', 1, 1, 0.02)", [s.world.now - HOUR]);
};

// ---------------------------------------------------------------- mute and watch

describe('mute and watch lists', () => {
  test('a term matches whole words and phrases, ignoring case, with a plural s', () => {
    expect(containsTerm('Rail strikes to go ahead', 'strike')).toBe(true);
    expect(containsTerm('The MANSION  tax row', 'mansion tax')).toBe(false); // two spaces in the text: not the phrase
    expect(containsTerm('The Mansion Tax row', 'mansion tax')).toBe(true);
    expect(containsTerm('Labour party conference', 'art')).toBe(false);
    expect(containsTerm('Art prize announced', 'art')).toBe(true);
    expect(containsTerm('anything', '  ')).toBe(false);
  });

  test('a muted term hides matching stories from For you until it expires', async () => {
    const s = await setup([]);
    s.world.addGuardian([
      { title: 'Strictly final draws record audience', topic: 1, hoursAgo: 1 },
      { title: 'Budget day arrives', topic: 2, hoursAgo: 2, tags: ['Strictly speaking'] },
      { title: 'Storm warning issued', topic: 3, hoursAgo: 3 },
    ]);
    await s.run();
    expect((await feedOf(s)).map((c) => c.article.title)).toHaveLength(3);

    await addRule(s.db, 'mute', 'strictly', s.world.now + DAY, s.world.now);
    // Headline and topic tag both count.
    expect((await feedOf(s)).map((c) => c.article.title)).toEqual(['Storm warning issued']);
    // Past its end the rule no longer applies, and no longer lists.
    expect((await feedOf(s, s.world.now + DAY + 1)).map((c) => c.article.title)).toHaveLength(3);
    expect(await listRules(s.db, s.world.now + DAY + 1)).toEqual([]);
  });

  test('muting also covers Right press and Outside your bubble', async () => {
    const s = await setup();
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: hotel protest grows', topic: 5 }]);
    s.world.addFeed(feedUrl('Daily Express'), [{ title: 'Express: fury at hotel plan', topic: 5 }]);
    await s.run();
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const settings = await loadSettings(s.db);
    expect(await loadDigest(s.db, settings, sessionId, s.world.now)).toHaveLength(1);
    // One outlet's wording is enough to mute the story.
    await addRule(s.db, 'mute', 'hotel protest', null, s.world.now);
    expect(await loadDigest(s.db, settings, sessionId, s.world.now)).toHaveLength(0);
    await addRule(s.db, 'mute', 'budget', null, s.world.now);
    expect(await loadBubble(s.db, settings, sessionId, s.world.now)).toEqual([]);
    expect(await loadFeed(s.db, settings, sessionId, s.world.now)).toEqual([]);
  });

  test('a watched term lifts matching stories to the top and brings them in from other sources, one per story', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre'), SRC.rss('Daily Mail', 'right')]);
    s.world.addGuardian([
      { title: 'G: fresh story', topic: 1, hoursAgo: 1 },
      { title: 'G: another fresh story', topic: 3, hoursAgo: 1.5 },
      { title: 'G: mansion tax plan criticised', topic: 2, hoursAgo: 30 },
    ]);
    s.world.addFeed(feedUrl('Daily Mail'), [
      { title: 'Mail: mansion tax revolt', topic: 2, hoursAgo: 3 }, // the Guardian card carries this story
      { title: 'Mail: who pays the mansion tax', topic: 9, hoursAgo: 2 },
      { title: 'Mail: unrelated', topic: 11, hoursAgo: 2 },
    ]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: mansion tax explained', topic: 9, hoursAgo: 4 }]);
    s.world.onChat = () => JSON.stringify({ match_id: null, same_event: false, angle_note: '' });
    await s.run();

    // Without the rule: Guardian only, the old piece last.
    expect((await feedOf(s)).map((c) => c.article.title)).toEqual(['G: fresh story', 'G: another fresh story', 'G: mansion tax plan criticised']);

    await addRule(s.db, 'watch', 'Mansion Tax', null, s.world.now);
    const feed = await feedOf(s);
    const watched = feed.filter((c) => c.watch);
    expect(watched.map((c) => c.watch)).toEqual(['Mansion Tax', 'Mansion Tax']);
    // The Guardian's own piece, and one piece (the newest) on the story no primary source ran.
    expect(watched.map((c) => c.article.title).sort()).toEqual(['G: mansion tax plan criticised', 'Mail: who pays the mansion tax']);
    expect(feed.slice(0, 2).every((c) => c.watch)).toBe(true);
    expect(feed.map((c) => c.article.title)).not.toContain('Mail: unrelated');
    // An article the scorer never reached is not passed off as a good fit.
    expect(feed.find((c) => c.sourceName === 'Daily Mail')!.goodFit).toBe(false);

    // Seen rule as for any card: gone in the next session.
    const s1 = await ensureSession(s.db, s.world.now);
    await recordImpressions(s.db, watched.map((c) => ({ articleId: c.article.id, surface: 'feed' as const })), s1.sessionId, s.world.now);
    const s2 = await ensureSession(s.db, s.world.now + 1000, true);
    const later = await loadFeed(s.db, await loadSettings(s.db), s2.sessionId, s.world.now + 1000);
    expect(later.filter((c) => c.watch)).toEqual([]);
  });

  test('a term has one rule at a time, and can be removed', async () => {
    const s = await setup([]);
    await addRule(s.db, 'mute', 'cricket', null, s.world.now);
    const id = await addRule(s.db, 'watch', 'Cricket', s.world.now + DAY, s.world.now + 1);
    const rules = await listRules(s.db, s.world.now + 2);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: 'watch', term: 'Cricket', expiresAt: s.world.now + DAY });
    expect(await addRule(s.db, 'mute', ' x ', null, s.world.now)).toBeNull(); // too short
    await removeRule(s.db, id!);
    expect(await listRules(s.db, s.world.now + 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------- follow a story

describe('following a story', () => {
  async function inquiry() {
    const s = await setup([SRC.rss('BBC News', 'centre'), SRC.rss('Daily Mail', 'right')]);
    s.world.addGuardian([{ title: 'G: inquiry opens', topic: 1, hoursAgo: 2 }, { title: 'G: other news', topic: 2, hoursAgo: 2 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: inquiry opens', topic: 1, hoursAgo: 2 }]);
    await s.run();
    const articleId = await idOf(s.db, 'G: inquiry opens');
    const storyId = await followStory(s.db, articleId, (await loadSettings(s.db)).followThreshold, s.world.now);
    return { s, articleId, storyId };
  }
  const storyCalls = (s: S) => s.world.chatCalls.filter((c) => c.purpose === 'story');

  test('what is already published joins as background; what comes next is new, with a note on what changed', async () => {
    const { s, articleId, storyId } = await inquiry();
    let [st] = await loadStories(s.db);
    expect(st).toMatchObject({ id: storyId, title: 'G: inquiry opens', articleCount: 2, newCount: 0, updateSummary: null });
    expect(await storyOfArticle(s.db, articleId)).toBe(storyId);
    // Following again returns the same story.
    expect(await followStory(s.db, await idOf(s.db, 'BBC: inquiry opens'), 0.62, s.world.now)).toBe(storyId);
    expect((await feedOf(s)).find((c) => c.article.id === articleId)!.following).toBe(true);

    // Next day: a development, too far from the first reports to be the "same event", and an unrelated story.
    s.world.now += 20 * HOUR;
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: inquiry hears first witness', topic: 1, sim: 0.7, hoursAgo: 1 }]);
    s.world.addGuardian([{ title: 'G: unrelated', topic: 7, hoursAgo: 1 }]);
    const res = await s.run();
    expect(res.steps.find((x) => x.name.startsWith('7b'))!.info).toMatch(/1 followed: 1 articles joined, 1 updates written/);
    const mail = await s.db.get<any>("SELECT cluster_id FROM article WHERE title = 'Mail: inquiry hears first witness'");
    const guardian = await s.db.get<any>("SELECT cluster_id FROM article WHERE title = 'G: inquiry opens'");
    expect(mail.cluster_id).not.toBe(guardian.cluster_id);

    [st] = await loadStories(s.db);
    expect(st).toMatchObject({
      articleCount: 3, newCount: 1, newOutlets: 1, latestTitle: 'Mail: inquiry hears first witness',
      updateSummary: 'The new coverage reports a further development in the story.',
    });
    expect(storyCalls(s)).toHaveLength(1);
    const prompt = storyCalls(s)[0].user;
    expect(prompt.indexOf('G: inquiry opens')).toBeLessThan(prompt.indexOf('NEW coverage'));
    expect(prompt.indexOf('Mail: inquiry hears first witness')).toBeGreaterThan(prompt.indexOf('NEW coverage'));
    expect(prompt).not.toContain('G: unrelated');

    // Nothing more arrived: the note is not written again.
    s.world.now += HOUR;
    await s.run();
    expect(storyCalls(s)).toHaveLength(1);

    const detail = (await loadStory(s.db, storyId))!;
    expect(detail.fresh.map((r) => r.article.title)).toEqual(['Mail: inquiry hears first witness']);
    expect(detail.earlier.map((r) => r.article.title).sort()).toEqual(['BBC: inquiry opens', 'G: inquiry opens']);

    // Opening it: nothing is new any more.
    await markStoryChecked(s.db, storyId, s.world.now);
    [st] = await loadStories(s.db);
    expect(st).toMatchObject({ newCount: 0, updateSummary: null, articleCount: 3 });

    await unfollowStory(s.db, storyId);
    expect(await loadStories(s.db)).toEqual([]);
    expect(await storyOfArticle(s.db, articleId)).toBeNull();
  });

  test('a second report of the same event as a new article joins with it', async () => {
    const { s } = await inquiry();
    s.world.now += 20 * HOUR;
    // The Mail's piece is close enough to the story; the BBC's is the same event as the Mail's but further from the start.
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: minister resigns over inquiry', topic: 40, hoursAgo: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: minister resigns', topic: 40, hoursAgo: 1 }]);
    await s.run();
    expect((await loadStories(s.db))[0].newCount).toBe(0); // a different story altogether: nothing joins

    const mailId = await idOf(s.db, 'Mail: minister resigns over inquiry');
    const story = (await loadStories(s.db))[0];
    await s.db.run('INSERT INTO story_article(story_id, article_id, added_at) VALUES(?,?,?)', [story.id, mailId, s.world.now]);
    s.world.now += HOUR;
    await s.run();
    const detail = (await loadStory(s.db, story.id))!;
    expect(detail.fresh.map((r) => r.article.title).sort()).toEqual(['BBC: minister resigns', 'Mail: minister resigns over inquiry']);
  });

  test('at the budget cap the story still gathers articles and shows the newest headline', async () => {
    const { s } = await inquiry();
    await spendBudget(s);
    s.world.now += 20 * HOUR;
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: inquiry hears first witness', topic: 1, sim: 0.7, hoursAgo: 1 }]);
    const before = s.world.chatCalls.length;
    const res = await s.run();
    expect(s.world.chatCalls.length).toBe(before);
    expect(res.steps.find((x) => x.name.startsWith('7b'))!.info).toMatch(/budget reached/);
    expect((await loadStories(s.db))[0]).toMatchObject({ newCount: 1, updateSummary: null, latestTitle: 'Mail: inquiry hears first witness' });
  });

  test('an update must be a short piece of text', () => {
    expect(validateStoryUpdate({ summary: ' A witness gave evidence. ' })).toEqual({ summary: 'A witness gave evidence.' });
    expect(validateStoryUpdate({ summary: '' })).toBeNull();
    expect(validateStoryUpdate({ summary: 'word '.repeat(61) })).toBeNull();
    expect(validateStoryUpdate(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- full coverage

describe('full coverage', () => {
  async function budget() {
    const s = await setup();
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }, { title: 'G: alone', topic: 2 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: budget', topic: 1 }, { title: 'Mail: something else', topic: 6 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1 }]);
    await s.run();
    return s;
  }

  test('lists every outlet on the story, ordered along the leans, and counts them', async () => {
    const s = await budget();
    const id = await idOf(s.db, 'G: budget');
    const cov = (await loadCoverage(s.db, id))!;
    expect(cov.rows.map((r) => r.article.title)).toEqual(['G: budget', 'BBC: budget', 'Mail: budget']);
    expect(cov.rows.map((r) => r.isThis)).toEqual([true, false, false]);
    expect(cov.outletCount).toBe(3);
    expect(cov.note).toBeNull();
    // The same story from any of its articles, and the count on the feed card.
    expect((await loadCoverage(s.db, await idOf(s.db, 'Mail: budget')))!.rows).toHaveLength(3);
    expect((await feedOf(s)).find((c) => c.article.id === id)!.outletCount).toBe(3);
    expect(await loadCoverage(s.db, 99999)).toBeNull();
  });

  test('a confirmed second source outside the cluster is part of the coverage', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'G: storm', topic: 2 }]);
    // Close enough to be a candidate (0.70), not to share the cluster (0.75); the model confirms it.
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: storm, loosely', topic: 2, sim: 0.72 }]);
    await s.run();
    const cov = (await loadCoverage(s.db, await idOf(s.db, 'G: storm')))!;
    expect(cov.rows.map((r) => r.sourceName)).toEqual(['Guardian', 'BBC News']);
  });

  test('comparing writes one note, stores it, and sends only outlet names, headlines and summaries', async () => {
    const s = await budget();
    const id = await idOf(s.db, 'G: budget');
    const note = await compareCoverage(await llmOf(s), id);
    expect(note).toMatchObject({ agree: 'All report the same announcement.', differ: 'One leads on cost; another on the reaction.', outlets: 3 });
    const calls = s.world.chatCalls.filter((c) => c.purpose === 'compare');
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain('Outlet: Daily Mail\nHeadline: Mail: budget');
    expect(calls[0].user).not.toMatch(/\b(left|right|centre)\b/i); // leans are settings, never sent or shown
    expect((await loadCoverage(s.db, id))!.note).toMatchObject({ agree: note.agree, outlets: 3 });
    const usage = await s.db.get<any>("SELECT COUNT(*) n FROM llm_usage WHERE purpose = 'compare'");
    expect(usage.n).toBe(1);
  });

  test('nothing to compare with one outlet; nothing is called at the budget cap', async () => {
    const s = await budget();
    await expect(compareCoverage(await llmOf(s), await idOf(s.db, 'G: alone'))).rejects.toThrow(/Only one outlet/);
    await spendBudget(s);
    await expect(compareCoverage(await llmOf(s), await idOf(s.db, 'G: budget'))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(s.world.chatCalls.filter((c) => c.purpose === 'compare')).toHaveLength(0);
  });

  test('a comparison needs both notes, each short', () => {
    expect(validateCompare({ agree: 'a', differ: 'b' })).toEqual({ agree: 'a', differ: 'b' });
    expect(validateCompare({ agree: 'a', differ: '' })).toBeNull();
    expect(validateCompare({ agree: 'w '.repeat(61), differ: 'b' })).toBeNull();
  });
});

// ---------------------------------------------------------------- catch-up briefing

describe('catch-up briefing', () => {
  /** A first refresh, the app goes to the background, and `hours` later there is news and it comes back. */
  async function away(hours: number, prepare?: (s: S) => Promise<void>) {
    const s = await setup();
    s.world.addGuardian([{ title: 'G: old news', topic: 20, hoursAgo: 3 }]);
    await s.run();
    await ensureSession(s.db, s.world.now);
    const leftAt = s.world.now;
    await noteBackground(s.db, leftAt);
    s.world.now += hours * HOUR;
    s.world.addGuardian([{ title: 'G: budget', topic: 1, hoursAgo: 2 }, { title: 'G: only us', topic: 3, hoursAgo: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1, hoursAgo: 2 }, { title: 'BBC: Strictly row', topic: 4, hoursAgo: 1 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [
      { title: 'Mail: budget', topic: 1, hoursAgo: 2 }, { title: 'Mail: hotel protest', topic: 5, hoursAgo: 1 },
      { title: 'Mail: Strictly row', topic: 4, hoursAgo: 1 },
    ]);
    s.world.addFeed(feedUrl('Daily Express'), [{ title: 'Express: hotel protest', topic: 5, hoursAgo: 1 }]);
    if (prepare) await prepare(s);
    await ensureSession(s.db, s.world.now);
    return { s, leftAt };
  }
  const briefingCalls = (s: S) => s.world.chatCalls.filter((c) => c.purpose === 'briefing');

  test('back after a long gap: the most widely covered stories from the time away, one sentence each', async () => {
    const { s, leftAt } = await away(12, (x) => addRule(x.db, 'mute', 'strictly', null, x.world.now).then(() => {}));
    expect((await loadSettings(s.db)).briefingSince).toBe(leftAt);
    expect(await loadBriefing(s.db, s.world.now)).toBeNull(); // written by the refresh

    const res = await s.run('open');
    expect(res.steps.find((x) => x.name.startsWith('7c'))!.info).toMatch(/2 stories .* 1 LLM call/);
    const b = (await loadBriefing(s.db, s.world.now))!;
    expect(b.sinceAt).toBe(leftAt);
    // Three outlets before two; one-outlet and muted stories are left out; the primary's piece is the one to open.
    expect(b.items.map((i) => [i.headline.replace(/^(Mail|Express)/, 'Tabloid'), i.outletCount, i.sentence])).toEqual([
      ['G: budget', 3, 'Outlets report story s1.'],
      ['Tabloid: hotel protest', 2, 'Outlets report story s2.'],
    ]);
    expect(b.items[0].articleId).toBe(await idOf(s.db, 'G: budget'));
    expect(briefingCalls(s)).toHaveLength(1);
    expect(briefingCalls(s)[0].user).not.toContain('old news');
    expect((await loadSettings(s.db)).briefingSince).toBe(0);

    // Not written twice, and gone once dismissed.
    s.world.now += HOUR;
    await s.run();
    expect((await s.db.get<any>('SELECT COUNT(*) n FROM briefing')).n).toBe(1);
    await dismissBriefing(s.db, b.id, s.world.now);
    expect(await loadBriefing(s.db, s.world.now)).toBeNull();
  });

  test('a short absence, a pull-to-refresh, or the setting switched off: no briefing', async () => {
    const short = await away(3);
    expect((await loadSettings(short.s.db)).briefingSince).toBe(0);
    await short.s.run('open');
    expect(await loadBriefing(short.s.db, short.s.world.now)).toBeNull();
    expect(briefingCalls(short.s)).toHaveLength(0);
    // Pull-to-refresh starts a session but is not a return to the app.
    await ensureSession(short.s.db, short.s.world.now + 20 * HOUR, true);
    expect((await loadSettings(short.s.db)).briefingSince).toBe(0);

    const off = await away(12, (x) => saveSettings(x.db, { briefingEnabled: false }));
    expect((await loadSettings(off.s.db)).briefingSince).toBe(0);
    await off.s.run('open');
    expect(await loadBriefing(off.s.db, off.s.world.now)).toBeNull();
  });

  test('at the budget cap the briefing shows headlines', async () => {
    const { s } = await away(12, spendBudget);
    const res = await s.run('open');
    expect(res.steps.find((x) => x.name.startsWith('7c'))!.info).toMatch(/headlines only/);
    const b = (await loadBriefing(s.db, s.world.now))!;
    expect(b.items.map((i) => i.sentence)).toEqual([null, null, null]);
    expect(b.items[0].headline).toBe('G: budget');
    expect(briefingCalls(s)).toHaveLength(0);
    // It leaves the top of the feed by itself after a day.
    expect(await loadBriefing(s.db, s.world.now + DAY + 1)).toBeNull();
  });

  test('the model must answer for every story, briefly', () => {
    const ok = { items: [{ id: 's1', sentence: 'One.' }, { id: 's2', sentence: 'Two.' }] };
    expect(validateBriefing(ok, ['s1', 's2'])).toEqual({ s1: 'One.', s2: 'Two.' });
    expect(validateBriefing({ items: [ok.items[0]] }, ['s1', 's2'])).toBeNull();
    expect(validateBriefing({ items: [{ id: 's9', sentence: 'x' }] }, ['s1'])).toBeNull();
    expect(validateBriefing({ items: [{ id: 's1', sentence: 'w '.repeat(41) }] }, ['s1'])).toBeNull();
  });
});

// ---------------------------------------------------------------- what the app has learned

describe('what the app has learned', () => {
  async function taught() {
    const s = await setup([]);
    s.world.addGuardian([
      { title: 'Rugby final', topic: 1, section: 'Sport', tags: ['Rugby union'] },
      { title: 'Budget row', topic: 2, section: 'Politics', tags: ['Tax'] },
    ]);
    await s.run();
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const rugby = await idOf(s.db, 'Rugby final');
    const budget = await idOf(s.db, 'Budget row');
    await moreLikeThis(s.db, rugby, s.world.now);
    await lessLikeThis(s.db, budget, sessionId, s.world.now);
    return { s, rugby, budget };
  }
  const group = (groups: Awaited<ReturnType<typeof loadLearned>>, kind: string) => groups.find((g) => g.kind === kind)!;

  test('lists likes and dislikes in plain words; one can be forgotten or pushed the other way', async () => {
    const { s } = await taught();
    let groups = await loadLearned(s.db, s.world.now);
    expect(group(groups, 'section').liked.map((i) => i.label)).toEqual(['Sport']);
    expect(group(groups, 'section').disliked.map((i) => i.label)).toEqual(['Politics']);
    expect(group(groups, 'tag').liked.map((i) => i.label)).toContain('Rugby Union');
    expect(group(groups, 'tag').disliked.map((i) => i.label)).toContain('Tax');

    await forgetFeature(s.db, 'section:sport', s.world.now);
    groups = await loadLearned(s.db, s.world.now);
    expect(group(groups, 'section').liked).toEqual([]);

    // Two "More" outweigh the one "Less like this".
    await nudgeFeature(s.db, 'section:politics', 1, s.world.now);
    await nudgeFeature(s.db, 'section:politics', 1, s.world.now);
    groups = await loadLearned(s.db, s.world.now);
    expect(group(groups, 'section').liked.map((i) => i.label)).toEqual(['Politics']);
    expect(group(groups, 'section').disliked).toEqual([]);
  });

  test('a card merely scrolled past does not show up as a dislike', async () => {
    const s = await setup([]);
    s.world.addGuardian([{ title: 'Quiet story', topic: 1, section: 'Culture' }]);
    await s.run();
    const s1 = await ensureSession(s.db, s.world.now);
    await recordImpressions(s.db, [{ articleId: await idOf(s.db, 'Quiet story'), surface: 'feed' }], s1.sessionId, s.world.now);
    await ensureSession(s.db, s.world.now + 1000, true); // the session ends: "shown, not opened"
    expect((await s.db.get<any>("SELECT COUNT(*) n FROM feature_stat WHERE negative_weight > 0")).n).toBeGreaterThan(0);
    expect(await loadLearned(s.db, s.world.now + 1000)).toEqual([]);
  });

  test('forgetting a preference re-ranks what is waiting in the feed', async () => {
    const { s, rugby } = await taught();
    await saveSettings(s.db, { coldStartDays: 0 });
    await nudgeFeature(s.db, 'section:sport', 1, s.world.now); // also rescored
    const liked = (await s.db.get<any>('SELECT score_a FROM article WHERE id = ?', [rugby])).score_a;
    await forgetFeature(s.db, 'section:sport', s.world.now);
    const after = (await s.db.get<any>('SELECT score_a FROM article WHERE id = ?', [rugby])).score_a;
    expect(after).toBeLessThan(liked);
  });

  test('reading diet: articles read this week and last, by section, source and lean', async () => {
    const { s, rugby, budget } = await taught();
    await recordReading(s.db, rugby, 60, 80, s.world.now - 9 * DAY); // last week
    await recordReading(s.db, budget, 60, 80, s.world.now - DAY);
    await recordReading(s.db, budget, 50, 90, s.world.now - HOUR); // the same article again: counted once
    const diet = await readingDiet(s.db, s.world.now);
    expect(diet).toMatchObject({ thisWeek: 1, lastWeek: 1 });
    expect(diet.sections).toEqual([
      { label: 'Politics', thisWeek: 1, lastWeek: 0 },
      { label: 'Sport', thisWeek: 0, lastWeek: 1 },
    ]);
    expect(diet.sources).toEqual([{ label: 'Guardian', thisWeek: 1, lastWeek: 1 }]);
    expect(diet.leans).toEqual([{ label: 'left', thisWeek: 1, lastWeek: 1 }]);
  });
});

// ---------------------------------------------------------------- housekeeping

describe('retention of the new tables', () => {
  test('old briefings, comparisons and expired rules go; followed stories lose only the articles that were deleted', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'G: inquiry opens', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: inquiry opens', topic: 1 }]);
    await s.run();
    const storyId = await followStory(s.db, await idOf(s.db, 'G: inquiry opens'), 0.62, s.world.now);
    await addRule(s.db, 'mute', 'cricket', s.world.now + DAY, s.world.now);
    await addRule(s.db, 'watch', 'tax', null, s.world.now);
    await s.db.run("INSERT INTO briefing(created_at, since_at, items) VALUES(?, ?, '[]')", [s.world.now, s.world.now - DAY]);
    await s.db.run("INSERT INTO coverage_note(key, agree, differ, outlets, at) VALUES('c1', 'a', 'b', 2, ?)", [s.world.now]);

    s.world.now += 20 * DAY;
    s.world.feeds.clear();
    s.world.guardian = [];
    await s.run();
    expect((await s.db.get<any>('SELECT COUNT(*) n FROM article')).n).toBe(0);
    expect((await s.db.get<any>('SELECT COUNT(*) n FROM story_article')).n).toBe(0);
    expect((await s.db.get<any>('SELECT COUNT(*) n FROM briefing')).n).toBe(0);
    expect((await s.db.get<any>('SELECT COUNT(*) n FROM coverage_note')).n).toBe(0);
    expect((await s.db.all<any>('SELECT term FROM topic_rule')).map((r) => r.term)).toEqual(['tax']);
    // The story itself stays followed until you stop following it.
    expect((await loadStories(s.db)).map((st) => [st.id, st.articleCount])).toEqual([[storyId, 0]]);
  });
});
