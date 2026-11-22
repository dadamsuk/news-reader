import { stripHtml } from '../core/util';
import type { Db } from '../db/db';
import { chatJson, type LlmDeps } from '../llm/openrouter';

/**
 * Article summaries on request, at three lengths: 3 bullet points, 6 bullet points, or 2
 * paragraphs. One model call per article and length, written from the article's stored text and
 * kept, so opening the same summary again is instant and free.
 */
export type SummaryLevel = 'short' | 'medium' | 'long';

export interface SummarySpec {
  label: string;
  detail: string;
  /** Bullet points or paragraphs, and exactly how many. */
  form: 'bullets' | 'paragraphs';
  count: number;
  /** Most words allowed in each item. */
  maxWords: number;
  maxTokens: number;
}

export const SUMMARY_LEVELS: Record<SummaryLevel, SummarySpec> = {
  // Token caps leave plenty of room: only the tokens actually written are paid for, and a reply
  // cut off at the cap loses its last points.
  short: { label: 'Short', detail: '3 points', form: 'bullets', count: 3, maxWords: 12, maxTokens: 600 },
  medium: { label: 'Medium', detail: '6 points', form: 'bullets', count: 6, maxWords: 12, maxTokens: 1000 },
  long: { label: 'Long', detail: '2 paragraphs', form: 'paragraphs', count: 2, maxWords: 130, maxTokens: 1500 },
};

/** Article text beyond this many words is left out of the prompt (long reads stay affordable). */
export const MAX_INPUT_WORDS = 5000;

export interface Summary {
  level: SummaryLevel;
  items: string[];
  at: number;
}

export class NoTextError extends Error {
  constructor() {
    super('There is no article text to summarise. It may only be readable on the publisher’s site.');
  }
}

const SYSTEM = `You summarise a news article for a reader deciding how much of it to read.
Use only what the article says: add nothing, and keep any attribution ("according to", "police said") where the article has it.
Neutral in tone, British spelling, plain sentences. Do not start with "The article" or "This piece".`;

function instructions(spec: SummarySpec): string {
  if (spec.form === 'bullets') {
    return `Write exactly ${spec.count} bullet points, the most important first. Each is a terse note of at most ${spec.maxWords} words, ` +
      `not a sentence: no "The", no linking words, no full stop. For example: "£2bn cut to NHS capital budget" or ` +
      `"Commons vote Tuesday; up to 40 Labour rebels". ` +
      `Together they should cover the main news, the key facts and figures, and what happens next if the article says.\n\n` +
      `Reply with only this JSON object:\n{"items": [${Array.from({ length: spec.count }, (_, i) => `"<point ${i + 1}>"`).join(', ')}]}`;
  }
  return `Write exactly ${spec.count} paragraphs, each at most ${spec.maxWords} words. The first gives the main news and key facts; ` +
    `the second the background, the reactions and what happens next.\n\n` +
    `Reply with only this JSON object:\n{"items": ["<paragraph 1>", "<paragraph 2>"]}`;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const cleanItem = (x: string) => x.trim().replace(/^([-•*]|\d+[.)])\s*/, '').trim();

/**
 * At least the number of items asked for (extras are dropped). Lengths are asked for in the prompt
 * but not enforced: a point a few words long is better than no summary.
 */
export function validateSummary(spec: SummarySpec) {
  return (v: unknown): { items: string[] } | null => {
    const items = (v as any)?.items;
    if (!Array.isArray(items)) return null;
    const clean = items.map((x) => (typeof x === 'string' ? cleanItem(x) : '')).filter(Boolean);
    return clean.length >= spec.count ? { items: clean.slice(0, spec.count) } : null;
  };
}

/**
 * When the reply is not usable JSON (a stray quotation mark from the article is enough to break
 * it), reads the points or paragraphs from the text itself.
 */
