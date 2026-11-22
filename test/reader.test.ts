import { ensureBody, type Files } from '../src/reader/body';
import { extractArticle, pickSrcset, resolveUrl, sanitizeHtml } from '../src/reader/extract';
import { applyImageMap, buildReaderHtml } from '../src/reader/html';
import { saveForLater, ensureSession } from '../src/core/feed';
import { loadSettings, saveSettings } from '../src/core/settings';
import { SRC, feedUrl, setup } from './helpers/world';

const para = 'The council voted on Tuesday night to approve the plan after a long and heated debate in the chamber. ';
const PAGE = (body: string) => `<!doctype html><html><head><title>Page</title>
<script>window.tracking = "<p>not content</p>";</script><style>.x{color:red}</style></head>
<body><nav><ul><li><a href="/">Home</a></li><li><a href="/news">News</a></li><li><a href="/sport">Sport</a></li></ul></nav>
<article><h1>Council approves plan</h1>
<figure><picture><source srcset="https://img.test/lead.jpg?width=465&dpr=1 465w, https://img.test/lead.jpg?width=700&dpr=1 700w"><img src="https://img.test/lead.jpg?width=300" alt="Town hall"></picture>
<figcaption>The town hall. Photograph: A Photographer</figcaption></figure>
<div class="body">${body}</div></article>
<footer><p>Copyright</p></footer></body></html>`;

const BODY = `<p>${para.repeat(3)}</p><p onclick="steal()">${para.repeat(3)}<a href="/news/related" onmouseover="x()">related story</a></p>
<figure><img src="/images/inline.jpg" alt="Inline"><figcaption>Inline caption</figcaption></figure>
<script>alert(1)</script><iframe src="https://evil.test"></iframe>
<p>${para.repeat(3)}<a href="javascript:alert(1)">bad link</a></p><p>${para.repeat(2)}</p>`;

describe('extraction and sanitising', () => {
  test('pulls out body text, inline photos, captions and the lead picture', () => {
    const ex = extractArticle(PAGE(BODY), 'https://outlet.test/news/council-plan')!;
    expect(ex).not.toBeNull();
    expect(ex.textLength).toBeGreaterThan(900);
    expect(ex.html).toContain('The council voted on Tuesday night');
    expect(ex.html).toContain('<figcaption>Inline caption</figcaption>');
    // Relative URLs are resolved; the lead picture uses a size that is sharp on a phone.
    expect(ex.images).toEqual(['https://img.test/lead.jpg?width=700&dpr=1', 'https://outlet.test/images/inline.jpg']);
    expect(ex.html.indexOf('lead.jpg')).toBeLessThan(ex.html.indexOf('The council voted'));
    expect(ex.html).toContain('href="https://outlet.test/news/related"');
  });

  test('scripts, frames, event handlers and javascript: links never survive', () => {
    const ex = extractArticle(PAGE(BODY), 'https://outlet.test/news/council-plan')!;
    for (const bad of ['<script', '<iframe', 'onclick', 'onmouseover', 'javascript:', 'alert(1)', 'steal()', 'evil.test', '<style', 'not content']) {
      expect(ex.html).not.toContain(bad);
    }
    expect(ex.html).not.toContain('Home');
    const direct = sanitizeHtml('<p style="x" class="y">Hi <img src="x" onerror="alert(1)"><b>there</b></p><form><input></form><svg><script>1</script></svg>', 'https://a.test/b/c');
    expect(direct.html).toBe('<p>Hi <img src="https://a.test/b/x" alt=""><b>there</b></p>');
  });

  test('pages with no article in them fail cleanly', () => {
    expect(extractArticle('<html><body><p>Subscribe to read.</p></body></html>', 'https://x.test/a')).toBeNull();
    expect(extractArticle('', 'https://x.test/a')).toBeNull();
    expect(extractArticle(PAGE('<p>Too short.</p>'), 'https://x.test/a')).toBeNull();
  });

  test('url and srcset helpers', () => {
    expect(resolveUrl('//cdn.test/a.jpg', 'https://x.test/p/q')).toBe('https://cdn.test/a.jpg');
    expect(resolveUrl('b.jpg', 'https://x.test/p/q')).toBe('https://x.test/p/b.jpg');
    expect(resolveUrl('data:image/png;base64,AAAA', 'https://x.test/')).toBeNull();
    expect(resolveUrl('mailto:a@b.test', 'https://x.test/')).toBeNull();
    expect(pickSrcset('a.jpg 320w, b.jpg 640w, c.jpg 1280w')).toBe('b.jpg');
    expect(pickSrcset('a.jpg 320w, b.jpg 480w')).toBe('b.jpg');
  });
});

