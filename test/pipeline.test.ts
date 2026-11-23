import { ensureSession, loadDigest, loadFeed } from '../src/core/feed';
import { loadSettings, saveSettings } from '../src/core/settings';
import { getSource, updateSource } from '../src/core/sources';
import { monthSpend, overBudget, extractJson } from '../src/llm/openrouter';
import { SCORE_STEP, isRefreshing, listRuns } from '../src/pipeline/refresh';
import { LLM_CONCURRENCY, orderCandidates, validateDigest, validateMatch, type Candidate } from '../src/pipeline/steps';
import { countWords } from '../src/core/util';
import { DAY } from '../src/core/types';
import { HOUR, SRC, feedUrl, setup } from './helpers/world';

async function view(s: Awaited<ReturnType<typeof setup>>, forceNew = false) {
  const { sessionId } = await ensureSession(s.db, s.world.now, forceNew);
  const settings = await loadSettings(s.db);
  return {
    sessionId,
    feed: await loadFeed(s.db, settings, sessionId, s.world.now),
    digest: await loadDigest(s.db, settings, sessionId, s.world.now),
  };
}

describe('refresh pipeline', () => {
  test('runs every step, de-duplicates on canonical URL and records the run', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'Guardian story', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC story', topic: 2 }]);
    // A second feed of the same source carrying the same article with different tracking parameters.
    const bbc = (await getSource(s.db, s.ids['BBC News']))!;
    await updateSource(s.db, bbc.id, { ...bbc, endpoint: `${feedUrl('BBC News')}\nhttps://bbc-news.test/politics.xml` });
    s.world.feeds.set('https://bbc-news.test/politics.xml', s.world.feeds.get(feedUrl('BBC News'))!);
    const res = await s.run();
    expect(res.steps.map((x) => x.name[0])).toEqual(['1', '3', '4', '5', '6', '7', '7', '7', '8', '9']);
    expect(res.steps.every((x) => x.ok)).toBe(true);
    expect(res.newArticles).toBe(2);
    expect((await s.db.get<{ n: number }>('SELECT COUNT(*) n FROM article'))!.n).toBe(2);
    expect((await s.db.get<{ n: number }>('SELECT COUNT(*) n FROM article WHERE embedding IS NOT NULL AND cluster_id IS NOT NULL'))!.n).toBe(2);
    // A second refresh adds nothing.
    s.world.now += HOUR;
    expect((await s.run()).newArticles).toBe(0);
    const runs = await listRuns(s.db);
    expect(runs).toHaveLength(2);
    expect(runs[0].finishedAt).not.toBeNull();
    expect(isRefreshing()).toBe(false);
  });

  test('a failed step is logged and skipped; the steps after it still run', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'Guardian story', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC story', topic: 2 }]);
    await s.secrets.remove('openrouter_api_key');
    const res = await s.run();
    const embed = res.steps.find((x) => x.name.startsWith('3'))!;
    expect(embed.ok).toBe(false);
    expect(embed.error).toMatch(/OpenRouter key/);
    expect(res.steps.find((x) => x.name === SCORE_STEP)!.ok).toBe(true);
    // The feed still shows the articles, ordered by freshness.
    expect((await view(s)).feed).toHaveLength(1);
    // Embedding catches up once a key is present.
    await s.secrets.set('openrouter_api_key', 'sk-or-test-key-123456');
    s.world.now += HOUR;
    await s.run();
    expect((await s.db.get<{ n: number }>('SELECT COUNT(*) n FROM article WHERE embedding IS NULL'))!.n).toBe(0);
  });

  test('a new card joins the feed once its own second-source check is done, never before', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1 }]);
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const settings = await loadSettings(s.db);
    const feeds: Record<string, Promise<any[]>> = {};
    s.deps.onStep = (step) => {
      feeds[step.name[0]] = loadFeed(s.db, settings, sessionId, s.world.now);
    };
    await s.run();
    expect(await feeds['1']).toHaveLength(0); // fetched, not yet offered
    expect(await feeds['4']).toHaveLength(0); // clustered, not yet checked
    const afterCheck = await feeds['5'];
    expect(afterCheck).toHaveLength(1); // checked: in the feed before the run ends
    expect(afterCheck[0].second).toMatchObject({ sourceName: 'BBC News' });
  });

  test('new cards stream in batches during the run, each only after its own check', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    const stories = Array.from({ length: 24 }, (_, i) => ({ title: `G story ${i}`, topic: 100 + i, hoursAgo: 1 + i * 0.2 }));
    s.world.addGuardian(stories);
    s.world.addFeed(feedUrl('BBC News'), stories.slice(0, 12).map((g, i) => ({ title: `BBC story ${i}`, topic: g.topic })));
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const settings = await loadSettings(s.db);
    const batches: Promise<{ shown: number; unchecked: number }>[] = [];
    let stepsDone = 0;
    const doneAtBatch: number[] = [];
    s.deps.onStep = () => { stepsDone++; };
    s.deps.onArticlesReady = () => {
      doneAtBatch.push(stepsDone);
      batches.push((async () => {
        const feed = await loadFeed(s.db, settings, sessionId, s.world.now);
        const unchecked = await s.db.get<{ n: number }>(
          `SELECT COUNT(*) n FROM article a JOIN source src ON src.id = a.source_id AND src.role = 'primary'
           LEFT JOIN second_source ss ON ss.primary_article_id = a.id
           WHERE a.ready_at IS NOT NULL AND ss.primary_article_id IS NULL`,
        );
        return { shown: feed.length, unchecked: unchecked!.n };
      })());
    };
    await s.run();
    const seen = await Promise.all(batches);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((b) => b.unchecked === 0)).toBe(true); // nothing shown before its check
    expect(seen[0].shown).toBeLessThan(24); // the first cards arrive before the rest are checked
    expect(doneAtBatch[0]).toBe(3); // three steps finished: during step 5, not after the run
    expect((await loadFeed(s.db, settings, sessionId, s.world.now)).length).toBe(24);
  });

  test('only one refresh runs at a time', async () => {
    const s = await setup([]);
    s.world.addGuardian([{ title: 'Guardian story', topic: 1 }]);
    const [a, b] = await Promise.all([s.run(), s.run()]);
    expect(a.runId).toBe(b.runId);
    expect(await listRuns(s.db)).toHaveLength(1);
  });

  test('clusters join articles on the same event and count distinct outlets', async () => {
    const s = await setup();
    s.world.addGuardian([{ title: 'G: minister resigns', topic: 1 }, { title: 'G: storm', topic: 2 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: minister resigns', topic: 1 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: minister resigns', topic: 1 }, { title: 'Mail: minister resigns, reaction', topic: 1 }]);
    await s.run();
    const clusters = await s.db.all<any>('SELECT size, outlet_count, has_primary FROM cluster ORDER BY size DESC');
    expect(clusters[0]).toMatchObject({ size: 4, outlet_count: 3, has_primary: 1 });
    expect(clusters[1]).toMatchObject({ size: 1, outlet_count: 1 });
  });

  test('retention removes articles after 14 days but keeps Read later items and learning', async () => {
    const s = await setup([]);
    s.world.addGuardian([{ title: 'Old story', topic: 1 }, { title: 'Old but saved', topic: 2 }]);
    await s.run();
    const saved = await s.db.get<{ id: number }>("SELECT id FROM article WHERE title = 'Old but saved'");
    await s.db.run('INSERT INTO read_later(article_id, saved_at) VALUES(?, ?)', [saved!.id, s.world.now]);
    await s.db.run("INSERT INTO interaction(article_id, kind, at) VALUES(1, 'read', ?)", [s.world.now]);
    s.world.guardian = [];
    s.world.now += 15 * DAY;
    await s.run();
    expect((await s.db.all<{ title: string }>('SELECT title FROM article')).map((r) => r.title)).toEqual(['Old but saved']);
    expect((await s.db.get<{ n: number }>('SELECT COUNT(*) n FROM interaction'))!.n).toBe(1);
  });
});

