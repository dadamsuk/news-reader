/**
 * Pulse: the words in the latest headlines, for a picture of what is being covered, how much, and
 * how recently. Plain text work on the headlines already stored; no model calls, works offline.
 */
import type { Db } from '../db/db';
import { loadTopicFilter } from './topics';
import { HOUR, NEWS_MODE_ID } from './types';
import { safeJson } from './util';

export interface PulseHeadline {
  id: number;
  sourceId: number;
  title: string;
  publishedAt: number;
  /** The outlet's section and tags, which say what kind of story it is. */
  section?: string | null;
  tags?: string[];
}

/** What kind of story a word mostly appears in, which sets its colour in Pulse. */
export type StoryKind = 'politics' | 'world' | 'business' | 'science' | 'culture' | 'sport' | 'other';
export const STORY_KINDS: { kind: StoryKind; label: string }[] = [
  { kind: 'politics', label: 'Politics' },
  { kind: 'world', label: 'World' },
  { kind: 'business', label: 'Business' },
  { kind: 'science', label: 'Science, tech, health' },
  { kind: 'culture', label: 'Culture and life' },
  { kind: 'sport', label: 'Sport' },
  { kind: 'other', label: 'Other' },
];

// Matched as whole words against the section first, then the tags. Order matters: "US politics"
// is politics, "World news" world, "Football" sport.
const KIND_WORDS: [StoryKind, RegExp][] = [
  ['sport', /\b(sports?|football|soccer|cricket|rugby|tennis|golf|formula ?(one|1)|f1|boxing|cycling|athletics|olympics?|premier league|nfl|nba)\b/],
  ['politics', /\b(politics|political|election|elections|government|parliament|westminster|labour|conservatives?|tory|tories|reform uk|lib dems?|congress|senate|white house|policy|brexit)\b/],
  ['business', /\b(business|money|economy|economics|markets?|finance|financial|companies|banking|retail|property|housing market|jobs|work|personal finance|tax)\b/],
  ['science', /\b(science|environment|climate|technology|tech|health|nhs|society|medicine|space|nature|wildlife|energy|ai)\b/],
  ['culture', /\b(culture|arts?|film|films|movies?|music|books?|tv|television|radio|stage|theatre|lifestyle|life ?and ?style|life|fashion|food|travel|showbiz|celebrity|entertainment|games|gaming|royals?|television & radio)\b/],
  ['world', /\b(world|international|global|europe|european|us news|americas|asia|africa|middle east|australia|ukraine|russia|israel|gaza|china|india)\b/],
];

/** The kind of one headline, from its section and tags ("other" when they say nothing useful). */
export function storyKind(section: string | null | undefined, tags: string[] = []): StoryKind {
  for (const text of [section ?? '', ...tags]) {
    const t = text.toLowerCase();
    if (!t) continue;
    for (const [kind, re] of KIND_WORDS) if (re.test(t)) return kind;
  }
  return 'other';
}

export interface PulseTerm {
  /** Lower-case key: one word or a two-word name ("keir starmer"). */
  key: string;
  /** As it is best written ("Keir Starmer", "tariffs", "NHS"). */
  label: string;
  /** Headlines using it. */
  count: number;
  /** Outlets using it. */
  outlets: number;
  /** Coverage intensity, which sets the size: headlines, plus a little for each further outlet. */
  weight: number;
  /** 0 to 1: how recent its coverage is (1: every headline just published). */
  heat: number;
  /** More headlines in the latest quarter of the window than in the quarter before. */
  rising: boolean;
  newestAt: number;
  /** The kind of story it mostly appears in (its colour). */
  kind: StoryKind;
  /** Its headlines, newest first. */
  articleIds: number[];
}

export interface Pulse {
  terms: PulseTerm[];
  /** Headlines per bucket, oldest first; the last bucket ends now. */
  buckets: number[];
  bucketMs: number;
  headlines: number;
  outlets: number;
  windowMs: number;
}

export const PULSE_TERMS = 40;
/** A word must be in at least this many headlines to count. */
export const PULSE_MIN_COUNT = 2;

