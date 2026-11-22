import { DAY } from './types';

const KEEP_PARAMS = new Set(['id', 'p', 'articleid', 'storyid', 'story_id', 'article_id']);

/** Canonical form used for de-duplication: no fragment, no tracking/query params, no trailing slash. */
export function canonicalUrl(raw: string): string {
  const trimmed = (raw || '').trim();
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(trimmed);
  if (!m) return trimmed;
  const host = m[2].toLowerCase().replace(/^www\./, '').replace(/:(80|443)$/, '');
  let path = m[3] || '/';
  path = path.replace(/\/{2,}/g, '/').replace(/\/(index\.html?)?$/i, '');
  let query = '';
  if (m[4]) {
    const kept = m[4]
      .slice(1)
      .split('&')
      .filter((kv) => KEEP_PARAMS.has(kv.split('=')[0].toLowerCase()) && kv.includes('='));
    if (kept.length) query = '?' + kept.sort().join('&');
  }
  return `https://${host}${path}${query}`;
}

// ---- vectors (embeddings are stored L2-normalised) ----

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = a.length < b.length ? a.length : b.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return ab / Math.sqrt(aa * bb);
}

export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function blobToVec(b: Uint8Array | ArrayBuffer | null | undefined): Float32Array | null {
  if (!b) return null;
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (u8.byteLength === 0 || u8.byteLength % 4 !== 0) return null;
  // Copy: the source may not be 4-byte aligned.
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

// ---- text ----

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(html: string | undefined | null): string {
  if (!html) return '';
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function truncateWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/);
  if (words.length <= max) return s.trim();
  return words.slice(0, max).join(' ').replace(/[,;:.]+$/, '') + '…';
}

export function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Removes anything that looks like a credential from text bound for logs or the database. */
export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  out = out.replace(/((?:api[-_]?key|key|token|access_token|apikey)=)[^&\s"']+/gi, '$1[redacted]');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[redacted]');
  out = out.replace(/sk-or-[A-Za-z0-9\-_]{8,}/g, '[redacted]');
  return out;
}

export function errMsg(e: unknown, secrets: (string | null | undefined)[] = []): string {
  const m = e instanceof Error ? e.message : String(e);
  return redact(m, secrets).slice(0, 500);
}

// ---- time ----

export function ageLabel(publishedAt: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - publishedAt) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const HALF_LIFE_MS = 30 * DAY;

export function decayFactor(elapsedMs: number, halfLifeMs = HALF_LIFE_MS): number {
  if (elapsedMs <= 0) return 1;
  return Math.pow(0.5, elapsedMs / halfLifeMs);
}

export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// ---- deterministic rng (so a session's feed order is stable) ----

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
