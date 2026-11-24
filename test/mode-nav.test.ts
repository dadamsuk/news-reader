/**
 * Navigation between modes (PRD "Switching and navigation"): unseen counts for the mode bar, the
 * last-used mode, Read later and History per mode, and Reset learning per mode.
 */
import { ensureSession, loadReadLater, recordImpressions, saveForLater } from '../src/core/feed';
import { loadWeights, resetModeLearning } from '../src/core/learning';
import { AI_MODE_ID, NEWS_MODE_ID, createMode, listModes, loadSectionsSettings, saveModeSettings } from '../src/core/modes';
import { addProfileVersion, getProfile, saveProfileEdit } from '../src/core/profile';
import { applySignal, loadStats, resetLearning } from '../src/core/ranking';
import { loadSections, unseenCounts } from '../src/core/sections';
import { loadSettings, saveSettings } from '../src/core/settings';
import { insertSource } from '../src/core/sources';
import { addStory } from './helpers/ai';
import { SRC, T0, setup } from './helpers/world';

const DAY = 24 * 3600_000;

async function withAi() {
  const s = await setup([SRC.rss('BBC News', 'centre')]);
  s.ids.AI = await insertSource(s.db, { ...SRC.rss('AI blog', 'centre', { role: 'primary' }), modeId: AI_MODE_ID });
  // Past the cold start, so the thresholds are the PRD's main ones.
  await saveModeSettings(s.db, AI_MODE_ID, { learningStartedAt: T0 - 30 * DAY });
  s.world.addGuardian([{ title: 'G: one', topic: 1 }, { title: 'G: two', topic: 2 }, { title: 'G: three', topic: 3 }]);
  await s.run();
  return s;
}

describe('mode bar', () => {
  test('each mode has its own unseen count; seeing a card lowers only its mode', async () => {
    const s = await withAi();
    const main1 = await addStory(s.db, AI_MODE_ID, s.ids.AI, { title: 'agents', relevance: 0.8, significance: 0.2 });
    await addStory(s.db, AI_MODE_ID, s.ids.AI, { title: 'pricing', relevance: 0.6, significance: 0.3 });
    await addStory(s.db, AI_MODE_ID, s.ids.AI, { title: 'chips', relevance: 0.2, significance: 0.7 });
    await addStory(s.db, AI_MODE_ID, s.ids.AI, { title: 'gadget', relevance: 0.1, significance: 0.1 }); // held back
    const modes = await listModes(s.db);
    const settings = await loadSettings(s.db);
    const { sessionId } = await ensureSession(s.db, s.world.now);
    expect(await unseenCounts(s.db, modes, settings, sessionId, s.world.now)).toEqual({ [NEWS_MODE_ID]: 3, [AI_MODE_ID]: 3 });

    await recordImpressions(s.db, [{ articleId: main1.articleId, surface: 'feed' }], sessionId, s.world.now);
    expect(await unseenCounts(s.db, modes, settings, sessionId, s.world.now)).toEqual({ [NEWS_MODE_ID]: 3, [AI_MODE_ID]: 2 });
  });

  test('the app opens on the last mode used', async () => {
    const s = await withAi();
    expect((await loadSettings(s.db)).currentModeId).toBe(NEWS_MODE_ID);
    await saveSettings(s.db, { currentModeId: AI_MODE_ID });
    expect((await loadSettings(s.db)).currentModeId).toBe(AI_MODE_ID);
  });

  test('a third mode added by configuration shows in the mode bar with its own count', async () => {
    const s = await withAi();
    const id = await createMode(s.db, {
      name: 'Climate', icon: 'leaf-outline',
      layout: { type: 'sections', sections: [{ type: 'ranked', title: 'For you' }, { type: 'other_news', title: 'Elsewhere' }] },
      settings: { learningStartedAt: T0 - 30 * DAY },
      sources: [SRC.rss('Carbon Brief', 'centre', { role: 'primary' })],
      profile: '## Interested in\n- Heat pumps\n\n## Not interested in\n\n## Sources I value\n\n## Notes\n',
    }, T0);
    const src = (await s.db.get<{ id: number }>('SELECT id FROM source WHERE mode_id = ?', [id]))!.id;
    await addStory(s.db, id, src, { title: 'heat pumps', relevance: 0.9, significance: 0.1 });
    const modes = await listModes(s.db);
    expect(modes.map((m) => m.name)).toEqual(['News', 'AI', 'Climate']);
    const { sessionId } = await ensureSession(s.db, s.world.now);
    const counts = await unseenCounts(s.db, modes, await loadSettings(s.db), sessionId, s.world.now);
    expect(counts[id]).toBe(1);
    expect(counts[AI_MODE_ID]).toBe(0);
    const view = await loadSections(s.db, id, sessionId, s.world.now);
    expect(view.sections.map((x) => [x.def.title, x.cards.map((c) => c.article.title)])).toEqual([['For you', ['H: heat pumps']], ['Elsewhere', []]]);
  });
});

