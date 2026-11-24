/**
 * Modes in the data (PRD "Data model"): migration 7, per-mode ownership and isolation, and News
 * behaving exactly as before.
 */
import { ensureSession, loadFeed, loadHistory, loadMore, loadReadLater, recordImpressions, saveForLater } from '../src/core/feed';
import { AI_MODE_ID, NEWS_MODE_ID, getMode, listModes, loadSectionsSettings, saveModeSettings, seedModes, AI_DEFAULT_SOURCES } from '../src/core/modes';
import { getProfile } from '../src/core/profile';
import { DEFAULT_SETTINGS, NEWS_MODE_KEYS, loadSettings, saveSettings } from '../src/core/settings';
import { exportSources, importSources, insertSource, listSources, seedDefaultSources, updateSource } from '../src/core/sources';
import { MIGRATIONS, migrate } from '../src/db/db';
import { monthSpend, monthSpendByMode } from '../src/llm/openrouter';
import { stepFetch } from '../src/pipeline/steps';
import { memorySecrets, openNodeDb } from './helpers/nodeDb';
import { SRC, T0, feedUrl, setup } from './helpers/world';

/** A database as an install had it before modes (migrations 1 to 6), with some of everything in it. */
async function preModesInstall() {
  const db = openNodeDb();
  for (let i = 0; i < 6; i++) await db.exec(MIGRATIONS[i]);
  await db.exec('PRAGMA user_version = 6');
  const src = (await db.run(
    `INSERT INTO source(name, adapter, endpoint, role, lean, reader_mode, paywalled, include_sections, exclude_sections, refresh_minutes, enabled)
     VALUES('Guardian', 'guardian_content_api', 'https://content.guardianapis.com/search', 'primary', 'left', 'extract', 0, '[]', '[]', 30, 1)`,
  )).lastInsertRowId;
  const add = async (n: number) =>
    (await db.run(
      'INSERT INTO article(source_id, canonical_url, url, title, published_at, tags, fetched_at, ready_at, score_a) VALUES(?,?,?,?,?,?,?,?,?)',
      [src, `https://g.test/${n}`, `https://g.test/${n}?x=1`, `Story ${n}`, T0 - n * 1000, '["politics"]', T0, T0, -1.2],
    )).lastInsertRowId;
  const ids = [await add(1), await add(2), await add(3), await add(4)];
  // The newest article was deleted (retention); its interaction row outlives it.
  await db.run('DELETE FROM article WHERE id = ?', [ids[3]]);
  await db.run("INSERT INTO interaction(article_id, kind, at) VALUES(?, 'hidden', ?)", [ids[3], T0]);
  await db.run("INSERT INTO impression(article_id, first_seen_at, session_id, surface) VALUES(?, ?, 's1', 'feed')", [ids[0], T0]);
  await db.run('INSERT INTO read_later(article_id, saved_at) VALUES(?, ?)', [ids[1], T0]);
  await db.run("INSERT INTO feature_stat(feature_key, positive_weight, negative_weight, updated_at) VALUES('section:politics', 2, 0, ?)", [T0]);
  await db.run("INSERT INTO topic_rule(kind, term, created_at) VALUES('mute', 'cricket', ?)", [T0]);
  await db.run("INSERT INTO llm_usage(at, model, purpose, input_tokens, output_tokens, cost_usd) VALUES(?, 'm', 'match', 1, 1, 0.5)", [T0]);
  for (const [k, v] of Object.entries({ chronological: true, filterThreshold: 35, weightS: 2, learningStartedAt: T0 - 5, monthlyBudgetUsd: 12, textSize: 20 })) {
    await db.run('INSERT INTO setting(key, value) VALUES(?, ?)', [k, JSON.stringify(v)]);
  }
  return { db, ids };
}

