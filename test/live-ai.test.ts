/**
 * Live run of the AI mode against its real default sources and the real OpenRouter API: a first
 * refresh from an empty database, reporting the feed it builds and what it cost.
 * Skipped unless LIVE=1 and OPENROUTER_KEY are set:  LIVE=1 npx jest test/live-ai.test.ts
 */
import fs from 'fs';
import path from 'path';
import { ensureSession } from '../src/core/feed';
import { AI_MODE_ID, seedModes } from '../src/core/modes';
import { loadSections } from '../src/core/sections';
import { listSources, seedDefaultSources } from '../src/core/sources';
import { countWords } from '../src/core/util';
import { migrate } from '../src/db/db';
import { monthSpendByMode } from '../src/llm/openrouter';
import { OPENROUTER_KEY_REF, refresh } from '../src/pipeline/refresh';
import { memorySecrets, nodeFetch, openNodeDb } from './helpers/nodeDb';

function envKey(name: string): string | null {
  if (process.env[name]) return process.env[name]!;
  try {
    const m = new RegExp(`^${name}=(.+)$`, 'm').exec(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const live = process.env.LIVE === '1' && envKey('OPENROUTER_KEY');

(live ? test : test.skip)('live first refresh of the AI mode', async () => {
  const db = openNodeDb(process.env.LIVE_DB || ':memory:');
  await migrate(db);
  await seedDefaultSources(db);
  await seedModes(db, Date.now());
  // Only the AI mode is measured: News's sources are switched off for this run.
  await db.run('UPDATE source SET enabled = 0 WHERE mode_id = 1');
  await db.run("UPDATE source SET enabled = 1 WHERE mode_id = 1 AND name = 'Guardian'");
  await db.run("UPDATE source SET adapter = 'rss', endpoint = 'https://www.theguardian.com/uk/rss' WHERE mode_id = 1 AND name = 'Guardian'");
  const secrets = memorySecrets({ [OPENROUTER_KEY_REF]: envKey('OPENROUTER_KEY')! });
  const t0 = Date.now();
  const res = await refresh({
    db, fetch: nodeFetch, secrets, now: () => Date.now(), files: null, isWifi: async () => true,
    onStep: (s) => console.log(`${s.ok ? 'ok ' : 'ERR'} ${s.name} ${s.ms}ms (at ${Date.now() - t0}ms) ${s.info ?? s.error}`),
  }, 'manual');
  const { sessionId } = await ensureSession(db, Date.now());
  const v = await loadSections(db, AI_MODE_ID, sessionId, Date.now());
  for (const sec of v.sections) {
    console.log(`\n== ${sec.def.title} (${sec.cards.length})\n` + sec.cards.slice(0, 25).map((c) =>
      `${c.relevance.toFixed(2)}/${c.significance.toFixed(2)} ${c.article.title}\n      ${c.article.summary}\n      why: ${c.why ?? '-'} | ${c.sourceName}${c.more.length ? ` +${c.more.length} more (${c.more.map((m) => m.sourceName).join(', ')})` : ''}${c.reason ? ` | ${c.reason}` : ''} | ${c.tags.join(', ')}`).join('\n'));
  }
  console.log('sources', (await listSources(db, AI_MODE_ID)).map((s) => `${s.name}: ${s.lastError ?? 'ok'}`).join(' | '));
  const by = await monthSpendByMode(db, Date.now());
  const calls = await db.all<any>("SELECT purpose, COUNT(*) n, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost_usd) c FROM llm_usage WHERE mode_id = ? GROUP BY purpose", [AI_MODE_ID]);
  console.log('AI mode spend $', (by.get(AI_MODE_ID) ?? 0).toFixed(4), JSON.stringify(calls), 'total time', Date.now() - t0, 'ms');
  expect(res.steps.filter((s) => s.name.startsWith('AI:')).every((s) => s.ok)).toBe(true);
  const cards = v.sections.flatMap((s) => s.cards).filter((c) => c.enriched);
  expect(cards.length).toBeGreaterThan(10);
  for (const c of cards) {
    expect(countWords(c.article.title)).toBeLessThanOrEqual(10);
    expect(countWords(c.article.summary)).toBeLessThanOrEqual(20);
  }
  db.close();
}, 600000);
