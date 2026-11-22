import { fetchSource, googleNewsUrl, parseFeed, passesSectionFilter, sectionFromUrl } from '../src/adapters';
import { loadFeed, ensureSession } from '../src/core/feed';
import { loadSettings } from '../src/core/settings';
import { testSource, validateSourceKey } from '../src/core/sourceTest';
import {
  DEFAULT_SOURCES, createSource, deleteSource, duplicateSource, effectiveReaderMode, exportSources, getSource,
  importSources, listSources, seedDefaultSources, sourceHealth, updateSource, SourceRuleError,
} from '../src/core/sources';
import type { SourceInput } from '../src/core/types';
import { canonicalUrl, redact } from '../src/core/util';
import { freshDb, memorySecrets } from './helpers/nodeDb';
import { HOUR, SRC, feedUrl, setup } from './helpers/world';

describe('canonical URLs and redaction', () => {
  test('strips query strings, tracking parameters, fragments and trailing slashes', () => {
    expect(canonicalUrl('https://www.Example.com/news/story-1/?utm_source=x&fbclid=abc#top')).toBe('https://example.com/news/story-1');
    expect(canonicalUrl('http://example.com/news/story-1')).toBe('https://example.com/news/story-1');
    expect(canonicalUrl('https://example.com/a?id=42&utm_campaign=z')).toBe('https://example.com/a?id=42');
  });

  test('redact removes keys from URLs, headers and free text', () => {
    const key = 'abcd1234-secret-guardian-key';
    const msg = redact(`GET https://content.guardianapis.com/search?api-key=${key}&page=1 failed; Authorization: Bearer sk-or-v1-0123456789abcdef`, [key]);
    expect(msg).not.toContain(key);
    expect(msg).not.toContain('sk-or-v1-0123456789abcdef');
  });
});