describe('migration 7: modes', () => {
  test('existing data and settings become the News mode, unchanged; nothing is lost', async () => {
    const { db, ids } = await preModesInstall();
    const before = await db.all('SELECT id, source_id, canonical_url, url, title, published_at, tags, score_a FROM article ORDER BY id');
    await migrate(db);
    expect((await db.get<{ user_version: number }>('PRAGMA user_version'))!.user_version).toBe(MIGRATIONS.length);

    expect((await listModes(db)).map((m) => [m.id, m.name, m.layout.type])).toEqual([[1, 'News', 'news'], [2, 'AI', 'sections']]);
    // Every row, every id, every value.
    expect(await db.all('SELECT id, source_id, canonical_url, url, title, published_at, tags, score_a FROM article ORDER BY id')).toEqual(before);
    for (const table of ['source', 'article', 'feature_stat', 'topic_rule', 'llm_usage', 'cluster', 'centroid', 'story', 'briefing']) {
      const r = await db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE mode_id != 1`);
      expect([table, r!.n]).toEqual([table, 0]);
    }
    expect(await db.get('SELECT COUNT(*) n FROM impression')).toEqual({ n: 1 });
    expect(await db.get('SELECT COUNT(*) n FROM read_later')).toEqual({ n: 1 });
    expect(await db.get('SELECT COUNT(*) n FROM interaction')).toEqual({ n: 1 });

    // A new article never takes the id of the deleted one, whose interaction row is still there.
    const next = await db.run(
      'INSERT INTO article(source_id, canonical_url, url, title, published_at, fetched_at) VALUES(?,?,?,?,?,?)',
      [1, 'https://g.test/new', 'https://g.test/new', 'New', T0, T0],
    );
    expect(next.lastInsertRowId).toBeGreaterThan(ids[3]);

    // The settings that are News's move into its mode, with the same values; the old rows stay.
    const s = await loadSettings(db);
    expect(s).toMatchObject({ chronological: true, filterThreshold: 35, weightS: 2, learningStartedAt: T0 - 5, monthlyBudgetUsd: 12, textSize: 20 });
    const news = JSON.parse((await db.get<{ settings: string }>('SELECT settings FROM mode WHERE id = 1'))!.settings);
    expect(news).toEqual({ chronological: true, filterThreshold: 35, weightS: 2, learningStartedAt: T0 - 5 });
    expect(await db.get("SELECT value FROM setting WHERE key = 'chronological'")).toEqual({ value: 'true' });
    expect(await db.get("SELECT value FROM setting WHERE key = 'monthlyBudgetUsd'")).toEqual({ value: '12' });
  });

  test('the canonical URL is unique per mode, not across the app', async () => {
    const db = openNodeDb();
    await migrate(db);
    const ins = (mode: number) => db.run(
      'INSERT OR IGNORE INTO article(mode_id, source_id, canonical_url, url, title, published_at, fetched_at) VALUES(?,?,?,?,?,?,?)',
      [mode, 1, 'https://same.test/story', 'https://same.test/story', 'Same', T0, T0],
    );
    expect((await ins(NEWS_MODE_ID)).changes).toBe(1);
    expect((await ins(NEWS_MODE_ID)).changes).toBe(0);
    expect((await ins(AI_MODE_ID)).changes).toBe(1);
  });

  test('a fresh install: both modes, News settings at their defaults, budget $15', async () => {
    const db = openNodeDb();
    await migrate(db);
    const s = await loadSettings(db);
    expect(s.monthlyBudgetUsd).toBe(15);
    expect(DEFAULT_SETTINGS.monthlyBudgetUsd).toBe(15);
    for (const k of NEWS_MODE_KEYS) expect(s[k]).toEqual(DEFAULT_SETTINGS[k]);
    expect((await getMode(db, AI_MODE_ID))!.layout).toEqual({
      type: 'sections',
      sections: [{ type: 'ranked', title: "Stuff you're interested in" }, { type: 'other_news', title: 'In other news...' }],
    });
  });
});

describe('per-mode settings', () => {
  test('News settings are saved to the News mode and read back; shared ones stay shared', async () => {
    const db = openNodeDb();
    await migrate(db);
    await saveSettings(db, { chronological: true, pulseHidden: ['UK'], monthlyBudgetUsd: 20, currentModeId: AI_MODE_ID });
    const news = JSON.parse((await db.get<{ settings: string }>('SELECT settings FROM mode WHERE id = 1'))!.settings);
    expect(news).toEqual({ chronological: true, pulseHidden: ['UK'] });
    expect(await db.get("SELECT COUNT(*) n FROM setting WHERE key IN ('chronological', 'pulseHidden')")).toEqual({ n: 0 });
    expect(await loadSettings(db)).toMatchObject({ chronological: true, pulseHidden: ['UK'], monthlyBudgetUsd: 20, currentModeId: AI_MODE_ID });
  });

  test('a sections-layout mode has its own settings: defaults, stored values, type checks', async () => {
    const db = openNodeDb();
    await migrate(db);
    const s = await loadSectionsSettings(db, AI_MODE_ID);
    expect(s).toMatchObject({ clusterThreshold: 0.75, relevanceThreshold: 0.5, maxAgeDays: 7, pageSize: 15, otherNewsCount: 4 });
    await saveModeSettings(db, AI_MODE_ID, { relevanceThreshold: 0.6, pageSize: 'lots', signalWeights: { open: 0.5 } });
    const t = await loadSectionsSettings(db, AI_MODE_ID);
    expect(t.relevanceThreshold).toBe(0.6);
    expect(t.pageSize).toBe(15); // wrong type: ignored
    expect(t.signalWeights).toMatchObject({ open: 0.5, more: 1, dismiss: -1 });
    // News's settings are untouched by the AI mode's.
    expect((await loadSettings(db)).clusterThreshold).toBe(0.75);
  });
});

describe('sources belong to one mode', () => {
  test('the AI mode is seeded once with its sources and starter profile; News is not touched', async () => {
    const db = openNodeDb();
    await migrate(db);
    await seedDefaultSources(db);
    const newsBefore = await listSources(db);
    await seedModes(db, T0);
    await seedModes(db, T0); // once only
    const ai = await listSources(db, AI_MODE_ID);
    expect(ai.map((s) => s.name)).toEqual(AI_DEFAULT_SOURCES.map((s) => s.name));
    expect(ai.every((s) => s.modeId === AI_MODE_ID && s.role === 'primary' && s.lean === 'centre')).toBe(true);
    expect(ai.find((s) => s.name === 'Hacker News')).toMatchObject({ adapter: 'hn_api', priority: 'low', config: { minPoints: 150 } });
    expect(ai.find((s) => s.name === 'TLDR AI')).toMatchObject({ isDigest: true, priority: 'low' });
    expect(ai.find((s) => s.name === 'OpenAI')).toMatchObject({ priority: 'high', isDigest: false });
    expect(await listSources(db)).toEqual(newsBefore);
    const profile = (await getProfile(db, AI_MODE_ID))!;
    expect(profile.markdown).toMatch(/## Interested in\n- AI-assisted software engineering practice/);
    expect(profile.createdBy).toBe('starter');
    expect((await loadSectionsSettings(db, AI_MODE_ID)).learningStartedAt).toBe(T0);

    // Deleting every AI source does not bring the defaults back.
    await db.run('DELETE FROM source WHERE mode_id = ?', [AI_MODE_ID]);
    await seedModes(db, T0 + 1000);
    expect(await listSources(db, AI_MODE_ID)).toHaveLength(0);
  });

  test('an edit keeps a source in its mode; the primary-source rule is News only', async () => {
    const db = openNodeDb();
    await migrate(db);
    const id = await insertSource(db, { ...SRC.rss('AI blog', 'centre', { role: 'primary' }), modeId: AI_MODE_ID, priority: 'high' });
    const s = (await listSources(db, AI_MODE_ID))[0];
    await updateSource(db, id, { ...s, enabled: false, config: { maxPerIssue: 5 } });
    expect((await listSources(db, AI_MODE_ID))[0]).toMatchObject({ modeId: AI_MODE_ID, enabled: false, priority: 'high', config: { maxPerIssue: 5 } });
  });

  test('export and import work per mode, and round-trip the new fields', async () => {
    const db = openNodeDb();
    await migrate(db);
    await seedDefaultSources(db);
    await seedModes(db, T0);
    const ai = await exportSources(db, AI_MODE_ID);
    expect(ai.sources).toHaveLength(AI_DEFAULT_SOURCES.length);
    expect(ai.sources.find((s) => s.name === 'Hacker News')).toMatchObject({ priority: 'low', config: { minPoints: 150 } });
    const db2 = openNodeDb();
    await migrate(db2);
    await seedDefaultSources(db2);
    const newsBefore = await exportSources(db2);
    await importSources(db2, memorySecrets(), JSON.stringify(ai), AI_MODE_ID);
    expect(await exportSources(db2, AI_MODE_ID)).toEqual(ai);
    expect(await exportSources(db2)).toEqual(newsBefore);
  });
});

describe('isolation of item state', () => {
  /** News as the tests always set it up, plus an AI-mode source carrying the same article URL. */
  async function twoModes() {
    const s = await setup([SRC.rss('BBC News', 'centre')]);
    s.ids.AI = await insertSource(s.db, { ...SRC.rss('AI feed', 'centre', { role: 'primary' }), modeId: AI_MODE_ID });
    s.world.addGuardian([{ title: 'G: AI regulation bill passes', topic: 1, url: 'https://www.theguardian.test/tech/ai-bill' }]);
    s.world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: weather', topic: 2 }]);
    s.world.addFeed(feedUrl('AI feed'), [{ title: 'AI feed: the same Guardian piece', topic: 1, url: 'https://www.theguardian.test/tech/ai-bill' }]);
    // Only the News pipeline is under test here: fetch the AI source by hand.
    await s.run();
    await stepFetch({ db: s.db, fetch: s.world.fetch, secrets: s.secrets, settings: await loadSettings(s.db), now: () => s.world.now, llm: null as any }, true, { modeId: AI_MODE_ID });
    return s;
  }

  test('the same URL is stored once per mode; News lists never show the AI copy', async () => {
    const s = await twoModes();
    const rows = await s.db.all<{ mode_id: number }>("SELECT mode_id FROM article WHERE canonical_url = 'https://theguardian.test/tech/ai-bill' ORDER BY mode_id");
    expect(rows.map((r) => r.mode_id)).toEqual([NEWS_MODE_ID, AI_MODE_ID]);
    const settings = await loadSettings(s.db);
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const feed = await loadFeed(s.db, settings, sessionId, s.world.now);
    expect(feed.map((c) => c.article.title)).toEqual(['G: AI regulation bill passes']);
    expect((await loadMore(s.db)).map((r) => r.article.title)).toEqual(['BBC: weather']);
  });

  test('seeing, saving and History are per mode', async () => {
    const s = await twoModes();
    const aiId = (await s.db.get<{ id: number }>('SELECT id FROM article WHERE mode_id = ?', [AI_MODE_ID]))!.id;
    const { sessionId } = await ensureSession(s.db, s.world.now);
    await recordImpressions(s.db, [{ articleId: aiId, surface: 'feed' }], sessionId, s.world.now);
    await saveForLater(s.db, aiId, sessionId, s.world.now);
    // Seen and saved in AI; the News copy of the same story is still unseen and unsaved.
    s.world.now += 11 * 60_000;
    const next = await ensureSession(s.db, s.world.now, true);
    const feed = await loadFeed(s.db, await loadSettings(s.db), next.sessionId, s.world.now);
    expect(feed.map((c) => c.article.title)).toEqual(['G: AI regulation bill passes']);
    expect(feed[0].saved).toBe(false);
    expect(await loadReadLater(s.db)).toHaveLength(0);
    expect((await loadReadLater(s.db, AI_MODE_ID)).map((r) => r.article.id)).toEqual([aiId]);
    expect(await loadHistory(s.db, s.world.now)).toHaveLength(0);
    expect((await loadHistory(s.db, s.world.now, '', 300, AI_MODE_ID)).map((r) => r.article.id)).toEqual([aiId]);
  });

  test('spend is recorded per mode; the one budget covers the total', async () => {
    const s = await setup([]);
    s.world.addGuardian([{ title: 'G: one', topic: 1 }]);
    await s.run();
    await s.db.run("INSERT INTO llm_usage(at, model, purpose, input_tokens, output_tokens, cost_usd, mode_id) VALUES(?, 'm', 'enrich', 1, 1, 0.25, ?)", [s.world.now, AI_MODE_ID]);
    const by = await monthSpendByMode(s.db, s.world.now);
    expect(by.get(AI_MODE_ID)).toBeCloseTo(0.25);
    expect(by.get(NEWS_MODE_ID)!).toBeGreaterThan(0);
    expect(await monthSpend(s.db, s.world.now)).toBeCloseTo(by.get(AI_MODE_ID)! + by.get(NEWS_MODE_ID)!);
  });
});
