#!/usr/bin/env node
/**
 * Mock internet for the Maestro end-to-end flows: a Guardian-style Content API, RSS feeds for the
 * other outlets, article pages with pictures, and an OpenRouter-compatible API with deterministic
 * embeddings and scripted model replies. Nothing here is used by the shipped app.
 *
 *   node tools/mock-server.js [port]        (default 8787; the Android emulator reaches it at 10.0.2.2)
 *
 * Keys the mock accepts:  OpenRouter  sk-or-e2e      Guardian  e2e-guardian
 * Control:  GET /e2e/control?break=daily-mail   make that outlet's feed fail (unbreak=… to restore)
 *           GET /e2e/control?batch=2            publish the second batch of stories
 *           GET /e2e/control?reset=1            back to the start state
 *           GET /e2e/stats                      call counters, as JSON
 *           GET /e2e/ai-sources.json            the AI mode's sources (vendor feed, blog, digest,
 *                                               Hacker News, a news page), for newsreader://e2e?action=aimock
 */
const http = require('http');
const zlib = require('zlib');

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const OPENROUTER_KEY = 'sk-or-e2e';
const GUARDIAN_KEY = 'e2e-guardian';
const DIMS = 64;

// ---------------------------------------------------------------- stories

/** topic: stories on the same topic are the same event. minutes: age when the server starts. */
const GUARDIAN = [
  { t: 1, m: 20, section: 'Politics', title: 'Chancellor raises income tax threshold in autumn budget', summary: 'The chancellor set out a rise in the personal allowance alongside higher duties on gambling.', tags: ['Budget', 'Tax'], words: 900 },
  { t: 2, m: 35, section: 'UK news', title: 'Rail strike to halt most trains across northern England next week', summary: 'Union leaders confirmed three days of walkouts after pay talks collapsed.', tags: ['Rail transport'], words: 700 },
  { t: 3, m: 50, section: 'Society', title: 'NHS waiting list falls for third month in a row', summary: 'Figures show the backlog down by 90,000, though A&E waits lengthened.', tags: ['NHS', 'Health'], words: 800 },
  { t: 4, m: 65, section: 'World news', title: 'Ceasefire talks resume in Cairo as mediators press for a deal', summary: 'Delegations returned to the table after a two-week pause.', tags: ['Middle East'], words: 1100 },
  { t: 5, m: 80, section: 'Science', title: 'Astronomers find water vapour on a rocky planet 40 light years away', summary: 'The detection is the clearest yet for a world of its size.', tags: ['Space', 'Astronomy'], words: 650 },
  { t: 6, m: 95, section: 'Environment', title: 'Beavers to be released into two more English rivers', summary: 'Conservationists say the animals will cut flood risk downstream.', tags: ['Wildlife'], words: 500, long: true },
  { t: 7, m: 110, section: 'Business', title: 'High street bakery chain to open 150 new shops', summary: 'The expansion will create about 2,000 jobs, the company said.', tags: ['Retail industry'], words: 450 },
  { t: 8, m: 125, section: 'Opinion', tone: 'comment', title: 'The budget was cautious, and that is exactly the problem', summary: 'A government with a large majority should be bolder, writes our columnist.', tags: ['Budget'], words: 1000 },
  { t: 9, m: 140, section: 'Culture', title: 'Lost Turner sketchbook goes on show for the first time', summary: 'The pencil studies were found in a private collection in Kent.', tags: ['Art'], words: 600 },
  { t: 10, m: 155, section: 'Technology', title: 'Regulator opens inquiry into app store fees', summary: 'The watchdog will examine whether charges on developers are fair.', tags: ['Apps'], words: 750 },
  { t: 11, m: 170, section: 'Sport', title: 'England name unchanged side for the final Test', summary: 'The captain said the team had earned the right to finish the job.', tags: ['Cricket'], words: 550 },
  { t: 12, m: 185, section: 'Education', title: 'Schools to get new guidance on phones in classrooms', summary: 'Head teachers will be asked to restrict use during lessons.', tags: ['Schools'], words: 620, broken: true },
  { t: 13, m: 200, section: 'Politics', tone: 'analysis', title: 'Why the by-election matters more than its size suggests', summary: 'A small seat has become a test of the opposition\'s recovery.', tags: ['Byelections'], words: 1300 },
  { t: 14, m: 215, section: 'Money', title: 'Savings rates edge up as lenders compete for deposits', summary: 'The best easy-access accounts now pay just over 5%.', tags: ['Savings'], words: 480 },
  { t: 15, m: 230, section: 'Food', title: 'The return of the proper pub lunch', summary: 'Landlords are bringing back pies, puddings and long tables.', tags: ['Pubs'], words: 900 },
  { t: 16, m: 245, section: 'Travel', title: 'Night trains from London to the Alps to return next winter', summary: 'The sleeper service will run twice a week from December.', tags: ['Rail travel'], words: 700 },
];

