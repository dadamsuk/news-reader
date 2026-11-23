export interface ReaderDoc {
  title: string;
  byline: string | null;
  sourceName: string;
  section: string | null;
  publishedAt: number;
  leadImage: string | null;
  bodyHtml: string;
  textSize: number;
  dark: boolean;
  /** Remote image URL to local file URI, for offline copies. */
  imageMap: Record<string, string>;
  live?: boolean;
  /** Outlets covering this story, for the Full coverage button at the end. Omitted: no button. */
  coverageOutlets?: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Points image tags at offline copies where they exist. */
export function applyImageMap(html: string, map: Record<string, string>): string {
  if (!map || !Object.keys(map).length) return html;
  return html.replace(/<img src="([^"]+)"/g, (m, src: string) => {
    const key = src.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const local = map[key];
    return local ? `<img src="${esc(local)}"` : m;
  });
}

export const READER_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 20px 18px 48px; background: #ffffff; color: #1a1a1a;
  font-family: Georgia, 'Times New Roman', serif; line-height: 1.6; word-wrap: break-word; overflow-wrap: anywhere; }
body.dark { background: #121212; color: #e6e6e6; }
.meta, .kicker, figcaption, .block-time { font-family: -apple-system, Roboto, 'Helvetica Neue', sans-serif; }
.kicker { font-size: 0.72em; letter-spacing: 0.06em; text-transform: uppercase; color: #b3261e; font-weight: 700; margin: 0 0 8px; }
body.dark .kicker { color: #ff8a80; }
h1 { font-size: 1.55em; line-height: 1.22; margin: 0 0 12px; font-weight: 700; }
.meta { font-size: 0.78em; color: #666; margin: 0 0 18px; }
body.dark .meta { color: #a0a0a0; }
h2 { font-size: 1.25em; line-height: 1.3; margin: 1.5em 0 0.5em; }
h3, h4, h5 { font-size: 1.08em; line-height: 1.3; margin: 1.4em 0 0.4em; }
p { margin: 0 0 1.05em; }
a { color: #0b57d0; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
body.dark a { color: #8ab4f8; }
img { display: block; max-width: 100%; height: auto; margin: 0 auto; border-radius: 4px; background: #eee; }
body.dark img { background: #222; }
figure { margin: 1.3em 0; }
figure.lead { margin: 0 -18px 18px; }
figure.lead img { border-radius: 0; width: 100%; }
figcaption { font-size: 0.74em; line-height: 1.4; color: #666; margin-top: 6px; }
body.dark figcaption { color: #a0a0a0; }
blockquote { margin: 1.2em 0; padding: 2px 0 2px 14px; border-left: 3px solid #b3261e; color: #444; }
body.dark blockquote { color: #c8c8c8; border-left-color: #ff8a80; }
ul, ol { padding-left: 1.3em; margin: 0 0 1.05em; }
li { margin-bottom: 0.4em; }
hr { border: 0; border-top: 1px solid #ddd; margin: 1.6em 0; }
body.dark hr { border-top-color: #333; }
table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; font-size: 0.85em; margin: 1.2em 0; }
td, th { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
body.dark td, body.dark th { border-color: #444; }
pre { white-space: pre-wrap; font-size: 0.85em; }
.block-time { font-size: 0.72em; color: #b3261e; font-weight: 700; margin-bottom: 4px; }
body.dark .block-time { color: #ff8a80; }
.live-note { font-family: -apple-system, Roboto, sans-serif; font-size: 0.78em; color: #666; margin-bottom: 18px; }
.coverage { font-family: -apple-system, Roboto, sans-serif; margin: 36px 0 28px; padding-top: 22px; border-top: 1px solid #e2e0d8; }
body.dark .coverage { border-top-color: #333; }
.coverage button { display: block; width: 100%; font: inherit; font-size: 0.9em; font-weight: 700; text-align: left;
  padding: 14px 16px; border-radius: 12px; border: 1px solid #e2e0d8; background: #f4f3ef; color: #1a1a1a; }
body.dark .coverage button { border-color: #3a3a3e; background: #1e1e22; color: #eee; }
.coverage button .count { font-weight: 500; color: #a8201a; }
body.dark .coverage button .count { color: #ff8a80; }
.coverage button .sub { display: block; font-weight: 400; font-size: 0.85em; color: #666; margin-top: 3px; }
body.dark .coverage button .sub { color: #aaa; }
`;

/** Runs inside the reader page: reports scroll depth and hands link taps to the app. */
export const READER_JS = `
(function () {
  var max = 0, timer = null;
  function post(o) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  function measure() {
    timer = null;
    var doc = document.documentElement;
    var full = Math.max(doc.scrollHeight, document.body.scrollHeight);
    var seen = (window.scrollY || doc.scrollTop || 0) + window.innerHeight;
    var pct = full > 0 ? Math.min(100, Math.round(seen / full * 100)) : 100;
    if (pct > max) { max = pct; post({ type: 'scroll', pct: max }); }
  }
  function schedule() { if (!timer) timer = setTimeout(measure, 150); }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('load', function () { setTimeout(measure, 400); });
  setTimeout(measure, 1200);
  var cov = document.getElementById('coverage');
  if (cov) cov.addEventListener('click', function () { post({ type: 'coverage' }); });
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (el && el.href) { e.preventDefault(); post({ type: 'link', url: el.href }); }
  }, true);
  window.__setTheme = function (dark, size) {
    document.body.className = dark ? 'dark' : '';
    if (size) document.body.style.fontSize = size + 'px';
  };
})();
`;

/** Full coverage at the end of every article: every outlet's piece on the story, side by side. */
function coverageButton(outlets: number | undefined): string {
  if (outlets == null) return '';
  const count = outlets > 1 ? ` <span class="count">· ${outlets} outlets</span>` : '';
  const sub = outlets > 1 ? 'Every outlet’s piece on this story, side by side' : 'Only this outlet so far. See it, or follow the story for later coverage';
  return `<div class="coverage"><button id="coverage" type="button">Full coverage${count}<span class="sub">${sub}</span></button></div>`;
}

/** The reader page: the app's own stylesheet around sanitised article HTML. */
export function buildReaderHtml(doc: ReaderDoc): string {
  const body = applyImageMap(doc.bodyHtml, doc.imageMap);
  // The body "opens with a picture" when an image comes before any real amount of text.
  const firstImg = body.indexOf('<img');
  const bodyStartsWithImage = firstImg >= 0 && body.slice(0, firstImg).replace(/<[^>]*>/g, '').trim().length < 200
    && !/<p>/.test(body.slice(0, firstImg));
  const leadSrc = doc.leadImage ? doc.imageMap[doc.leadImage] ?? doc.leadImage : null;
  const lead = leadSrc && !bodyStartsWithImage ? `<figure class="lead"><img src="${esc(leadSrc)}" alt=""></figure>` : '';
  const meta = [doc.byline, formatDate(doc.publishedAt)].filter(Boolean).map((s) => esc(String(s))).join(' · ');
  const kicker = [doc.sourceName, doc.section].filter(Boolean).map((s) => esc(String(s))).join(' · ');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: file: content: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(doc.title)}</title>
<style>${READER_CSS}</style>
</head>
<body class="${doc.dark ? 'dark' : ''}" style="font-size:${Math.round(doc.textSize)}px">
<article>
<p class="kicker">${kicker}</p>
<h1>${esc(doc.title)}</h1>
<p class="meta">${meta}</p>
${lead}
${doc.live ? '<p class="live-note">Live blog: latest 20 updates, newest first.</p>' : ''}
<div id="body">${body}</div>
${coverageButton(doc.coverageOutlets)}
</article>
<script>${READER_JS}</script>
</body></html>`;
}
