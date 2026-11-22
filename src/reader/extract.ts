import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface Extracted {
  html: string;
  textLength: number;
  byline: string | null;
  images: string[];
}

const ALLOWED = new Set([
  'p', 'h2', 'h3', 'h4', 'h5', 'blockquote', 'ul', 'ol', 'li', 'figure', 'figcaption', 'img', 'a', 'em', 'strong',
  'i', 'b', 'u', 's', 'br', 'hr', 'sub', 'sup', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'pre', 'code',
  'section', 'time', 'cite', 'q', 'small', 'mark', 'dl', 'dt', 'dd', 'caption',
]);
/** Dropped together with everything inside them. */
const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'canvas',
  'video', 'audio', 'noscript', 'template', 'link', 'meta', 'nav', 'aside', 'footer', 'dialog', 'gu-island',
]);
const VOID = new Set(['img', 'br', 'hr']);
const INLINE_UNKNOWN = /^(span|picture|font|abbr|label|data|wbr)$/;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

export function resolveUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(javascript|data|vbscript|blob|file|about):/i.test(h)) return null;
  if (/^https?:\/\//i.test(h)) return h;
  const m = /^(https?:)\/\/([^/?#]+)([^?#]*)/i.exec(base);
  if (!m) return null;
  if (h.startsWith('//')) return m[1] + h;
  if (h.startsWith('/')) return `${m[1]}//${m[2]}${h}`;
  if (h.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // mailto:, tel: and friends
  const dir = m[3].replace(/[^/]*$/, '') || '/';
  return `${m[1]}//${m[2]}${dir}${h}`;
}

interface ImgCandidate {
  url: string;
  w: number;
}

/** Width implied by a URL's own query (width=620&dpr=2), for image services that size by parameter. */
function hintedWidth(url: string): number {
  const w = /[?&](?:width|w)=(\d{2,4})\b/i.exec(url);
  if (!w) return 0;
  const dpr = /[?&]dpr=(\d(?:\.\d)?)\b/i.exec(url);
  return parseInt(w[1], 10) * (dpr ? parseFloat(dpr[1]) : 1);
}

export function srcsetCandidates(srcset: string | null | undefined): ImgCandidate[] {
  if (!srcset) return [];
  return srcset
    .split(/,\s+(?=\S)|,(?=https?:)/)
    .map((part) => {
      const [url, size] = part.trim().split(/\s+/);
      let w = size && size.endsWith('w') ? parseInt(size, 10) : size && size.endsWith('x') ? parseFloat(size) * 600 : 0;
      if (!w || !Number.isFinite(w)) w = hintedWidth(url ?? '');
      return { url, w };
    })
    .filter((c) => c.url && !/^data:/i.test(c.url));
}

const TARGET_WIDTH = 640;

/** The smallest candidate at least 640 wide (sharp on a phone without wasting data), else the largest. */
export function pickCandidate(cands: ImgCandidate[]): string | null {
  if (!cands.length) return null;
  const big = cands.filter((c) => c.w >= TARGET_WIDTH).sort((a, b) => a.w - b.w)[0];
  if (big) return big.url;
  const known = cands.filter((c) => c.w > 0).sort((a, b) => b.w - a.w)[0];
  return (known ?? cands[0]).url;
}

export function pickSrcset(srcset: string | null | undefined): string | null {
  return pickCandidate(srcsetCandidates(srcset));
}

function imgSrc(el: any, base: string): string | null {
  const attr = (n: string) => el.getAttribute?.(n) as string | null;
  const w = parseInt(attr('width') ?? '', 10);
  const h = parseInt(attr('height') ?? '', 10);
  if ((Number.isFinite(w) && w > 0 && w < 40) || (Number.isFinite(h) && h > 0 && h < 40)) return null;
  const cands: ImgCandidate[] = [];
  let plain: string | null = null;
  const src = attr('src');
  if (src && !/^data:/i.test(src) && !/(placeholder|spacer|blank|pixel|1x1)\b/i.test(src)) {
    plain = src;
    cands.push({ url: src, w: hintedWidth(src) });
  }
  for (const name of ['data-src', 'data-original', 'data-lazy-src']) {
    const v = attr(name);
    if (v && !/^data:/i.test(v)) {
      plain = plain ?? v;
      cands.push({ url: v, w: hintedWidth(v) });
    }
  }
  cands.push(...srcsetCandidates(attr('srcset')), ...srcsetCandidates(attr('data-srcset')));
  const parent = el.parentNode;
  if (parent && String(parent.nodeName).toLowerCase() === 'picture') {
    for (const sib of Array.from(parent.childNodes) as any[]) {
      if (String(sib.nodeName).toLowerCase() !== 'source') continue;
      const type = sib.getAttribute('type') ?? '';
      if (type && !/jpe?g|png|webp|gif/i.test(type)) continue;
      cands.push(...srcsetCandidates(sib.getAttribute('srcset') || sib.getAttribute('srcSet') || sib.getAttribute('data-srcset')));
    }
  }
  // With no width information anywhere, the plain src is the safest choice.
  const chosen = cands.some((c) => c.w > 0) ? pickCandidate(cands) : plain ?? pickCandidate(cands);
  return resolveUrl(chosen, base);
}

function textOf(node: any): string {
  return String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Navigation menus, share bars and timestamp lines that Readability sometimes leaves in. */
function isBoilerplate(node: any, tag: string): boolean {
  if (tag === 'ul' || tag === 'ol') {
    const items = node.querySelectorAll?.('li') ?? [];
    if (items.length < 3) return false;
    const total = textOf(node).length;
    let linked = 0;
    for (const a of Array.from(node.querySelectorAll('a')) as any[]) linked += textOf(a).length;
    return total > 0 && linked / total > 0.8 && total / items.length < 40;
  }
  if (tag === 'p') {
    const t = textOf(node);
    if (!node.querySelector?.('img') && /^[\s|·•\-–—]*$/.test(t)) return true;
    if (/^skip to (main )?content$/i.test(t)) return true;
    if (node.querySelector?.('time') && t.length < 160) return true;
  }
  return false;
}

function serialize(node: any, base: string, images: string[], out: string[]): void {
  const type = node.nodeType;
  if (type === 3) {
    out.push(esc(node.textContent ?? ''));
    return;
  }
  if (type !== 1) return;
  const tag = String(node.nodeName).toLowerCase();
  if (DROP.has(tag) || isBoilerplate(node, tag)) return;
  if (tag === 'img') {
    const src = imgSrc(node, base);
    if (src) {
      if (!images.includes(src)) images.push(src);
      out.push(`<img src="${escAttr(src)}" alt="${escAttr(node.getAttribute('alt') ?? '')}">`);
    }
    return;
  }
  const keep = ALLOWED.has(tag);
  if (keep) {
    let attrs = '';
    if (tag === 'a') {
      const href = resolveUrl(node.getAttribute('href'), base);
      if (href) attrs = ` href="${escAttr(href)}"`;
    } else if (tag === 'section' && node.getAttribute('class') === 'live-block') {
      attrs = ' class="live-block"';
    } else if (tag === 'p' && node.getAttribute('class') === 'block-time') {
      attrs = ' class="block-time"';
    } else if (tag === 'td' || tag === 'th') {
      const cs = parseInt(node.getAttribute('colspan') ?? '', 10);
      if (cs > 1 && cs < 20) attrs = ` colspan="${cs}"`;
    }
    out.push(`<${tag}${attrs}>`);
  }
  if (!VOID.has(tag)) {
    for (const child of Array.from(node.childNodes) as any[]) serialize(child, base, images, out);
  }
  if (keep && !VOID.has(tag)) out.push(`</${tag}>`);
  else if (!keep && !INLINE_UNKNOWN.test(tag)) out.push(' ');
}

/** Whitelist sanitiser: known tags only, no attributes except link targets and image sources. */
export function sanitizeHtml(html: string, baseUrl: string): { html: string; images: string[]; textLength: number } {
  const { document } = parseHTML(`<!doctype html><html><body><div id="__root">${html}</div></body></html>`);
  const root = document.getElementById('__root');
  const out: string[] = [];
  const images: string[] = [];
  if (root) for (const child of Array.from(root.childNodes) as any[]) serialize(child, baseUrl, images, out);
  let clean = out.join('').replace(/\s{2,}/g, ' ');
  // Removing an empty element can empty its parent, so repeat a few times.
  for (let i = 0; i < 3; i++) {
    clean = clean.replace(/<(p|h2|h3|h4|h5|li|ul|ol|figcaption|blockquote|figure|section|a|strong|em|b|i)(?: [^>]*)?>\s*<\/\1>/g, '');
  }
  clean = clean.replace(/(<br>\s*){3,}/g, '<br><br>').trim();
  const textLength = clean.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
  return { html: clean, images, textLength };
}

/** Removes the bulk of a page that can never be article content, so parsing stays fast on a phone. */
export function precleanHtml(page: string): string {
  return page
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b(?![^>]*application\/ld\+json)[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<gu-island\b[^>]*>\s*<\/gu-island>/gi, '');
}

export const MIN_ARTICLE_CHARS = 500;

/** The page's main picture: the first figure inside the article, which often sits outside the body text. */
function findLeadFigure(document: any, url: string): { src: string; caption: string } | null {
  const scope = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
  if (!scope) return null;
  const figures = Array.from(scope.querySelectorAll('figure')).slice(0, 3) as any[];
  for (const fig of figures) {
    const img = fig.querySelector('img');
    if (!img) continue;
    const src = imgSrc(img, url);
    if (!src) continue;
    const cap = fig.querySelector('figcaption');
    return { src, caption: cap ? textOf(cap).slice(0, 400) : '' };
  }
  return null;
}

/** Same picture at a different size counts as the same picture. */
const imageKey = (u: string) => u.replace(/[?#].*$/, '');

/** Extracts the article body from a publisher page. Returns null when no usable article is found. */
export function extractArticle(pageHtml: string, url: string): Extracted | null {
  if (!pageHtml || pageHtml.length < 500) return null;
  let parsed: ReturnType<Readability['parse']> = null;
  let lead: { src: string; caption: string } | null = null;
  try {
    const { document } = parseHTML(precleanHtml(pageHtml));
    try {
      // Readability resolves relative links through document.baseURI.
      Object.defineProperty(document, 'baseURI', { value: url, configurable: true });
      Object.defineProperty(document, 'documentURI', { value: url, configurable: true });
    } catch {}
    try {
      lead = findLeadFigure(document, url);
    } catch {
      lead = null;
    }
    parsed = new Readability(document as any, { keepClasses: false, charThreshold: 300 }).parse();
  } catch {
    return null;
  }
  if (!parsed || !parsed.content) return null;
  const clean = sanitizeHtml(parsed.content, url);
  if (clean.textLength < MIN_ARTICLE_CHARS) return null;
  let html = clean.html;
  const images = clean.images;
  if (lead && !images.some((i) => imageKey(i) === imageKey(lead!.src))) {
    const caption = lead.caption ? `<figcaption>${esc(lead.caption)}</figcaption>` : '';
    html = `<figure><img src="${escAttr(lead.src)}" alt="">${caption}</figure>${html}`;
    images.unshift(lead.src);
  }
  return { html, textLength: clean.textLength, byline: parsed.byline?.trim() || null, images };
}
