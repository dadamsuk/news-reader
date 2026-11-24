/** Fixtures for the sections-layout (AI) mode tests. */
import type { Db } from '../../src/db/db';
import { AI_MODE_ID, AI_SETTINGS, AI_STARTER_PROFILE, saveModeSettings } from '../../src/core/modes';
import { addProfileVersion } from '../../src/core/profile';
import { insertSource } from '../../src/core/sources';
import { SRC, T0, feedUrl, setup, type World } from './world';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function hnFixtures(world: World, stories: { id: number; title: string; score: number; url?: string; hoursAgo?: number }[]) {
  world.pages.set('https://hn.test/v0/topstories.json', JSON.stringify(stories.map((s) => s.id)));
  world.pages.set('https://hn.test/v0/beststories.json', JSON.stringify(stories.slice(0, 1).map((s) => s.id)));
  for (const s of stories) {
    world.pages.set(`https://hn.test/v0/item/${s.id}.json`, JSON.stringify({
      id: s.id, type: 'story', title: s.title, score: s.score, url: s.url, descendants: 42, time: Math.floor((world.now - (s.hoursAgo ?? 2) * HOUR) / 1000),
    }));
  }
}

/** A digest issue in the AINews shape: a heading, then one list item per story, some with sub-points. */
export function digestIssueHtml(n: number, prefix = 'Story'): string {
  const items = Array.from({ length: n }, (_, i) => `
    <li><p><b>${prefix} ${i + 1}</b>: A lab released something numbered ${i + 1} with a 20% gain
      (<a href="https://x.com/someone/status/${1000 + i}">thread</a>, <a href="https://vendor${i}.test/blog/post-${i + 1}?utm_source=digest">post</a>).</p>
      <ul><li><p>Reaction: people discussed it (<a href="https://x.com/other/status/${2000 + i}">reply</a>).</p></li></ul>
    </li>`).join('');
  return `<h2>Top stories</h2><ul>${items}</ul><p>Thanks to our sponsor <a href="https://sponsor.test/?ref=digest">Acme</a> (Sponsor)</p>
    <p><a href="https://digest.test/unsubscribe">Unsubscribe</a> · <a href="https://digest.test/issues/41">Last issue</a></p>`;
}

export function digestFeedXml(world: World, issues: { url: string; title: string; html: string | null; hoursAgo: number }[]): string {
  const items = issues.map((i) => `<item><title>${i.title}</title><link>${i.url}</link>
    <pubDate>${new Date(world.now - i.hoursAgo * HOUR).toUTCString()}</pubDate>
    ${i.html ? `<content:encoded><![CDATA[${i.html}]]></content:encoded>` : ''}</item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Digest</title>${items}</channel></rss>`;
}


/** Puts an enriched story straight into a sections-layout mode (the pipeline is tested elsewhere). */
export async function addStory(db: Db, modeId: number, sourceId: number, o: {
  title: string; relevance: number; significance: number; tags?: string[]; at?: number; expires?: number; url?: string;
}): Promise<{ clusterId: number; articleId: number }> {
  const at = o.at ?? T0 - 3600_000;
  const c = await db.run(
    `INSERT INTO cluster(mode_id, created_at, last_article_at, size, headline, summary, why_it_matters, tags, item_type,
       profile_match, impact, relevance, significance, section, expires_at, enriched_at, source_count)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [modeId, at, at, 1, `H: ${o.title}`, `S: ${o.title}`, 'Matters because.', JSON.stringify(o.tags ?? ['coding agents']), 'release',
      0.5, 0.5, o.relevance, o.significance, o.relevance >= 0.5 ? 'main' : o.significance >= 0.6 ? 'other' : 'held',
      o.expires ?? at + 7 * DAY, at, 1],
  );
  const a = await db.run(
    'INSERT INTO article(mode_id, source_id, canonical_url, url, title, published_at, fetched_at, cluster_id, word_count) VALUES(?,?,?,?,?,?,?,?,?)',
    [modeId, sourceId, o.url ?? `https://ai.test/${encodeURIComponent(o.title)}`, o.url ?? `https://ai.test/${encodeURIComponent(o.title)}`, o.title, at, at, c.lastInsertRowId, 920],
  );
  await db.run('UPDATE cluster SET primary_article_id = ? WHERE id = ?', [a.lastInsertRowId, c.lastInsertRowId]);
  return { clusterId: c.lastInsertRowId, articleId: a.lastInsertRowId };
}


/**
 * News as the tests always set it up (the Guardian), plus the AI mode with four sources: a vendor
 * feed (high priority), a blog (normal), a digest (low) and Hacker News (low). Past the cold start
 * unless `cold` is set; the starter profile in place.
 */
export async function aiWorld(opts: { cold?: boolean } = {}) {
  const s = await setup([]);
  await saveModeSettings(s.db, AI_MODE_ID, {
    ...AI_SETTINGS, seeded: true, learningStartedAt: opts.cold ? T0 : T0 - 30 * DAY, lastProfileRewriteAt: T0 - DAY,
  });
  await addProfileVersion(s.db, AI_MODE_ID, AI_STARTER_PROFILE, [], 'starter', T0 - DAY);
  const ai = { modeId: AI_MODE_ID, role: 'primary' as const };
  s.ids.Vendor = await insertSource(s.db, { ...SRC.rss('Vendor', 'centre', ai), priority: 'high' });
  s.ids.Blog = await insertSource(s.db, { ...SRC.rss('Blog', 'centre', ai), priority: 'normal' });
  s.ids.Digest = await insertSource(s.db, { ...SRC.rss('Digest', 'centre', ai), endpoint: 'https://digest.test/rss.xml', priority: 'low', isDigest: true });
  s.ids.HN = await insertSource(s.db, {
    ...SRC.rss('Hacker News', 'centre', ai), adapter: 'hn_api', priority: 'low',
    endpoint: 'https://hn.test/v0/topstories.json\nhttps://hn.test/v0/beststories.json', config: { minPoints: 150, keywords: ['AI', 'agent', 'model'] },
  });
  s.world.pages.set('https://digest.test/rss.xml', digestFeedXml(s.world, []));
  hnFixtures(s.world, []);
  // Items no story registered (split from digests, say) are each their own subject.
  s.world.fallbackVector = (text) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    // A dense pseudo-random direction: two such vectors are nearly orthogonal.
    const v = Array.from({ length: 64 }, () => {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      return h / 4294967296 - 0.5;
    });
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    return v.map((x) => x / n);
  };
  return { ...s, vendorFeed: feedUrl('Vendor'), blogFeed: feedUrl('Blog') };
}