describe('reader page', () => {
  const doc = {
    title: 'A <b>bold</b> headline', byline: 'Jo Writer', sourceName: 'Guardian', section: 'Politics',
    publishedAt: Date.UTC(2026, 10, 20, 9, 5), leadImage: 'https://img.test/thumb.jpg',
    bodyHtml: '<p>Body text.</p><figure><img src="https://img.test/inline.jpg?a=1&amp;b=2" alt=""></figure>',
    textSize: 20, dark: true, imageMap: {},
  };

  test('headline, byline, date, lead image and body with the app stylesheet', () => {
    const html = buildReaderHtml(doc);
    expect(html).toContain('<h1>A &lt;b&gt;bold&lt;/b&gt; headline</h1>');
    expect(html).toContain('Jo Writer');
    expect(html).toContain('20 Nov 2026');
    expect(html).toContain('<figure class="lead"><img src="https://img.test/thumb.jpg"');
    expect(html).toContain('<body class="dark" style="font-size:20px">');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<p>Body text.</p>');
  });

  test('no duplicate lead image when the body already opens with a picture', () => {
    const html = buildReaderHtml({ ...doc, bodyHtml: '<figure><img src="https://img.test/big.jpg" alt=""></figure><p>Body.</p>' });
    expect(html).not.toContain('class="lead"');
  });

  test('offline copies replace remote image URLs', () => {
    const map = { 'https://img.test/inline.jpg?a=1&b=2': 'file:///data/articles/7/1.jpg', 'https://img.test/thumb.jpg': 'file:///data/articles/7/0.jpg' };
    const html = buildReaderHtml({ ...doc, imageMap: map });
    expect(html).toContain('src="file:///data/articles/7/1.jpg"');
    expect(html).toContain('src="file:///data/articles/7/0.jpg"');
    expect(html).not.toContain('https://img.test/inline.jpg');
    expect(applyImageMap('<img src="https://other.test/x.jpg">', map)).toBe('<img src="https://other.test/x.jpg">');
  });
});