describe('Read later per mode', () => {
  test('lists only the current mode', async () => {
    const s = await withAi();
    const ai = await addStory(s.db, AI_MODE_ID, s.ids.AI, { title: 'agents', relevance: 0.8, significance: 0.2 });
    const g = (await s.db.get<{ id: number }>("SELECT id FROM article WHERE title = 'G: one'"))!.id;
    const { sessionId } = await ensureSession(s.db, s.world.now);
    await saveForLater(s.db, ai.articleId, sessionId, s.world.now);
    await saveForLater(s.db, g, sessionId, s.world.now);
    expect((await loadReadLater(s.db, NEWS_MODE_ID)).map((r) => r.article.id)).toEqual([g]);
    expect((await loadReadLater(s.db, AI_MODE_ID)).map((r) => r.article.id)).toEqual([ai.articleId]);
  });
});

describe('Reset learning per mode', () => {
  test('resetting AI leaves News learning alone, and the reverse', async () => {
    const s = await withAi();
    const ai = await addStory(s.db, AI_MODE_ID, s.ids.AI, { title: 'agents', relevance: 0.8, significance: 0.2 });
    const g = (await s.db.get<{ id: number }>("SELECT id FROM article WHERE title = 'G: one'"))!.id;
    await s.db.run("INSERT INTO interaction(article_id, kind, at) VALUES(?, 'more', ?)", [ai.articleId, s.world.now]);
    await applySignal(s.db, ai.articleId, 'more', s.world.now);
    await applySignal(s.db, g, 'more', s.world.now);
    await addProfileVersion(s.db, AI_MODE_ID, '## Interested in\n- Starter line\n', [], 'starter', T0);
    await saveProfileEdit(s.db, AI_MODE_ID, '## Interested in\n- Starter line\n- My own line\n', T0 + 1);
    const newsStats = await loadStats(s.db, s.world.now);
    expect(newsStats.size).toBeGreaterThan(0);

    await resetModeLearning(s.db, AI_MODE_ID, s.world.now);
    const w = await loadWeights(s.db, AI_MODE_ID);
    expect(w.tags.size + w.sources.size).toBe(0);
    expect((await getProfile(s.db, AI_MODE_ID))!.markdown).toBe('## Interested in\n- Starter line\n\n## Not interested in\n\n## Sources I value\n\n## Notes\n');
    expect((await loadSectionsSettings(s.db, AI_MODE_ID)).learningStartedAt).toBe(s.world.now);
    expect(await loadStats(s.db, s.world.now)).toEqual(newsStats); // News untouched

    await applySignal(s.db, ai.articleId, 'more', s.world.now);
    const before = await loadWeights(s.db, AI_MODE_ID);
    await resetLearning(s.db, s.world.now + 1);
    expect((await loadStats(s.db, s.world.now)).size).toBe(0);
    expect(await loadWeights(s.db, AI_MODE_ID)).toEqual(before); // AI untouched
    expect((await loadSettings(s.db)).learningStartedAt).toBe(s.world.now + 1);
  });
});
