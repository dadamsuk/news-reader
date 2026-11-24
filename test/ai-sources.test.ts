/**
 * Sources for sections-layout modes (PRD "AI mode: sources"): the hn_api and html_list adapters,
 * digest splitting, and the source fields.
 */
import { fetchSource } from '../src/adapters';
import { parseHtmlList, splitDigestIssue } from '../src/adapters/sections';
import { AI_DEFAULT_SOURCES } from '../src/core/modes';
import { testSource } from '../src/core/sourceTest';
import { validateSource } from '../src/core/sources';
import type { SourceInput } from '../src/core/types';
import { digestFeedXml, digestIssueHtml, hnFixtures } from './helpers/ai';
import { T0, World } from './helpers/world';

const HOUR = 3600_000;

const src = (o: Partial<SourceInput>): SourceInput => ({
  name: 'x', adapter: 'rss', endpoint: 'https://x.test/feed', apiKeyRef: null, role: 'primary', lean: 'centre', readerMode: 'extract',
  paywalled: false, includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true, ...o,
});

describe('digest splitting', () => {
  test('a digest issue with 12 linked stories produces 12 items, not 1', async () => {
    const world = new World();
    world.pages.set('https://digest.test/rss.xml', digestFeedXml(world, [{ url: 'https://digest.test/issues/42', title: 'Issue 42', html: digestIssueHtml(12), hoursAgo: 3 }]));
    const { items } = await fetchSource(
      src({ endpoint: 'https://digest.test/rss.xml', isDigest: true }),
      { fetch: world.fetch, since: world.now - 7 * 24 * HOUR, now: world.now },
    );
    expect(items).toHaveLength(12);
    // Each story has its own link (the post, not the social thread), its own title and the digest's words.
    expect(items[0]).toMatchObject({
      url: 'https://vendor0.test/blog/post-1?utm_source=digest',
      title: 'Story 1: A lab released something numbered 1 with a 20% gain (thread, post).',
      mentionUrl: 'https://digest.test/issues/42',
    });
    expect(items[0].digestContext).toContain('Reaction: people discussed it');
    expect(new Set(items.map((i) => i.url)).size).toBe(12);
    expect(items.some((i) => /sponsor|unsubscribe|issues\/41/.test(i.url))).toBe(false);
    expect(items.every((i) => i.publishedAt === world.now - 3 * HOUR)).toBe(true);
  });

  test('an issue that is only a link (TLDR) is fetched and split from its page; sponsors are skipped', async () => {
    const world = new World();
    const page = `<html><body>
      <article><a href="https://ref.sponsor.test/x"><h3>Say it faster (Sponsor)</h3></a><div>Buy it.</div></article>
      ${Array.from({ length: 4 }, (_, i) => `<article><a href="https://site${i}.test/a?utm_source=tldrai"><h3>Headline number ${i + 1} (${i + 3} minute read)</h3></a>
        <div class="newsletter-html">Blurb ${i + 1} about the thing.</div></article>`).join('')}
      <article><a href="https://forms.gle/abc"><h3>Join our community (2 minute form)</h3></a></article></body></html>`;
    world.pages.set('https://tldr.test/ai/2026-11-20', page);
    world.pages.set('https://tldr.test/rss', digestFeedXml(world, [{ url: 'https://tldr.test/ai/2026-11-20', title: 'Issue', html: null, hoursAgo: 5 }]));
    const { items } = await fetchSource(src({ endpoint: 'https://tldr.test/rss', isDigest: true }), { fetch: world.fetch, since: world.now - 48 * HOUR, now: world.now });
    expect(items.map((i) => i.title)).toEqual(['Headline number 1', 'Headline number 2', 'Headline number 3', 'Headline number 4']);
    expect(items[2]).toMatchObject({ url: 'https://site2.test/a?utm_source=tldrai', digestContext: 'Headline number 3 (5 minute read) Blurb 3 about the thing.' });
  });

  test('the most stories taken from one issue is an option', () => {
    expect(splitDigestIssue(digestIssueHtml(12), { url: 'https://digest.test/i/1', title: 'i' }, 5)).toHaveLength(5);
  });
});