describe('reader fallbacks', () => {
  async function world() {
    const s = await setup([SRC.rss('Daily Mail', 'right'), SRC.rss('The Telegraph', 'right', { readerMode: 'browser', paywalled: true }), SRC.rss('Paywalled Extract', 'right', { paywalled: true })]);
    s.world.addGuardian([
      { title: 'Good page', topic: 1, image: 'https://media.test/good-thumb.jpg' },
      { title: 'Broken page', topic: 2, image: 'https://media.test/broken-thumb.jpg' },
      { title: 'Missing page', topic: 3 },
      { title: 'Live blog', topic: 4, tone: 'live' },
    ]);
    s.world.addFeed(feedUrl('Daily Mail'), [{ title: 'Mail no body', topic: 5 }]);
    s.world.addFeed(feedUrl('The Telegraph'), [{ title: 'Telegraph story', topic: 6 }]);
    s.world.addFeed(feedUrl('Paywalled Extract'), [{ title: 'Paywalled story', topic: 7 }]);
    s.world.pages.set('https://www.theguardian.test/news/good-page', PAGE(BODY));
    s.world.pages.set('https://www.theguardian.test/news/broken-page', '<html><body><div id="app"></div></body></html>');
    await s.run();
    const id = async (title: string) => (await s.db.get<{ id: number }>('SELECT id FROM article WHERE title = ?', [title]))!.id;
    const saved: string[] = [];
    const files: Files = {
      async saveImage(articleId, url, index) {
        if (url.includes('fail')) return null;
        saved.push(url);
        return `file:///data/articles/${articleId}/${index}.jpg`;
      },
      async removeArticles() {},
    };
    const deps = { db: s.db, fetch: s.world.fetch, secrets: s.secrets, now: () => s.world.now, files };
    return { ...s, id, deps, saved };
  }

  test('a good page is extracted, with images stored for offline reading', async () => {
    const w = await world();
    const id = await w.id('Good page');
    // Refresh already prefetched it (top of the feed); ask again with image caching.
    const res = await ensureBody(w.deps, id, { withImages: true });
    expect(res).toMatchObject({ status: 'ok', source: 'extract' });
    const row = await w.db.get<any>('SELECT body_html, offline_images FROM article WHERE id = ?', [id]);
    expect(row.body_html).toContain('The council voted');
    const map = JSON.parse(row.offline_images);
    expect(Object.keys(map)).toEqual(expect.arrayContaining(['https://media.test/good-thumb.jpg', 'https://img.test/lead.jpg?width=700&dpr=1']));
    expect(w.saved.length).toBe(3);
  });

  test('if extraction fails the reader falls back to the adapter body and thumbnail, not an error', async () => {
    const w = await world();
    for (const title of ['Broken page', 'Missing page']) {
      const id = await w.id(title);
      const res = await ensureBody(w.deps, id, { withImages: true, force: true });
      expect(res).toMatchObject({ status: 'ok', source: 'api' });
      const row = await w.db.get<any>('SELECT body_html, image_url, offline_images FROM article WHERE id = ?', [id]);
      expect(row.body_html).toContain(`API body for ${title}`);
      expect(row.image_url).toBeTruthy(); // the thumbnail is the lead image
      const html = buildReaderHtml({
        title, byline: null, sourceName: 'Guardian', section: null, publishedAt: w.world.now, leadImage: row.image_url,
        bodyHtml: row.body_html, textSize: 18, dark: false, imageMap: JSON.parse(row.offline_images ?? '{}'),
      });
      expect(html).toContain('class="lead"');
    }
    // Failures are counted for the Debug screen.
    expect((await loadSettings(w.db)).extractFailures).toBeGreaterThanOrEqual(2);
    const log = await w.db.all<any>("SELECT summary FROM decision_log WHERE kind = 'extract'");
    expect(log.map((l) => l.summary).join('|')).toContain('Broken page');
  });

  test('with no page and no adapter body the answer is the in-app browser', async () => {
    const w = await world();
    expect((await ensureBody(w.deps, await w.id('Mail no body'), { force: true })).status).toBe('failed');
  });

  test('browser-mode and paywalled sources are never extracted', async () => {
    const w = await world();
    expect((await ensureBody(w.deps, await w.id('Telegraph story'))).status).toBe('browser');
    expect((await ensureBody(w.deps, await w.id('Paywalled story'))).status).toBe('browser');
    const n = await w.db.get<{ n: number }>("SELECT COUNT(*) n FROM article a JOIN source s ON s.id = a.source_id WHERE s.paywalled = 1 AND a.body_html IS NOT NULL");
    expect(n!.n).toBe(0);
  });

  test('Guardian live blogs show the latest 20 blocks from the API, newest first', async () => {
    const w = await world();
    const id = await w.id('Live blog');
    const res = await ensureBody(w.deps, id, { force: true });
    expect(res).toMatchObject({ status: 'ok', source: 'live' });
    const row = await w.db.get<any>('SELECT body_html FROM article WHERE id = ?', [id]);
    expect((row.body_html.match(/class="live-block"/g) ?? []).length).toBe(20);
    expect(row.body_html.indexOf('Update 25')).toBeLessThan(row.body_html.indexOf('Update 24'));
    expect(row.body_html).not.toContain('Update 5<');
  });

  test('refresh prefetches bodies for the top of the feed and for Read later, and respects Wi-Fi only', async () => {
    const w = await world();
    const withBody = async () => (await w.db.all<{ title: string }>('SELECT title FROM article WHERE body_html IS NOT NULL ORDER BY title')).map((r) => r.title);
    expect(await withBody()).toEqual(['Broken page', 'Good page', 'Live blog', 'Missing page']);

    // Off Wi-Fi with the default setting: nothing is prefetched.
    const s2 = await setup([]);
    s2.world.addGuardian([{ title: 'Good page', topic: 1 }]);
    s2.world.pages.set('https://www.theguardian.test/news/good-page', PAGE(BODY));
    s2.deps.isWifi = async () => false;
    const r = await s2.run();
    expect(r.steps.find((x) => x.name.startsWith('8'))!.info).toMatch(/not on Wi-Fi/);
    expect((await s2.db.get<{ n: number }>('SELECT COUNT(*) n FROM article WHERE body_html IS NOT NULL'))!.n).toBe(0);
    // With the setting off, mobile data is fine.
    await saveSettings(s2.db, { wifiOnlyPrefetch: false });
    s2.world.now += 3600_000;
    await s2.run();
    expect((await s2.db.get<{ n: number }>('SELECT COUNT(*) n FROM article WHERE body_html IS NOT NULL'))!.n).toBe(1);
  });

  test('a perspective article saved for later is fetched at the next refresh', async () => {
    const w = await world();
    w.world.pages.set('https://daily-mail.test/mail-no-body', PAGE(BODY));
    const id = await w.id('Mail no body');
    const { sessionId } = await ensureSession(w.db, w.world.now);
    await saveForLater(w.db, id, sessionId, w.world.now);
    w.world.now += 7 * 3600_000;
    await w.run();
    expect((await w.db.get<any>('SELECT body_html FROM article WHERE id = ?', [id])).body_html).toContain('The council voted');
  });
});