const STOP = new Set(`
a about above across after again against ago ahead all almost along already also although always am amid among an and another
any anyone anything are around as at away back be became because become been before behind being below best better between
big both but by came can cannot could day days did do does doing done down during each early either else even ever every
few first for four from full further get gets getting give given go goes going gone good got great had has have having he her
here hers him his how however i if in inside into is it its itself just keep know known last late later least less let like
little long look made make makes making many may me might more most much must my near need never new news next no nor not
now of off old on once one only or other our out over own part people per put rather really right said same say says see
seen set several she should show since so some still such take takes taking than that the their them then there these they
thing things think this those though three through time times to today told too top two under until up upon us very via
want was way we week weeks well went were what when where which while who whom whose why will with within without would
year years yet you your
live latest update updates video watch photos pictures analysis opinion comment review interview explained explainer
says said warns warned claims claimed reveals revealed calls called urges urged admits announces announced report reports reported
row rows deal plans plan bid move moves face faces facing hit hits set sets amid how why what
left second stop return returns fears
`.split(/\s+/).filter(Boolean));

/** Short words kept only when written in capitals in the headline (US, UK, EU, AI, UN). */
const isAcronym = (w: string) => /^[A-Z]{2,5}$/.test(w);

interface Token {
  key: string;
  form: string;
  /** Not the first word of the headline (its capital letter says something). */
  inner: boolean;
}