const FEEDS = {
  'bbc-news': { name: 'BBC News', lean: 'centre', stories: [
    { t: 1, m: 25, section: 'Politics', title: 'Budget: income tax threshold to rise, chancellor confirms', summary: 'The personal allowance will go up next April.' },
    { t: 2, m: 40, section: 'England', title: 'Northern rail passengers face three days of strikes', summary: 'Services will be severely reduced, operators warn.' },
    { t: 30, m: 60, section: 'UK', title: 'Storm warning issued for western Scotland', summary: 'Gusts of up to 80mph are forecast.' },
    { t: 31, m: 90, section: 'Business', title: 'Car production rises for fifth month', summary: 'Exports drove the increase, the trade body said.' },
    { t: 32, m: 120, section: 'Health', title: 'New blood test could spot dementia years earlier', summary: 'Researchers say the test is cheap enough for routine use.' },
  ] },
  'the-telegraph': { name: 'The Telegraph', lean: 'right', paywalled: true, stories: [
    { t: 1, m: 22, section: 'Politics', title: 'Budget tax raid on gambling to fund threshold rise', summary: 'Bookmakers warn of shop closures after duty increase.' },
    { t: 21, m: 70, section: 'News', title: 'Council bans St George\'s flags from lamp posts', summary: 'Residents accuse town hall of an attack on national pride.' },
  ] },
  'daily-mail': { name: 'Daily Mail', lean: 'right', stories: [
    { t: 1, m: 30, section: 'News', title: 'Budget blow for punters as chancellor hikes betting duty', summary: 'Critics brand the move a tax on working-class pleasures.' },
    { t: 20, m: 45, section: 'News', title: 'Hundreds protest outside hotel housing asylum seekers', summary: 'Police made four arrests as crowds gathered for a second night.' },
    { t: 21, m: 75, section: 'News', title: 'Fury as council orders St George\'s flags to be torn down', summary: 'Locals vow to put them back up.' },
    { t: 22, m: 100, section: 'News', title: 'BBC presenter in new bias row over election coverage', summary: 'Viewers complained after a heated interview.' },
  ] },
  'daily-express': { name: 'Daily Express', lean: 'right', stories: [
    { t: 3, m: 55, section: 'News', title: 'NHS waiting list drops again but A&E delays grow', summary: 'Ministers hail progress as doctors urge caution.' },
    { t: 20, m: 48, section: 'News', title: 'Asylum hotel protest: four arrested as tensions rise', summary: 'Demonstrators demand the hotel is closed.' },
  ] },
  'gb-news': { name: 'GB News', lean: 'right', stories: [
    { t: 20, m: 52, section: 'News', title: 'Protesters gather at asylum hotel for second night running', summary: 'Local MP calls for urgent meeting with the Home Office.' },
  ] },
};

const BATCH2 = {
  guardian: [
    { t: 40, m: 2, section: 'Politics', title: 'Prime minister announces surprise cabinet reshuffle', summary: 'Three senior ministers are leaving the government.', tags: ['Cabinet'], words: 800 },
    { t: 1, m: 3, section: 'Politics', tone: 'analysis', title: 'Budget analysis: who gains and who loses from the threshold rise', summary: 'Our economics editor works through the numbers.', tags: ['Budget'], words: 1200 },
  ],
  'daily-mail': [{ t: 40, m: 1, section: 'News', title: 'Reshuffle chaos as three ministers quit cabinet', summary: 'Allies of the prime minister insist the changes were planned.' }],
  'bbc-news': [{ t: 40, m: 2, section: 'Politics', title: 'Three ministers leave cabinet in reshuffle', summary: 'Downing Street says the changes strengthen the team.' }],
};