describe('hn_api', () => {
  test('front page and best stories above the points threshold that pass the keyword prefilter', async () => {
    const world = new World();
    hnFixtures(world, [
      { id: 1, title: 'Show HN: An open-source coding agent', score: 420, url: 'https://agent.test/' },
      { id: 2, title: 'Claude gets a new pricing tier', score: 151, url: 'https://claude.test/pricing' },
      { id: 3, title: 'A new LLM benchmark', score: 90, url: 'https://bench.test/' }, // below 150
      { id: 4, title: 'The history of the pencil', score: 800, url: 'https://pencil.test/' }, // not AI
      { id: 5, title: 'Ask HN: How do you use AI at work?', score: 300 }, // no URL: the thread is the story
    ]);
    const { items } = await fetchSource(
      src({ adapter: 'hn_api', endpoint: 'https://hn.test/v0/topstories.json\nhttps://hn.test/v0/beststories.json', config: { minPoints: 150, keywords: ['AI', 'LLM', 'agent', 'Claude'] } }),
      { fetch: world.fetch, since: world.now - 7 * 24 * HOUR, now: world.now },
    );
    expect(items.map((i) => [i.title, i.hnPoints, i.url])).toEqual([
      ['Show HN: An open-source coding agent', 420, 'https://agent.test/'],
      ['Ask HN: How do you use AI at work?', 300, 'https://news.ycombinator.com/item?id=5'],
      ['Claude gets a new pricing tier', 151, 'https://claude.test/pricing'],
    ]);
    expect(items[0].mentionUrl).toBe('https://news.ycombinator.com/item?id=1');
  });
});

describe('html_list', () => {
  const page = `<html><body><nav><a href="/news/announcements">Announcements</a><a href="/news">News</a></nav>
    <div class="card"><a href="/news/claude-frontier-academy"><h3>Anthropic invests in training ten thousand engineers</h3><p>A programme for enterprises.</p></a><time datetime="2026-11-19">Nov 19, 2026</time></div>
    <div class="card"><header><time>Nov 9, 2026</time></header><a href="/news/ipo-close"><h3>Anthropic announces the closing of its offering</h3></a></div>
    <div class="card"><a href="/news/claude-frontier-academy">Read more</a></div>
    <a href="https://elsewhere.test/news/a-long-enough-title-here">An outside link with many words in it</a></body></html>`;

  test('title, link and date from a configured page', () => {
    const items = parseHtmlList(page, 'https://www.vendor.test/news', { linkPattern: '^/news/[a-z0-9][a-z0-9-]+$', minTitleWords: 4 }, T0);
    expect(items.map((i) => [i.url, i.title, new Date(i.publishedAt!).toISOString().slice(0, 10)])).toEqual([
      ['https://www.vendor.test/news/claude-frontier-academy', 'Anthropic invests in training ten thousand engineers', '2026-11-19'],
      ['https://www.vendor.test/news/ipo-close', 'Anthropic announces the closing of its offering', '2026-11-09'],
    ]);
    expect(items[0].summary).toBe('A programme for enterprises.');
  });

  test('the Test button works for the new adapters', async () => {
    const world = new World();
    world.pages.set('https://www.vendor.test/news', page);
    const r = await testSource(world.fetch, { ...src({ adapter: 'html_list', endpoint: 'https://www.vendor.test/news' }), config: { linkPattern: '^/news/[a-z-]+$' } }, null, Date.UTC(2026, 10, 20));
    expect(r.error).toBeNull();
    // The Test button looks back a week: the 9 November card is older than that.
    expect(r.items.map((i) => i.title)).toEqual(['Anthropic invests in training ten thousand engineers']);
  });
});

describe('source record', () => {
  test('the AI defaults are valid records, and digests and aggregators are low priority', () => {
    for (const s of AI_DEFAULT_SOURCES) expect([s.name, validateSource(s)]).toEqual([s.name, []]);
    const low = AI_DEFAULT_SOURCES.filter((s) => s.priority === 'low').map((s) => s.name);
    expect(low).toEqual(['AINews (smol.ai)', 'TLDR AI', 'Hacker News']);
    expect(AI_DEFAULT_SOURCES.filter((s) => s.isDigest).map((s) => s.name)).toEqual(['AINews (smol.ai)', 'TLDR AI']);
    expect(AI_DEFAULT_SOURCES.find((s) => s.name === 'The Pragmatic Engineer')).toMatchObject({ readerMode: 'browser', paywalled: true });
  });

  test('bad priority and options are rejected', () => {
    expect(validateSource(src({ priority: 'urgent' as any }))).toContain('Unknown priority');
    expect(validateSource(src({ config: [] as any }))).toContain('Options must be a JSON object');
    expect(validateSource(src({ adapter: 'hn_api', endpoint: 'https://hn.test/v0/topstories.json' }))).toEqual([]);
  });
});