export function summaryFromText(raw: string, spec: SummarySpec): string[] | null {
  const text = raw.replace(/```[a-z]*\n?/gi, '').trim();
  // JSON cut off part-way (the reply hit its length cap): the items that were finished.
  const start = text.indexOf('"items"');
  if (start >= 0) {
    const done: string[] = [];
    // Only whole items: each starts straight after "[" or "," and ends straight before "," or "]",
    // so text broken by a stray quotation mark is not misread as items.
    const list = text.slice(text.indexOf('[', start));
    for (const m of list.matchAll(/[[,]\s*"((?:[^"\\]|\\.)*)"\s*(?=[,\]])/g)) {
      try {
        const item = cleanItem(JSON.parse(`"${m[1]}"`));
        if (item) done.push(item);
      } catch {}
    }
    if (done.length >= spec.count) return done.slice(0, spec.count);
  }
  if (spec.form === 'bullets') {
    const points = text.split('\n').filter((l) => /^\s*([-•*]|\d+[.)])\s+\S/.test(l)).map(cleanItem).filter(Boolean);
    return points.length >= spec.count ? points.slice(0, spec.count) : null;
  }
  const paras = text.split(/\n\s*\n/).map((p) => p.trim())
    .filter((p) => p && words(p) >= 15 && !/^[{["]/.test(p));
  return paras.length >= spec.count ? paras.slice(0, spec.count) : null;
}

export async function getSummary(db: Db, articleId: number, level: SummaryLevel): Promise<Summary | null> {
  const row = await db.get<{ items: string; at: number }>(
    'SELECT items, at FROM article_summary WHERE article_id = ? AND level = ?', [articleId, level],
  );
  if (!row) return null;
  try {
    return { level, items: JSON.parse(row.items), at: row.at };
  } catch {
    return null;
  }
}

/**
 * The summary at this length, from the store or written now. Throws NoTextError when the article
 * has no stored text, BudgetExceededError at the monthly cap, and an Error when the model's answer
 * is unusable.
 */
export async function summarise(llm: LlmDeps, articleId: number, level: SummaryLevel): Promise<Summary> {
  const cached = await getSummary(llm.db, articleId, level);
  if (cached) return cached;
  const a = await llm.db.get<{ title: string; byline: string | null; body_html: string | null; source_name: string }>(
    `SELECT a.title, a.byline, a.body_html, s.name source_name FROM article a JOIN source s ON s.id = a.source_id WHERE a.id = ?`,
    [articleId],
  );
  if (!a) throw new Error('That article is no longer stored');
  const text = stripHtml(a.body_html ?? '');
  if (words(text) < 40) throw new NoTextError();
  const clipped = text.split(/\s+/).slice(0, MAX_INPUT_WORDS).join(' ');
  const spec = SUMMARY_LEVELS[level];
  const user = `Outlet: ${a.source_name}\nHeadline: ${a.title}\n${a.byline ? `Byline: ${a.byline}\n` : ''}\nArticle:\n${clipped}\n\n${instructions(spec)}`;
  const res = await chatJson(llm, { purpose: 'summary', system: SYSTEM, user, validate: validateSummary(spec), maxTokens: spec.maxTokens });
  const items = res.value?.items ?? summaryFromText(res.raw, spec);
  const at = llm.now();
  if (!items) {
    // Kept for Settings, Debug, so a failure can be looked into rather than guessed at.
    await llm.db.run(
      'INSERT INTO decision_log(at, kind, ref_id, summary, detail) VALUES(?,?,?,?,?)',
      [at, 'summary', articleId, `Unusable ${spec.label.toLowerCase()} summary: ${a.title}`,
        JSON.stringify({ level, error: res.error ?? null, raw: res.raw.slice(0, 2000), inputWords: words(clipped) })],
    ).catch(() => {});
    throw new Error('The summary came back in a form the app could not use. Try again; if it keeps happening, the reply is in Settings, Debug.');
  }
  await llm.db.run(
    `INSERT INTO article_summary(article_id, level, items, at) VALUES(?,?,?,?)
     ON CONFLICT(article_id, level) DO UPDATE SET items = excluded.items, at = excluded.at`,
    [articleId, level, JSON.stringify(items), at],
  );
  return { level, items, at };
}

/** The lengths already written for an article (shown as Saved, and free to open). */
export async function savedLevels(db: Db, articleId: number): Promise<SummaryLevel[]> {
  try {
    const rows = await db.all<{ level: SummaryLevel }>('SELECT level FROM article_summary WHERE article_id = ?', [articleId]);
    return rows.map((r) => r.level);
  } catch {
    return [];
  }
}