describe('second source matching', () => {
  const cand = (over: Partial<Candidate>): Candidate => ({
    id: 1, sourceId: 1, sourceName: 'X', lean: 'centre', title: 't', summary: '', body: null, similarity: 0.7, ...over,
  });

  test('prefers the lean furthest from the primary, ties by similarity', () => {
    const cands = [
      cand({ id: 1, sourceName: 'BBC News', lean: 'centre', similarity: 0.9 }),
      cand({ id: 2, sourceName: 'Daily Mail', lean: 'right', similarity: 0.72 }),
      cand({ id: 3, sourceName: 'The Telegraph', lean: 'right', similarity: 0.8 }),
      cand({ id: 4, sourceName: 'Mirror', lean: 'centre-left', similarity: 0.95 }),
    ];
    expect(orderCandidates(cands, 'left').map((c) => c.id)).toEqual([3, 2, 1, 4]);
    expect(orderCandidates(cands, 'right').map((c) => c.id)).toEqual([4, 1, 3, 2]);
  });

  test('answer validation: schema, known id and a 20-word limit', () => {
    const ids = ['c1', 'c2'];
    expect(validateMatch({ match_id: 'c2', same_event: true, angle_note: 'Leads on cost.' }, ids)).toMatchObject({ match_id: 'c2' });
    expect(validateMatch({ match_id: null, same_event: false, angle_note: '' }, ids)).toMatchObject({ same_event: false });
    expect(validateMatch({ match_id: 'c9', same_event: true, angle_note: 'x' }, ids)).toBeNull();
    expect(validateMatch({ match_id: 'c1', same_event: true, angle_note: Array(21).fill('word').join(' ') }, ids)).toBeNull();
    expect(validateMatch({ match_id: 'c1', same_event: 'yes', angle_note: 'x' }, ids)).toBeNull();
    // Notes are for a reader: the prompt's own words ("primary", "candidate") are sent back for a retry.
    expect(validateMatch({ match_id: 'c1', same_event: true, angle_note: 'Omits the criticism highlighted in the primary.' }, ids)).toBeNull();
    expect(validateMatch({ match_id: 'c1', same_event: true, angle_note: 'Leads on the primary school closures.' }, ids)).toBeNull();
    expect(validateMatch('nonsense', ids)).toBeNull();
    expect(extractJson('```json\n{"match_id": null, "same_event": false, "angle_note": ""}\n```')).toEqual({ match_id: null, same_event: false, angle_note: '' });
    expect(validateDigest({ covered_by_primary: false, summary: 'Outlets report a thing.' })).not.toBeNull();
    expect(validateDigest({ covered_by_primary: false, summary: '' })).toBeNull();
  });

  test('a confirmed match gets a strip with an angle note; the furthest lean is asked first', async () => {
    const s = await setup();
    s.world.addGuardian([{ title: 'G: budget raises taxes', topic: 1, summary: 'The chancellor set out tax rises.' }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget raises taxes', topic: 1, sim: 0.99 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: tax raid on families', topic: 1, sim: 0.9 }]);
    await s.run();
    const { feed } = await view(s);
    expect(feed[0].second).toMatchObject({ sourceName: 'Daily Mail', angleNote: 'Leads on the cost to taxpayers; quotes the opposition.' });
    expect(countWords(feed[0].second!.angleNote!)).toBeLessThanOrEqual(20);
    const call = s.world.chatCalls.find((c) => c.purpose === 'match')!;
    expect(call.user.indexOf('Daily Mail')).toBeLessThan(call.user.indexOf('BBC News'));
    expect(call.user).toContain('The chancellor set out tax rises.');
    // No reading history or personal data in the prompt: only the public headline text.
    expect(call.user).not.toMatch(/session|impression|history/i);
    const dec = await s.db.all<any>("SELECT summary, detail FROM decision_log WHERE kind = 'match'");
    expect(dec[0].summary).toContain('Match');
    expect(JSON.parse(dec[0].detail).candidates[0]).toHaveProperty('similarity');
  });

  test('nothing is shown when the model says it is a different event, and a confirmed pair is never re-queried', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'G: flood in York', topic: 1 }, { title: 'G: rail strike', topic: 2 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: flood in Leeds last year', topic: 1 }, { title: 'BBC: rail strike', topic: 2 }]);
    s.world.onChat = (purpose, user) =>
      user.includes('G: flood') ? JSON.stringify({ match_id: null, same_event: false, angle_note: '' })
        : JSON.stringify({ match_id: 'c1', same_event: true, angle_note: 'Stresses disruption to commuters.' });
    await s.run();
    const { feed } = await view(s);
    const by = Object.fromEntries(feed.map((c) => [c.article.title, c.second]));
    expect(by['G: flood in York']).toBeNull();
    expect(by['G: rail strike']).toMatchObject({ sourceName: 'BBC News' });
    expect(s.world.chatCalls.filter((c) => c.purpose === 'match')).toHaveLength(2);

    // Next refresh: the confirmed pair is not asked again, and the rejected candidate is not re-sent.
    s.world.now += HOUR;
    await s.run();
    expect(s.world.chatCalls.filter((c) => c.purpose === 'match')).toHaveLength(2);

    // A new outlet publishing later is checked (unmatched articles are rechecked for 24 hours).
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: York flood latest', topic: 1, hoursAgo: 0.1 }]);
    s.world.onChat = () => JSON.stringify({ match_id: 'c1', same_event: true, angle_note: 'Focuses on residents rather than ministers.' });
    s.world.now += HOUR;
    await s.run();
    const calls = s.world.chatCalls.filter((c) => c.purpose === 'match');
    expect(calls).toHaveLength(3);
    expect(calls[2].user).toContain('York flood latest');
    expect(calls[2].user).not.toContain('Leeds last year');
    expect((await view(s)).feed.find((c) => c.article.title === 'G: flood in York')!.second).toMatchObject({ sourceName: 'BBC News' });
  });

  test('candidates below the similarity threshold are never sent to the model', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: loosely related', topic: 1, sim: 0.5 }]);
    await s.run();
    expect(s.world.chatCalls).toHaveLength(0);
    expect((await view(s)).feed[0].second).toBeNull();
  });

  test('invalid JSON is retried once, then skipped and logged', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1 }]);
    s.world.onChat = () => 'I think these are the same story!';
    const res = await s.run();
    expect(res.steps.every((x) => x.ok)).toBe(true);
    expect(s.world.chatCalls.filter((c) => c.purpose === 'match')).toHaveLength(2);
    expect((await view(s)).feed[0].second).toBeNull();
    const dec = await s.db.get<any>("SELECT summary FROM decision_log WHERE kind = 'match'");
    expect(dec.summary).toMatch(/Skipped/);
    // Both attempts were costed.
    expect((await s.db.get<{ n: number }>("SELECT COUNT(*) n FROM llm_usage WHERE purpose = 'second_source'"))!.n).toBe(2);
  });
});

