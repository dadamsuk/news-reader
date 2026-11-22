/**
 * Live smoke run of the whole pipeline against real feeds and the real OpenRouter API.
 * Skipped unless LIVE=1 and OPENROUTER_KEY are set:  LIVE=1 npx jest test/live.test.ts
 */
import fs from 'fs';
import path from 'path';
import { loadDigest, loadFeed, ensureSession } from '../src/core/feed';
import { loadSettings } from '../src/core/settings';
import { listSources, seedDefaultSources, updateSource } from '../src/core/sources';
import { monthSpend } from '../src/llm/openrouter';
import { OPENROUTER_KEY_REF, refresh } from '../src/pipeline/refresh';
import { memorySecrets, nodeFetch, openNodeDb } from './helpers/nodeDb';
import { migrate } from '../src/db/db';

function envKey(): string | null {
  if (process.env.OPENROUTER_KEY) return process.env.OPENROUTER_KEY;
  try {
    const m = /^OPENROUTER_KEY=(.+)$/m.exec(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const live = process.env.LIVE === '1' && envKey();

(live ? test : test.skip)('live refresh against real feeds', async () => {
  const file = process.env.LIVE_DB || ':memory:';
  const db = openNodeDb(file);
  await migrate(db);
  await seedDefaultSources(db);
  // No Guardian API key here: stand in with the Guardian's public RSS feed as the primary source.
  const g = (await listSources(db)).find((s) => s.name === 'Guardian')!;
  if (g.adapter === 'guardian_content_api') {
    await updateSource(db, g.id, { ...g, adapter: 'rss', endpoint: 'https://www.theguardian.com/uk/rss\nhttps://www.theguardian.com/politics/rss\nhttps://www.theguardian.com/world/rss' });
  }
  const secrets = memorySecrets({ [OPENROUTER_KEY_REF]: envKey()! });
  const res = await refresh({ db, fetch: nodeFetch, secrets, now: () => Date.now(), files: null, isWifi: async () => true,
    onStep: (s) => console.log(`${s.ok ? 'ok ' : 'ERR'} ${s.name} ${s.ms}ms ${s.info ?? s.error}`) }, 'manual');
  const settings = await loadSettings(db);
  const { sessionId } = await ensureSession(db, Date.now());
  const feed = await loadFeed(db, settings, sessionId, Date.now());
  const digest = await loadDigest(db, settings, sessionId, Date.now());
  const top = feed.filter((c) => c.second).slice(0, 30).map((c) => `${c.score.toFixed(2)} ${c.explore ? '*' : ' '} ${c.article.title}${c.second ? `\n        ↳ ${c.second.sourceName}: ${c.second.angleNote}` : ''}`);
  console.log(`FEED ${feed.length}\n` + top.join('\n'));
  console.log(`DIGEST ${digest.length}\n` + digest.slice(0, 15).map((d) => `[${d.outletCount}] ${d.summary}\n      ${d.outlets.map((o) => `${o.sourceName}: ${o.title}`).join('\n      ')}`).join('\n'));
  console.log('sources', (await listSources(db)).map((s) => `${s.name}: ${s.lastError ?? 'ok'}`).join(' | '));
  console.log('spend $', (await monthSpend(db, Date.now())).toFixed(4), 'with second', feed.filter((c) => c.second).length);
  expect(res.steps.length).toBe(8);
  expect(feed.length).toBeGreaterThan(10);
  db.close();
}, 300000);