const DIGEST_SUMMARY = {
  20: 'Protesters are reported to have gathered for a second night outside a hotel housing asylum seekers, with four arrests.',
  21: 'A council is reported to have ordered St George\'s flags to be removed from lamp posts, prompting objections from residents.',
};
const ANGLE_BY_TOPIC = {
  40: 'Calls it chaos; leads on the departures rather than the appointments.',
};
const ANGLE = {
  'BBC News': 'Leads on the confirmed date; plainer on who pays for it.',
  'The Telegraph': 'Leads on the gambling duty rise and bookmakers\' warnings of closures.',
  'Daily Mail': 'Frames the duty rise as a blow to punters; quotes critics first.',
  'Daily Express': 'Gives equal weight to longer A&E delays and doctors\' caution.',
};

// ---------------------------------------------------------------- the AI mode's stories

/**
 * src: vendor (high priority RSS), blog (normal), lab (html_list page, high). hn: Hacker News points
 * (the HN item links to the same URL, so it is coverage of the same story). digest: also in the digest
 * issue. left: off-profile but significant (lands in In other news). t: topic (same topic, same story).
 */
const AI = [
  { t: 101, m: 30, src: 'vendor', hn: 320, digest: true, title: 'Vendor makes its coding agent generally available', short: 'Coding agent now generally available', summary: 'The agent opens pull requests and fixes failing checks; pricing starts at $19 a seat.' },
  { t: 101, m: 25, src: 'blog', title: 'Notes on the coding agent going GA', summary: 'A first look at the agent in a real repository.' },
  { t: 102, m: 40, src: 'lab', title: 'Lab publishes study of AI pair programming at 40 companies', short: 'Study: AI pairing at 40 companies', summary: 'Teams merged 12% more pull requests, with more review time.' },
  { t: 103, m: 50, src: 'vendor', left: true, hn: 650, title: 'Vendor announces a humanoid robot for warehouses', short: 'Humanoid robot for warehouses announced', summary: 'The robot lifts 20kg and ships next year.' },
  { t: 104, m: 55, src: 'vendor', left: true, hn: 700, title: 'Vendor releases an image model for film studios', short: 'Image model for film studios released', summary: 'It renders 4K frames in under a second.' },
  { t: 105, m: 60, src: 'vendor', left: true, hn: 610, digest: true, title: 'Vendor launches a consumer AI pendant', short: 'Consumer AI pendant launched', summary: 'The pendant records conversations and costs $99.' },
  ...Array.from({ length: 16 }, (_, i) => ({
    t: 110 + i, m: 70 + i * 5, src: i % 2 ? 'blog' : 'vendor',
    title: `Engineering update ${i + 1}: agents in the build pipeline`, short: `Agents in the build pipeline, part ${i + 1}`,
    summary: `Practical note number ${i + 1} on running coding agents in CI.`,
  })),
];
const aiUrl = (base, s) => (s.src === 'lab' ? `${base}/ai/lab/news/${slug(s.title)}` : `${base}/ai/pages/${slug(s.title)}`);
const aiFind = (title) => AI.find((s) => s.title === title || s.short === title);