describe('feed parsing', () => {
  test('RSS 2.0 with media, categories and CDATA', () => {
    const items = parseFeed(`<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <item><title><![CDATA[Minister resigns &amp; row grows]]></title><link>https://x.test/politics/minister-resigns</link>
      <description><![CDATA[<p>The <b>minister</b> quit.</p>]]></description><pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate>
      <category>Politics</category><dc:creator>A Writer</dc:creator>
      <media:content url="https://img.test/small.jpg" width="140"/><media:content url="https://img.test/big.jpg" width="460"/></item>
    </channel></rss>`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Minister resigns & row grows', summary: 'The minister quit.', section: 'Politics',
      byline: 'A Writer', imageUrl: 'https://img.test/big.jpg', publishedAt: Date.UTC(2026, 10, 20, 10),
    });
  });

  test('Atom', () => {
    const items = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom story</title>
      <link rel="alternate" href="https://x.test/world/atom-story"/><updated>2026-11-20T10:00:00Z</updated>
      <summary>Short summary</summary><category term="World"/><author><name>B Writer</name></author></entry></feed>`);
    expect(items[0]).toMatchObject({ title: 'Atom story', url: 'https://x.test/world/atom-story', section: 'World', byline: 'B Writer' });
  });

  test('rejects things that are not feeds', () => {
    expect(() => parseFeed('<html><body>Not found</body></html>')).toThrow();
  });

  test('section comes from the URL path when the feed has no category', () => {
    expect(sectionFromUrl('https://www.thesun.co.uk/news/politics/12345/some-headline/')).toBe('politics');
  });

  test('section filters match section, tags and URL path', () => {
    const item = { url: 'https://x.test/sport/football/match-report', title: 't', section: 'Football', tags: ['Premier League'] };
    expect(passesSectionFilter(item, [], ['sport'])).toBe(false);
    expect(passesSectionFilter(item, [], ['premier league'])).toBe(false);
    expect(passesSectionFilter(item, ['politics'], [])).toBe(false);
    expect(passesSectionFilter(item, ['football'], [])).toBe(true);
    expect(passesSectionFilter(item, [], ['showbiz'])).toBe(true);
  });

  test('Google News search builds a query URL and strips the outlet suffix', async () => {
    expect(googleNewsUrl('site:thetimes.com')).toContain('q=site%3Athetimes.com%20when%3A2d');
    const xml = `<rss><channel><item><title>PM faces revolt over budget - The Times</title>
      <link>https://news.google.com/rss/articles/CBMiabc?oc=5</link><pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate>
      <description>&lt;a href="x"&gt;PM faces revolt&lt;/a&gt;</description></item></channel></rss>`;
    const { items } = await fetchSource(
      { adapter: 'google_news_search', endpoint: 'site:thetimes.com', name: 'The Times', includeSections: [], excludeSections: [] },
      { fetch: async () => ({ ok: true, status: 200, text: async () => xml, json: async () => ({}) }), since: 0, now: Date.UTC(2026, 10, 20, 12) },
    );
    expect(items[0].title).toBe('PM faces revolt over budget');
    expect(items[0].summary).toBe('');
  });
});

describe('sources are data', () => {
  test('first run seeds the default sources with the Guardian as the only primary', async () => {
    const db = await freshDb();
    await seedDefaultSources(db);
    await seedDefaultSources(db); // idempotent
    const all = await listSources(db);
    expect(all).toHaveLength(DEFAULT_SOURCES.length);
    expect(all.filter((s) => s.role === 'primary').map((s) => s.name)).toEqual(['Guardian']);
    expect(all.find((s) => s.name === 'The Telegraph')).toMatchObject({ paywalled: true, readerMode: 'browser', lean: 'right' });
  });

  test('every field of every source, the Guardian included, can be edited and is stored', async () => {
    const db = await freshDb();
    await seedDefaultSources(db);
    for (const s of await listSources(db)) {
      const edited: SourceInput = {
        name: s.name + ' edited',
        adapter: 'rss',
        endpoint: 'https://edited.test/feed.xml\nhttps://edited.test/feed2.xml',
        apiKeyRef: s.apiKeyRef,
        role: s.role === 'primary' ? 'primary' : 'perspective',
        lean: 'centre-right',
        readerMode: 'api_body',
        paywalled: !s.paywalled,
        includeSections: ['politics', 'uk'],
        excludeSections: ['sport'],
        refreshMinutes: 45,
        enabled: s.role === 'primary' ? true : !s.enabled,
      };
      await updateSource(db, s.id, edited);
      const after = (await getSource(db, s.id))!;
      expect(after).toMatchObject({ ...edited, apiKeyRef: s.apiKeyRef });
    }
  });

  test('an edit applies at the next refresh', async () => {
    const { db, world, ids, run } = await setup([SRC.rss('BBC News', 'centre')]);
    world.addGuardian([{ title: 'Guardian story one', topic: 1 }]);
    world.addFeed(feedUrl('BBC News'), [{ title: 'BBC politics story', topic: 2, section: 'Politics' }, { title: 'BBC sport story', topic: 3, section: 'Sport' }]);
    world.addFeed('https://bbc-news.test/other.xml', [{ title: 'From the other endpoint', topic: 4 }]);
    await run();
    const titles = async () => (await db.all<{ title: string }>('SELECT title FROM article WHERE source_id = ? ORDER BY title', [ids['BBC News']])).map((r) => r.title);
    expect(await titles()).toEqual(['BBC politics story', 'BBC sport story']);

    const bbc = (await getSource(db, ids['BBC News']))!;
    await updateSource(db, bbc.id, { ...bbc, endpoint: 'https://bbc-news.test/other.xml' });
    world.now += HOUR;
    await run();
    expect(await titles()).toContain('From the other endpoint');
  });

  test('at least one primary source must stay enabled', async () => {
    const db = await freshDb();
    await seedDefaultSources(db);
    const g = (await listSources(db)).find((s) => s.name === 'Guardian')!;
    await expect(updateSource(db, g.id, { ...g, enabled: false })).rejects.toThrow(SourceRuleError);
    await expect(updateSource(db, g.id, { ...g, role: 'perspective' })).rejects.toThrow(SourceRuleError);
    await expect(deleteSource(db, memorySecrets(), g.id)).rejects.toThrow(SourceRuleError);
    expect((await getSource(db, g.id))!.enabled).toBe(true);
    // With a second primary in place the Guardian can be switched off.
    const bbc = (await listSources(db)).find((s) => s.name === 'BBC News')!;
    await updateSource(db, bbc.id, { ...bbc, role: 'primary' });
    await updateSource(db, g.id, { ...g, enabled: false });
    expect((await getSource(db, g.id))!.enabled).toBe(false);
  });

  test('add, duplicate and delete', async () => {
    const db = await freshDb();
    await seedDefaultSources(db);
    const secrets = memorySecrets();
    const id = await createSource(db, SRC.rss('New Outlet', 'centre-left'));
    const copy = await duplicateSource(db, id);
    expect(await getSource(db, copy)).toMatchObject({ name: 'New Outlet copy', enabled: false, lean: 'centre-left' });
    await deleteSource(db, secrets, id);
    expect(await getSource(db, id)).toBeNull();
    await expect(createSource(db, { ...SRC.rss('Bad', 'centre'), endpoint: 'not a url' })).rejects.toThrow(SourceRuleError);
  });

  test('paywalled sources never use extract', () => {
    expect(effectiveReaderMode({ readerMode: 'extract', paywalled: true })).toBe('browser');
    expect(effectiveReaderMode({ readerMode: 'extract', paywalled: false })).toBe('extract');
    expect(effectiveReaderMode({ readerMode: 'api_body', paywalled: true })).toBe('api_body');
  });

  test('export then import round-trips every field except keys', async () => {
    const db = await freshDb();
    await seedDefaultSources(db);
    const secrets = memorySecrets({ source_key_guardian: 'super-secret-guardian-key' });
    const g = (await listSources(db)).find((s) => s.name === 'Guardian')!;
    await updateSource(db, g.id, { ...g, includeSections: ['politics'], excludeSections: ['sport', 'football'], refreshMinutes: 20 });
    const exported = await exportSources(db);
    const json = JSON.stringify(exported);
    expect(json).not.toContain('super-secret-guardian-key');
    expect(json).not.toContain('apiKeyRef');
    expect(json).not.toContain('source_key_guardian');

    // Import into a fresh install.
    const db2 = await freshDb();
    await seedDefaultSources(db2);
    const first = (await listSources(db2))[1];
    await db2.run('DELETE FROM source WHERE id = ?', [first.id]);
    expect(await importSources(db2, memorySecrets(), json)).toBe(exported.sources.length);
    expect((await exportSources(db2)).sources.sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual(exported.sources.slice().sort((a, b) => a.name.localeCompare(b.name)));

    // Importing over the same install keeps ids, and so the stored key.
    await importSources(db, secrets, json);
    const g2 = (await listSources(db)).find((s) => s.name === 'Guardian')!;
    expect(g2.id).toBe(g.id);
    expect(g2.apiKeyRef).toBe('source_key_guardian');
    expect(await secrets.get('source_key_guardian')).toBe('super-secret-guardian-key');
  });

  test('import rejects bad files and sets with no primary', async () => {
    const db = await freshDb();
    await seedDefaultSources(db);
    const secrets = memorySecrets();
    await expect(importSources(db, secrets, 'not json')).rejects.toThrow(SourceRuleError);
    await expect(importSources(db, secrets, JSON.stringify({ sources: [SRC.rss('Only perspective', 'right')] }))).rejects.toThrow(/primary/);
    await expect(importSources(db, secrets, JSON.stringify({ sources: [{ name: 'x', adapter: 'ftp' }] }))).rejects.toThrow(SourceRuleError);
    expect(await listSources(db)).toHaveLength(DEFAULT_SOURCES.length);
  });
});

describe('feed health and failure isolation', () => {
  test('a source with a broken endpoint shows red, and the other sources still refresh', async () => {
    const { db, world, ids, run } = await setup([SRC.rss('BBC News', 'centre'), SRC.rss('Daily Mail', 'right')]);
    world.addGuardian([{ title: 'Guardian story', topic: 1 }]);
    world.addFeed(feedUrl('BBC News'), [{ title: 'BBC story', topic: 2 }]);
    world.broken.add(feedUrl('Daily Mail'));
    const res = await run();
    expect(res.steps[0].ok).toBe(true);
    const byName = Object.fromEntries((await listSources(db)).map((s) => [s.name, s]));
    expect(sourceHealth(byName['Daily Mail'], world.now)).toBe('red');
    expect(byName['Daily Mail'].lastError).toContain('503');
    expect(sourceHealth(byName['BBC News'], world.now)).toBe('green');
    expect(sourceHealth(byName['Guardian'], world.now)).toBe('green');
    const n = await db.get<{ n: number }>('SELECT COUNT(*) n FROM article');
    expect(n!.n).toBe(2);

    // Fixed feed: back to green at the next refresh.
    world.broken.clear();
    world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail story', topic: 3 }]);
    world.now += HOUR;
    await run();
    expect(sourceHealth((await getSource(db, ids['Daily Mail']))!, world.now)).toBe('green');
    // Nothing new for 24 hours: amber.
    expect(sourceHealth((await getSource(db, ids['Daily Mail']))!, world.now + 25 * HOUR)).toBe('amber');
  });

  test('a wrong API key is an error on that source only, and the key never reaches the database', async () => {
    const { db, world, secrets, run } = await setup([SRC.rss('BBC News', 'centre')]);
    await secrets.set('source_key_guardian', 'wrong-key-value-xyz');
    world.addGuardian([{ title: 'Guardian story', topic: 1 }]);
    world.addFeed(feedUrl('BBC News'), [{ title: 'BBC story', topic: 2 }]);
    await run();
    const g = (await listSources(db)).find((s) => s.name === 'Guardian')!;
    expect(g.lastError).toContain('401');
    const dump = JSON.stringify(await db.all('SELECT * FROM source')) + JSON.stringify(await db.all('SELECT * FROM refresh_run')) +
      JSON.stringify(await db.all('SELECT * FROM decision_log')) + JSON.stringify(await db.all('SELECT * FROM setting'));
    expect(dump).not.toContain('wrong-key-value-xyz');
    expect(dump).not.toContain('sk-or-test-key-123456');
  });
});

describe('primary sources', () => {
  test('two primary sources at once produce a single merged feed', async () => {
    const { db, world, ids, run } = await setup([SRC.rss('BBC News', 'centre'), SRC.rss('Daily Mail', 'right')]);
    world.addGuardian([{ title: 'Guardian one', topic: 1, hoursAgo: 1 }, { title: 'Guardian two', topic: 2, hoursAgo: 5 }]);
    world.addFeed(feedUrl('BBC News'), [{ title: 'BBC one', topic: 3, hoursAgo: 2 }, { title: 'BBC two', topic: 4, hoursAgo: 3 }]);
    world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail one', topic: 5, hoursAgo: 1 }]);
    const bbc = (await getSource(db, ids['BBC News']))!;
    await updateSource(db, bbc.id, { ...bbc, role: 'primary' });
    await run();
    const { sessionId } = await ensureSession(db, world.now);
    const feed = await loadFeed(db, await loadSettings(db), sessionId, world.now);
    // One list, interleaved by score (here: freshness), with nothing from the perspective source.
    expect(feed.map((c) => c.article.title)).toEqual(['Guardian one', 'BBC one', 'BBC two', 'Guardian two']);
    expect(new Set(feed.map((c) => c.sourceName))).toEqual(new Set(['Guardian', 'BBC News']));
  });

  test('making BBC primary and disabling the Guardian gives a BBC-only feed', async () => {
    const { db, world, ids, run } = await setup([SRC.rss('BBC News', 'centre'), SRC.rss('Daily Mail', 'right'), SRC.rss('Daily Express', 'right')]);
    world.addGuardian([{ title: 'Guardian one', topic: 1 }]);
    world.addFeed(feedUrl('BBC News'), [{ title: 'BBC: minister resigns', topic: 3 }]);
    world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail: minister resigns', topic: 3 }, { title: 'Mail: bins row', topic: 7 }]);
    world.addFeed(feedUrl('Daily Express'), [{ title: 'Express: bins row', topic: 7 }]);
    await run();
    const bbc = (await getSource(db, ids['BBC News']))!;
    await updateSource(db, bbc.id, { ...bbc, role: 'primary' });
    const g = (await getSource(db, ids.Guardian))!;
    await updateSource(db, g.id, { ...g, enabled: false });
    world.now += HOUR;
    await run();
    const { sessionId } = await ensureSession(db, world.now);
    const feed = await loadFeed(db, await loadSettings(db), sessionId, world.now);
    expect(feed.map((c) => c.sourceName)).toEqual(['BBC News']);
    // Second sources still work against the new primary.
    expect(feed[0].second).toMatchObject({ sourceName: 'Daily Mail' });
  });
});

describe('Test button and key validation', () => {
  test('Test shows the first five items, newest first, or the error', async () => {
    const { world } = await setup([]);
    world.addFeed(feedUrl('BBC News'), Array.from({ length: 8 }, (_, i) => ({ title: `BBC item ${i}`, topic: i, hoursAgo: i + 1 })));
    const bbc = SRC.rss('BBC News', 'centre');
    const ok = await testSource(world.fetch, bbc, null, world.now);
    expect(ok.error).toBeNull();
    expect(ok.total).toBe(8);
    expect(ok.items.map((i) => i.title)).toEqual(['BBC item 0', 'BBC item 1', 'BBC item 2', 'BBC item 3', 'BBC item 4']);

    world.broken.add(feedUrl('BBC News'));
    const bad = await testSource(world.fetch, bbc, null, world.now);
    expect(bad).toMatchObject({ ok: false, items: [] });
    expect(bad.error).toContain('503');

    // A keyed source with no key, a wrong key and the right key.
    world.addGuardian([{ title: 'Guardian item', topic: 1 }]);
    expect((await testSource(world.fetch, SRC.guardian, null, world.now)).error).toMatch(/No API key/);
    const wrong = await validateSourceKey(world.fetch, SRC.guardian, 'wrong-key-abcdef', world.now);
    expect(wrong).toBe('Guardian rejected this key.');
    expect(await validateSourceKey(world.fetch, SRC.guardian, 'good-guardian-key', world.now)).toBeNull();
    expect((await testSource(world.fetch, SRC.guardian, 'good-guardian-key', world.now)).items[0].title).toBe('Guardian item');
  });
});