function tokens(title: string): (Token | null)[] {
  const text = title.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  const out: (Token | null)[] = [];
  let first = true;
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'\-.]*|[^\p{L}\p{N}\s]+/gu)) {
    let w = m[0];
    // Punctuation breaks a two-word name ("Gaza: ceasefire" is not "gaza ceasefire").
    if (!/[\p{L}\p{N}]/u.test(w[0])) {
      if (/[:;,.!?"|()–—-]/.test(w)) out.push(null);
      continue;
    }
    const endsSentence = /\.$/.test(w) && !/^([A-Z]\.)+$/.test(w);
    w = w.replace(/'s$/i, '').replace(/['\-.]+$/, '').replace(/^'+/, '');
    const key = w.toLowerCase().replace(/\./g, '');
    const inner = !first;
    first = false;
    if (!key || /^\d+$/.test(key) || /^\d/.test(key) || STOP.has(key) || (key.length < 3 && !isAcronym(w.replace(/\./g, '')))) {
      out.push(null);
    } else {
      out.push({ key, form: w.replace(/\./g, ''), inner });
    }
    if (endsSentence) out.push(null);
  }
  return out;
}

/** True for a headline written in Title Case, whose capitals say nothing about names. */
function titleCase(title: string): boolean {
  const words = title.split(/\s+/).filter((w) => /^[\p{L}]{4,}/u.test(w));
  if (words.length < 3) return false;
  const caps = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  return caps / words.length >= 0.6;
}

interface Acc {
  key: string;
  ids: Set<number>;
  forms: Map<string, number>;
}

/**
 * Picks out the words and two-word names that recur across headlines and measures each one's
 * coverage. A two-word name ("Rachel Reeves") is kept when it accounts for most uses of its words,
 * and then stands in for them; a plural joins its singular ("tariffs" with "tariff").
 */
export function extractTerms(
  headlines: PulseHeadline[], now: number, windowMs: number, limit = PULSE_TERMS, hidden: string[] = [],
): PulseTerm[] {
  // A hidden word is treated as a filler word (so it forms no names either, and "UK economy" is
  // just "economy"); a hidden name is dropped as a whole. A plural goes with its singular.
  const hide = new Set(hidden.map(pulseKey).filter(Boolean));
  const hiddenWord = (k: string) => hide.has(k) || (k.endsWith('s') && hide.has(k.slice(0, -1)));
  // The same headline twice (an outlet's repeated live-blog title) counts once.
  const seenTitles = new Set<string>();
  const items = headlines.filter((h) => {
    const k = `${h.sourceId}|${h.title.trim().toLowerCase()}`;
    if (seenTitles.has(k)) return false;
    seenTitles.add(k);
    return true;
  });
  const byId = new Map(items.map((h) => [h.id, h]));
  const uni = new Map<string, Acc>();
  const bi = new Map<string, Acc>();
  const note = (map: Map<string, Acc>, key: string, id: number, form: string, weight: number) => {
    const a = map.get(key) ?? { key, ids: new Set<number>(), forms: new Map<string, number>() };
    a.ids.add(id);
    a.forms.set(form, (a.forms.get(form) ?? 0) + weight);
    map.set(key, a);
  };
  for (const h of items) {
    const tc = titleCase(h.title);
    const toks = tokens(h.title).map((t) => (t && hiddenWord(t.key) ? null : t));
    // A capital tells something only inside a sentence-case headline; such forms are preferred.
    const formWeight = (t: Token) => (!tc && t.inner ? 10 : !tc ? 2 : 1);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t) continue;
      note(uni, t.key, h.id, t.form, formWeight(t));
      const n = toks[i + 1];
      if (n) note(bi, `${t.key} ${n.key}`, h.id, `${t.form} ${n.form}`, Math.min(formWeight(t), formWeight(n)));
    }
  }
  // Plurals join their singular.
  for (const [key, a] of Array.from(uni)) {
    const single = key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1) : null;
    const target = single ? uni.get(single) : null;
    if (!target || target === a) continue;
    a.ids.forEach((id) => target.ids.add(id));
    a.forms.forEach((n, f) => target.forms.set(f, (target.forms.get(f) ?? 0) + n));
    uni.delete(key);
  }
  // Two-word names that carry most of their words' use replace them.
  const terms: Acc[] = [];
  const pairs = Array.from(bi.values())
    .filter((b) => b.ids.size >= PULSE_MIN_COUNT)
    .sort((x, y) => y.ids.size - x.ids.size);
  for (const b of pairs) {
    const [k1, k2] = b.key.split(' ');
    const u1 = uni.get(k1);
    const u2 = uni.get(k2);
    if (!u1 || !u2) continue;
    // Only headlines not already claimed by a name that shares a word ("Jensen Huang" before
    // "Huang returns"), and only while both words still have uses of their own to take over.
    for (const id of Array.from(b.ids)) if (!u1.ids.has(id) || !u2.ids.has(id)) b.ids.delete(id);
    if (b.ids.size < PULSE_MIN_COUNT || !u1.ids.size || !u2.ids.size) continue;
    if (b.ids.size < 0.5 * Math.min(u1.ids.size, u2.ids.size)) continue;
    terms.push(b);
    b.ids.forEach((id) => { u1.ids.delete(id); u2.ids.delete(id); });
    // A person's name: headlines using the surname alone ("Burnham") are about the same person.
    if (/^\p{Lu}\S*\s\p{Lu}/u.test(bestForm(b)) && /^\p{Lu}/u.test(bestForm(u2))) {
      u2.ids.forEach((id) => b.ids.add(id));
      u2.ids.clear();
    }
  }
  terms.push(...uni.values());

  const half = Math.max(HOUR, windowMs / 8);
  const quarter = windowMs / 4;
  const out: PulseTerm[] = [];
  for (const t of terms) {
    if (t.ids.size < PULSE_MIN_COUNT || hide.has(t.key)) continue;
    const hs = Array.from(t.ids).map((id) => byId.get(id)!).sort((a, b) => b.publishedAt - a.publishedAt);
    const outlets = new Set(hs.map((h) => h.sourceId)).size;
    const heat = hs.reduce((sum, h) => sum + Math.pow(0.5, Math.max(0, now - h.publishedAt) / half), 0) / hs.length;
    const recent = hs.filter((h) => now - h.publishedAt < quarter).length;
    const before = hs.filter((h) => now - h.publishedAt >= quarter && now - h.publishedAt < 2 * quarter).length;
    // The kind most of its headlines are; headlines with no useful section do not vote.
    const votes = new Map<StoryKind, number>();
    for (const x of hs) {
      const k = storyKind(x.section, x.tags);
      if (k !== 'other') votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    let kind: StoryKind = 'other';
    let most = 0;
    for (const [k, n] of votes) if (n > most) { kind = k; most = n; }
    out.push({
      key: t.key,
      kind,
      label: bestForm(t),
      count: hs.length,
      outlets,
      weight: hs.length + 0.5 * (outlets - 1),
      heat,
      rising: recent >= 2 && recent > before,
      newestAt: hs[0].publishedAt,
      articleIds: hs.map((h) => h.id),
    });
  }
  return out
    .sort((a, b) => b.weight - a.weight || b.heat - a.heat || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/**
 * How to write a term. Capitals at the start of a headline, or anywhere in a Title Case one, say
 * nothing, so the forms seen inside sentence-case headlines count most. Any lower-case use marks an
 * ordinary word ("tariffs"); names and acronyms keep their capitals ("Rachel Reeves", "NHS").
 */
function bestForm(t: Acc): string {
  const forms = Array.from(t.forms).sort((a, b) => b[1] - a[1]);
  if (!forms.length) return t.key;
  const best = forms[0][0];
  if (/^[\p{Lu}\d ]+$/u.test(best)) return best;
  const lower = forms.find(([f]) => f === f.toLowerCase());
  return lower ? lower[0] : best;
}

/** The key a word or name is matched by: lower case, single spaces, no full stops ("U.K." is "uk"). */
export function pulseKey(term: string): string {
  return term.toLowerCase().replace(/\./g, '').replace(/['’]s\b/g, '').replace(/\s+/g, ' ').trim();
}

/** Headline counts per bucket across the window, oldest first. */
export function bucketCounts(headlines: PulseHeadline[], now: number, windowMs: number, bucketMs: number): number[] {
  const n = Math.max(1, Math.round(windowMs / bucketMs));
  const out = new Array(n).fill(0);
  for (const h of headlines) {
    const age = now - h.publishedAt;
    if (age < 0 || age >= windowMs) continue;
    out[n - 1 - Math.floor(age / bucketMs)]++;
  }
  return out;
}

/** The Pulse for the last `windowMs`: every enabled source, muted topics and hidden words left out. */
export async function loadPulse(db: Db, now: number, windowMs: number, hidden: string[] = []): Promise<Pulse> {
  const rows = await db.all<any>(
    `SELECT a.id, a.source_id, a.title, a.summary, a.section, a.tags, a.published_at
     FROM article a JOIN source s ON s.id = a.source_id AND s.enabled = 1
     WHERE a.mode_id = ? AND a.published_at > ? AND a.published_at <= ?`,
    [NEWS_MODE_ID, now - windowMs, now + HOUR],
  );
  const topics = await loadTopicFilter(db, now);
  const headlines: PulseHeadline[] = rows
    .filter((r) => !topics.muted({ title: r.title, summary: r.summary, section: r.section, tags: safeJson<string[]>(r.tags, []) }))
    .map((r) => ({
      id: r.id, sourceId: r.source_id, title: r.title, publishedAt: Math.min(r.published_at, now),
      section: r.section, tags: safeJson<string[]>(r.tags, []),
    }));
  const bucketMs = windowMs <= DAY_MS ? HOUR : 3 * HOUR;
  return {
    terms: extractTerms(headlines, now, windowMs, PULSE_TERMS, hidden),
    buckets: bucketCounts(headlines, now, windowMs, bucketMs),
    bucketMs,
    headlines: headlines.length,
    outlets: new Set(headlines.map((h) => h.sourceId)).size,
    windowMs,
  };
}

const DAY_MS = 24 * HOUR;

export interface PulseRow {
  id: number;
  title: string;
  sourceName: string;
  publishedAt: number;
}

/** The headlines behind a term, newest first. */
export async function loadPulseHeadlines(db: Db, ids: number[]): Promise<PulseRow[]> {
  if (!ids.length) return [];
  const rows = await db.all<any>(
    `SELECT a.id, a.title, a.published_at, s.name FROM article a JOIN source s ON s.id = a.source_id
     WHERE a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.published_at DESC`,
    ids,
  );
  return rows.map((r) => ({ id: r.id, title: r.title, sourceName: r.name, publishedAt: r.published_at }));
}