function aiRss(base, src) {
  const items = AI.filter((s) => s.src === src).map((s) => `<item>
<title><![CDATA[${s.title}]]></title>
<link>${aiUrl(base, s)}?utm_source=rss</link>
<description><![CDATA[${s.summary}]]></description>
<pubDate>${when(s).toUTCString()}</pubDate>
</item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${src}</title>${items}</channel></rss>`;
}

function aiDigest(base) {
  const lis = AI.filter((s) => s.digest).map((s) => `<li><p>${esc(s.summary)} (<a href="${aiUrl(base, s)}">${esc(s.title)}</a>, <a href="https://x.com/someone/status/${s.t}">thread</a>)</p></li>`).join('');
  const html = `<h2>Top stories</h2><ul>${lis}<li><p>A smaller item about evals (<a href="${base}/ai/pages/eval-notes">Notes on evals for coding agents</a>)</p></li></ul>`;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Digest</title>
<item><title>Digest issue 1</title><link>https://digest.example/issues/1</link><pubDate>${new Date(started - 20 * 60000).toUTCString()}</pubDate>
<content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`;
}

function aiLabPage(base) {
  const cards = AI.filter((s) => s.src === 'lab').map((s) => `<div class="card"><a href="/ai/lab/news/${slug(s.title)}"><h3>${esc(s.title)}</h3></a><time datetime="${when(s).toISOString()}">${when(s).toDateString()}</time></div>`).join('');
  return `<!doctype html><html><body><nav><a href="/ai/lab/news/announcements">Announcements</a></nav>${cards}</body></html>`;
}

function aiSourcesJson(base) {
  const src = (name, adapter, endpoint, priority, extra = {}) => ({
    name, adapter, endpoint, role: 'primary', lean: 'centre', readerMode: 'extract', paywalled: false, includeSections: [], excludeSections: [],
    refreshMinutes: 1, enabled: true, priority, isDigest: false, config: {}, ...extra,
  });
  return {
    version: 1,
    sources: [
      src('Vendor blog', 'rss', `${base}/ai/feeds/vendor.xml`, 'high'),
      src('Lab news', 'html_list', `${base}/ai/lab/news`, 'high', { config: { linkPattern: '^/ai/lab/news/[a-z0-9-]+$', minTitleWords: 4 } }),
      src('Engineering blog', 'rss', `${base}/ai/feeds/blog.xml`, 'normal'),
      src('The Digest', 'rss', `${base}/ai/feeds/digest.xml`, 'low', { isDigest: true }),
      src('Hacker News', 'hn_api', `${base}/ai/hn/v0/topstories.json\n${base}/ai/hn/v0/beststories.json`, 'low', { config: { minPoints: 150, keywords: ['agent', 'AI', 'model', 'robot', 'pendant'] } }),
    ],
  };
}

function aiEnrich(user) {
  const blocks = user.split(/\n\n(?=ITEM )/);
  return {
    items: blocks.map((b) => {
      const id = (/^ITEM (s\d+)/.exec(b) || [])[1];
      const title = (/Headline: (.*)/.exec(b) || [])[1] || '';
      const s = aiFind(title);
      const left = !!(s && s.left);
      return {
        id,
        headline: s ? s.short : title.split(/\s+/).slice(0, 8).join(' '),
        summary: s ? s.summary : 'A short note for engineers.',
        why: left ? '' : 'Bears on how your teams ship code with agents.',
        tags: left ? ['robotics'] : ['coding agents'],
        type: 'release',
        profile_match: left ? 0.05 : 0.85,
        impact: left ? 1 : 0.3,
        profile_lines: left ? [] : ['- Coding agents and tools'],
      };
    }),
  };
}

// ---------------------------------------------------------------- state

const started = Date.now();
let state;
function reset() {
  state = { batch: 1, broken: new Set(), stats: { embeddings: 0, chat: 0, match: 0, digest: 0, guardian: 0, feeds: 0, pages: 0 } };
}
reset();

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const when = (s) => new Date(started - s.m * 60000 + (s.batch2 ? Date.now() - started : 0));

function guardianStories() {
  return state.batch >= 2 ? [...GUARDIAN, ...BATCH2.guardian.map((s) => ({ ...s, batch2: true }))] : GUARDIAN;
}
function feedStories(key) {
  const extra = state.batch >= 2 && BATCH2[key] ? BATCH2[key].map((s) => ({ ...s, batch2: true })) : [];
  return [...FEEDS[key].stories, ...extra];
}
function allStories() {
  const out = guardianStories().map((s) => ({ ...s, outlet: 'Guardian' }));
  for (const key of Object.keys(FEEDS)) for (const s of feedStories(key)) out.push({ ...s, outlet: FEEDS[key].name });
  return out;
}

// ---------------------------------------------------------------- embeddings

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** Same topic: cosine about 0.92. Different topics: about 0. */
function vectorFor(text) {
  const title = text.split('\n')[0];
  const story = allStories().find((s) => s.title === title) || aiFind(title);
  const v = new Array(DIMS).fill(0);
  if (!story) {
    v[48 + (hash(title) % 16)] = 1;
    return v;
  }
  v[story.t % 48] = 0.96;
  v[48 + (hash(title) % 16)] = 0.28;
  return v;
}

// ---------------------------------------------------------------- pictures (generated PNGs)

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const pngCache = new Map();
function png(seed, w = 480, h = 320) {
  const key = `${seed}:${w}:${h}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const r = 60 + (hash(`r${seed}`) % 160);
  const g = 60 + (hash(`g${seed}`) % 160);
  const b = 60 + (hash(`b${seed}`) % 160);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const shade = 1 - (y / h) * 0.45 + ((x + y) % 64 < 32 ? 0.06 : 0);
      raw[row + 1 + x * 3] = Math.min(255, r * shade);
      raw[row + 2 + x * 3] = Math.min(255, g * shade);
      raw[row + 3 + x * 3] = Math.min(255, b * shade);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  pngCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- pages and feeds

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function paragraphs(story, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(`<p>Paragraph ${i} of the article headed “${esc(story.title)}”. ${esc(story.summary)} This sentence pads the paragraph so that the reader has a realistic amount of text to lay out, scroll through and measure.</p>`);
  }
  return out;
}

function page(base, outlet, story) {
  const id = slug(story.title);
  const paras = paragraphs(story, story.long ? 36 : 9);
  paras.splice(3, 0, `<figure><img src="${base}/img/${id}-inline.png" alt="Inline photograph"><figcaption>Inline photograph for ${esc(outlet)}. Photograph: Mock Pictures</figcaption></figure>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(story.title)} | ${esc(outlet)}</title>
<script>window.__tracking = {};</script></head><body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/news">News</a></li><li><a href="/sport">Sport</a></li></ul></nav>
<article><h1>${esc(story.title)}</h1><p class="standfirst">${esc(story.summary)}</p><address>By Mock Reporter</address>
<figure><img src="${base}/img/${id}-lead.png" alt="Lead photograph"><figcaption>Lead photograph. Photograph: Mock Pictures</figcaption></figure>
<div class="article-body">${paras.join('\n')}</div></article>
<footer><p>© ${esc(outlet)}</p></footer></body></html>`;
}

function rss(base, key) {
  const feed = FEEDS[key];
  const items = feedStories(key).map((s) => `<item>
<title><![CDATA[${s.title}]]></title>
<link>${base}/pages/${key}/${slug(s.title)}?utm_source=rss</link>
<description><![CDATA[${s.summary}]]></description>
<pubDate>${when(s).toUTCString()}</pubDate>
<category>${esc(s.section)}</category>
<media:thumbnail url="${base}/img/${slug(s.title)}-thumb.png" width="240" height="160"/>
</item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${esc(feed.name)}</title>
${items}</channel></rss>`;
}

function guardianResult(base, s) {
  const id = `${slug(s.section)}/${slug(s.title)}`;
  return {
    id,
    type: 'article',
    sectionId: slug(s.section),
    sectionName: s.section,
    webPublicationDate: when(s).toISOString(),
    webTitle: s.title,
    webUrl: `${base}/pages/guardian/${slug(s.title)}`,
    fields: { headline: s.title, trailText: s.summary, byline: 'Mock Reporter', wordcount: String(s.words), thumbnail: `${base}/img/${slug(s.title)}-thumb.png` },
    tags: [
      { id: `tone/${s.tone || 'news'}`, type: 'tone', webTitle: s.tone || 'News' },
      ...s.tags.map((t) => ({ id: `kw/${slug(t)}`, type: 'keyword', webTitle: t })),
    ],
  };
}

function sourcesJson(base) {
  const src = (name, adapter, endpoint, role, lean, readerMode, paywalled) => ({
    name, adapter, endpoint, role, lean, readerMode, paywalled, includeSections: [], excludeSections: [], refreshMinutes: 1, enabled: true,
  });
  return {
    version: 1,
    sources: [
      src('Guardian', 'guardian_content_api', `${base}/guardian/search`, 'primary', 'left', 'extract', false),
      ...Object.keys(FEEDS).map((key) =>
        src(FEEDS[key].name, 'rss', `${base}/feeds/${key}.xml`, 'perspective', FEEDS[key].lean, FEEDS[key].paywalled ? 'browser' : 'extract', !!FEEDS[key].paywalled)),
    ],
  };
}

// ---------------------------------------------------------------- model replies

function chatReply(system, user) {
  if (system.includes('ENRICHMENT')) {
    state.stats.enrich = (state.stats.enrich || 0) + 1;
    return aiEnrich(user);
  }
  if (system.includes('RESCORE')) {
    return { items: Array.from(user.matchAll(/^ID (r\d+)$/gm)).map((m) => ({ id: m[1], profile_match: 0.6, profile_lines: [] })) };
  }
  if (system.includes('PROFILE REWRITE')) {
    const cur = (/CURRENT PROFILE\n\n([\s\S]*?)\n\nPINNED LINES/.exec(user) || [])[1] || '';
    return { markdown: cur };
  }
  if (system.includes('CANDIDATE')) {
    state.stats.match++;
    const stories = allStories();
    const primaryTitle = (/PRIMARY\nHeadline: (.*)/.exec(user) || [])[1];
    const primary = stories.find((s) => s.title === primaryTitle);
    const re = /id: (c\d+)\nOutlet: (.*)\nHeadline: (.*)/g;
    let m;
    while ((m = re.exec(user))) {
      const cand = stories.find((s) => s.title === m[3]);
      // Comment and analysis pieces discuss the story; only the news report is "the same event".
      if (primary && cand && cand.t === primary.t && primary.tone !== 'comment') {
        return { match_id: m[1], same_event: true, angle_note: ANGLE_BY_TOPIC[primary.t] || ANGLE[m[2]] || 'Stresses a different aspect of the same announcement.' };
      }
    }
    return { match_id: null, same_event: false, angle_note: '' };
  }
  state.stats.digest++;
  const stories = allStories();
  const first = (/- [^:]+: (.*?)(?: — |\n|$)/.exec(user) || [])[1];
  const story = stories.find((s) => s.title === first);
  return { covered_by_primary: false, summary: (story && DIGEST_SUMMARY[story.t]) || 'Several outlets report a story the primary source has not covered.' };
}

// ---------------------------------------------------------------- server

function send(res, status, body, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const base = `http://${req.headers.host}`;
  const path = url.pathname;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      if (path === '/e2e/sources.json') return send(res, 200, sourcesJson(base));
      if (path === '/e2e/ai-sources.json') return send(res, 200, aiSourcesJson(base));

      // ---- the AI mode's sources
      const aiFeed = /^\/ai\/feeds\/(vendor|blog|digest)\.xml$/.exec(path);
      if (aiFeed) {
        state.stats.feeds++;
        const xml = aiFeed[1] === 'digest' ? aiDigest(base) : aiRss(base, aiFeed[1]);
        return send(res, 200, xml, 'application/rss+xml; charset=utf-8');
      }
      if (path === '/ai/lab/news') return send(res, 200, aiLabPage(base), 'text/html; charset=utf-8');
      const hnList = /^\/ai\/hn\/v0\/(topstories|beststories)\.json$/.exec(path);
      if (hnList) return send(res, 200, hnList[1] === 'beststories' ? [] : AI.filter((s) => s.hn).map((s) => s.t));
      const hnItem = /^\/ai\/hn\/v0\/item\/(\d+)\.json$/.exec(path);
      if (hnItem) {
        const s = AI.find((x) => x.t === Number(hnItem[1]) && x.hn);
        if (!s) return send(res, 200, null);
        return send(res, 200, { id: s.t, type: 'story', title: s.title, score: s.hn, descendants: 30, url: aiUrl(base, s), time: Math.floor(when(s).getTime() / 1000) });
      }
      const aiPage = /^\/ai\/(?:pages|lab\/news)\/([a-z0-9-]+)$/.exec(path);
      if (aiPage) {
        state.stats.pages++;
        const s = AI.find((x) => slug(x.title) === aiPage[1]) || { title: 'Notes on evals for coding agents', summary: 'How to test agents.' };
        return send(res, 200, page(base, 'AI source', s), 'text/html; charset=utf-8');
      }
      if (path === '/e2e/stats') return send(res, 200, { ...state.stats, batch: state.batch, broken: [...state.broken] });
      if (path === '/e2e/control') {
        if (url.searchParams.get('reset')) reset();
        if (url.searchParams.get('batch')) state.batch = Number(url.searchParams.get('batch'));
        if (url.searchParams.get('break')) state.broken.add(url.searchParams.get('break'));
        if (url.searchParams.get('unbreak')) state.broken.delete(url.searchParams.get('unbreak'));
        return send(res, 200, { ok: true, batch: state.batch, broken: [...state.broken] });
      }

      // ---- OpenRouter
      if (path.startsWith('/openrouter/api/v1/')) {
        if ((req.headers.authorization || '') !== `Bearer ${OPENROUTER_KEY}`) return send(res, 401, { error: { message: 'No auth credentials found', code: 401 } });
        if (path.endsWith('/key')) return send(res, 200, { data: { label: 'e2e', usage: 0, limit: null } });
        const json = JSON.parse(body || '{}');
        if (path.endsWith('/embeddings')) {
          state.stats.embeddings++;
          const data = json.input.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text) }));
          return send(res, 200, { object: 'list', data, model: json.model, usage: { prompt_tokens: 20 * data.length, total_tokens: 20 * data.length, cost: 0.0000004 * data.length } });
        }
        if (path.endsWith('/chat/completions')) {
          state.stats.chat++;
          const reply = chatReply(json.messages[0].content, json.messages[1].content);
          return send(res, 200, {
            id: 'gen-e2e', model: json.model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }],
            usage: { prompt_tokens: 1500, completion_tokens: 150, total_tokens: 1650, cost: 0.00225 },
          });
        }
        return send(res, 404, { error: { message: 'not found' } });
      }

      // ---- Guardian Content API
      if (path.startsWith('/guardian/')) {
        state.stats.guardian++;
        if (url.searchParams.get('api-key') !== GUARDIAN_KEY) return send(res, 401, { message: 'Unauthorized' });
        if (state.broken.has('guardian')) return send(res, 503, { message: 'Service unavailable' });
        if (path === '/guardian/search') {
          const from = Date.parse(url.searchParams.get('from-date') || '') || 0;
          const results = guardianStories().filter((s) => when(s).getTime() >= from).map((s) => guardianResult(base, s));
          return send(res, 200, { response: { status: 'ok', total: results.length, pageSize: 100, currentPage: 1, pages: 1, results } });
        }
        const id = path.replace('/guardian/', '');
        const s = guardianStories().find((g) => `${slug(g.section)}/${slug(g.title)}` === id);
        if (!s) return send(res, 404, { message: 'not found' });
        return send(res, 200, {
          response: { status: 'ok', content: { id, fields: { body: `<p><strong>From the content API.</strong></p>${paragraphs(s, 8).join('')}`, thumbnail: `${base}/img/${slug(s.title)}-thumb.png` } } },
        });
      }

      // ---- feeds, pages, pictures
      const feed = /^\/feeds\/([a-z-]+)\.xml$/.exec(path);
      if (feed && FEEDS[feed[1]]) {
        state.stats.feeds++;
        if (state.broken.has(feed[1])) return send(res, 503, 'Service unavailable', 'text/plain');
        return send(res, 200, rss(base, feed[1]), 'application/rss+xml; charset=utf-8');
      }
      const pg = /^\/pages\/([a-z-]+)\/([a-z0-9-]+)$/.exec(path);
      if (pg) {
        state.stats.pages++;
        const list = pg[1] === 'guardian' ? guardianStories() : FEEDS[pg[1]] ? feedStories(pg[1]) : [];
        const s = list.find((x) => slug(x.title) === pg[2]);
        if (!s) return send(res, 404, 'Not found', 'text/plain');
        // One article's page is deliberately unusable, to exercise the fallback to the API body.
        if (s.broken) return send(res, 200, '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>', 'text/html; charset=utf-8');
        const outlet = pg[1] === 'guardian' ? 'Guardian' : FEEDS[pg[1]].name;
        return send(res, 200, page(base, outlet, s), 'text/html; charset=utf-8');
      }
      const img = /^\/img\/([a-z0-9-]+)\.png$/.exec(path);
      if (img) return send(res, 200, img[1].endsWith('-thumb') ? png(img[1], 240, 160) : png(img[1]), 'image/png');

      return send(res, 404, 'Not found', 'text/plain');
    } catch (e) {
      return send(res, 500, { error: { message: String(e && e.message) } });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock server on http://0.0.0.0:${PORT}`));