describe('Right press digest', () => {
  async function digestWorld() {
    const s = await setup();
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1 }, { title: 'BBC: bins row', topic: 6 }]);
    s.world.addFeed(feedUrl('The Telegraph'), [
      { title: 'Telegraph: budget', topic: 1 }, { title: 'Telegraph: migrant hotel protest', topic: 5, hoursAgo: 3 },
    ]);
    s.world.addFeed(feedUrl('Daily Mail'), [
      { title: 'Mail: migrant hotel protest', topic: 5, hoursAgo: 2, image: 'https://img.test/mail.jpg' },
      { title: 'Mail: bins row', topic: 6 }, { title: 'Mail: lone story', topic: 7 },
    ]);
    s.world.addFeed(feedUrl('Daily Express'), [{ title: 'Express: migrant hotel protest', topic: 5, hoursAgo: 1 }, { title: 'Express: budget', topic: 1 }]);
    return s;
  }

  test('shows only stories from 2+ right-leaning outlets with no primary coverage, with summary, links and count', async () => {
    const s = await digestWorld();
    await s.run();
    const { digest } = await view(s);
    // Budget: covered by the primary. Bins row: one right outlet plus the BBC (centre). Lone story: one outlet.
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({
      summary: 'Several outlets report a story the primary source has not run.', hasSummary: true, outletCount: 3,
      imageUrl: 'https://img.test/mail.jpg',
    });
    expect(digest[0].outlets.map((o) => o.sourceName).sort()).toEqual(['Daily Express', 'Daily Mail', 'The Telegraph']);
    expect(digest[0].outlets.every((o) => o.articleId > 0)).toBe(true);
    expect(s.world.chatCalls.filter((c) => c.purpose === 'digest')).toHaveLength(1);
    // Summaries are written once.
    s.world.now += HOUR;
    await s.run();
    expect(s.world.chatCalls.filter((c) => c.purpose === 'digest')).toHaveLength(1);
  });

  test('changing an outlet\'s lean changes whether it counts at the next refresh', async () => {
    const s = await digestWorld();
    await s.run();
    expect((await view(s)).digest.map((d) => d.outletCount)).toEqual([3]);

    // The BBC is relabelled centre-right: the bins row now has two right-leaning outlets.
    const bbc = (await getSource(s.db, s.ids['BBC News']))!;
    await updateSource(s.db, bbc.id, { ...bbc, lean: 'centre-right' });
    s.world.now += HOUR;
    await s.run();
    let { digest } = await view(s);
    expect(digest).toHaveLength(2);
    expect(digest.find((d) => d.outletCount === 2)!.outlets.map((o) => o.sourceName).sort()).toEqual(['BBC News', 'Daily Mail']);

    // The Mail and Express are relabelled centre: neither story has two right-leaning outlets any more.
    for (const name of ['Daily Mail', 'Daily Express']) {
      const src = (await getSource(s.db, s.ids[name]))!;
      await updateSource(s.db, src.id, { ...src, lean: 'centre' });
    }
    s.world.now += HOUR;
    await s.run();
    ({ digest } = await view(s));
    expect(digest).toHaveLength(0);
  });

  test('a near-miss primary article is put to the model; a yes disqualifies the story', async () => {
    const s = await setup();
    // Similarity to the cluster centroid lands between the grey-zone bounds (0.55 to 0.72).
    s.world.addGuardian([{ title: 'G: asylum policy explained', topic: 5, sim: 0.66 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: migrant hotel protest', topic: 5 }]);
    s.world.addFeed(feedUrl('Daily Express'), [{ title: 'Express: migrant hotel protest', topic: 5 }]);
    s.world.onChat = (purpose) => purpose === 'digest'
      ? JSON.stringify({ covered_by_primary: true, summary: '' })
      : JSON.stringify({ match_id: null, same_event: false, angle_note: '' });
    await s.run();
    const call = s.world.chatCalls.find((c) => c.purpose === 'digest')!;
    expect(call.user).toContain('PRIMARY headlines');
    expect(call.user).toContain('G: asylum policy explained');
    expect((await view(s)).digest).toHaveLength(0);
    expect((await s.db.get<any>('SELECT digest_status FROM cluster WHERE right_outlet_count >= 2')).digest_status).toBe('covered');
  });

  test('a primary article arriving later removes the story', async () => {
    const s = await digestWorld();
    await s.run();
    expect((await view(s)).digest).toHaveLength(1);
    s.world.addGuardian([{ title: 'G: migrant hotel protest', topic: 5, hoursAgo: 0.1 }]);
    s.world.now += HOUR;
    await s.run();
    expect((await view(s)).digest).toHaveLength(0);
  });

  test('stories older than 36 hours drop out', async () => {
    const s = await digestWorld();
    await s.run();
    s.world.now += 40 * HOUR;
    expect((await view(s, true)).digest).toHaveLength(0);
  });

  test('ranked by number of outlets, and at most 15 new items per refresh', async () => {
    const s = await setup();
    for (let t = 0; t < 18; t++) {
      s.world.addFeed(feedUrl('Daily Mail'), [{ title: `Mail story ${t}`, topic: t, hoursAgo: 1 + t * 0.1 }]);
      s.world.addFeed(feedUrl('Daily Express'), [{ title: `Express story ${t}`, topic: t, hoursAgo: 1 + t * 0.1 }]);
    }
    s.world.addFeed(feedUrl('The Telegraph'), [{ title: 'Telegraph story 17', topic: 17, hoursAgo: 2 }]);
    s.world.addGuardian([{ title: 'G: unrelated', topic: 30 }]);
    await s.run();
    let { digest } = await view(s);
    expect(digest).toHaveLength(15);
    expect(digest[0].outletCount).toBe(3);
    s.world.now += HOUR;
    await s.run();
    ({ digest } = await view(s));
    expect(digest).toHaveLength(18);
  });
});

describe('LLM cost and budget', () => {
  test('cost is recorded per call from the usage figures, and summed for the month', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.world.addGuardian([{ title: 'G: budget', topic: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1 }]);
    await s.run();
    const rows = await s.db.all<any>('SELECT model, purpose, input_tokens, output_tokens, cost_usd FROM llm_usage ORDER BY id');
    expect(rows.map((r) => r.purpose)).toEqual(['embedding', 'second_source']);
    expect(rows[1]).toMatchObject({ model: 'anthropic/claude-haiku-4.5', input_tokens: 900, output_tokens: 60, cost_usd: 0.002 });
    expect(await monthSpend(s.db, s.world.now)).toBeCloseTo(0.00201, 5);
    // Spend from last month does not count.
    expect(await monthSpend(s.db, s.world.now + 40 * DAY)).toBe(0);
  });

  test('at the budget cap LLM calls stop, the feed still loads, strong matches show without a note and the digest shows headlines', async () => {
    const s = await setup();
    await saveSettings(s.db, { monthlyBudgetUsd: 0.01 });
    // Earlier spend this month has already used the budget.
    await s.db.run("INSERT INTO llm_usage(at, model, purpose, input_tokens, output_tokens, cost_usd) VALUES(?, 'm', 'second_source', 1, 1, 0.02)", [s.world.now - HOUR]);
    expect(await overBudget(s.db, await loadSettings(s.db), s.world.now)).toBe(true);

    s.world.addGuardian([{ title: 'G: budget', topic: 1 }, { title: 'G: storm', topic: 2 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: budget', topic: 1, sim: 0.99 }, { title: 'BBC: storm, loosely', topic: 2, sim: 0.75 }]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: hotel protest', topic: 5 }]);
    s.world.addFeed(feedUrl('Daily Express'), [{ title: 'Express: hotel protest', topic: 5 }]);
    const res = await s.run();
    expect(res.steps.every((x) => x.ok)).toBe(true);
    expect(s.world.chatCalls).toHaveLength(0); // no Haiku calls at all
    expect(s.world.embedCalls).toBeGreaterThan(0); // embeddings carry on

    const { feed, digest } = await view(s);
    expect(feed).toHaveLength(2);
    const by = Object.fromEntries(feed.map((c) => [c.article.title, c.second]));
    // 0.96 similarity clears the stricter cap threshold: strip without an angle note. 0.73 does not.
    expect(by['G: budget']).toMatchObject({ sourceName: 'BBC News', angleNote: null });
    expect(by['G: storm']).toBeNull();
    // Digest falls back to a headline.
    expect(digest).toHaveLength(1);
    expect(digest[0].hasSummary).toBe(false);
    expect(digest[0].summary).toMatch(/hotel protest/);

    // Next month the budget is back: notes and summaries are filled in.
    s.world.now += 32 * DAY;
    s.world.addGuardian([{ title: 'G: new month story', topic: 8, hoursAgo: 1 }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: new month story', topic: 8, hoursAgo: 1 }]);
    await s.run();
    expect(s.world.chatCalls.length).toBeGreaterThan(0);
    expect((await view(s, true)).feed.find((c) => c.article.title === 'G: new month story')!.second!.angleNote).toBeTruthy();
  });

  test('the cap can be reached mid-refresh', async () => {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    await saveSettings(s.db, { monthlyBudgetUsd: 0.003 });
    s.world.chatCost = 0.002;
    for (let t = 0; t < 10; t++) {
      s.world.addGuardian([{ title: `G: story ${t}`, topic: t }]);
      s.world.addFeed(feedUrl('BBC News'), [{ title: `BBC: story ${t}`, topic: t }]);
    }
    const res = await s.run();
    expect(res.steps.every((x) => x.ok)).toBe(true);
    // Calls already in flight finish (up to LLM_CONCURRENCY at once), then no more are made.
    expect(s.world.chatCalls.length).toBeLessThanOrEqual(LLM_CONCURRENCY + 1);
    expect(res.steps.find((x) => x.name.startsWith('5'))!.info).toMatch(/budget reached/);
  });
});
