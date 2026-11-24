import type { Db } from '../db/db';
import { NEWS_MODE_ID, type TopicRule, type TopicRuleKind } from './types';

/** What a rule is matched against: the headline, standfirst, section and keywords. */
export interface TopicText {
  title: string;
  summary?: string | null;
  section?: string | null;
  tags?: string[] | null;
}

const isWordChar = (c: string | undefined) => !!c && (/[a-z0-9]/.test(c) || c.charCodeAt(0) > 127);

/**
 * True when the term appears in the text as a whole word or phrase, ignoring case. A plural "s"
 * after it still counts ("strike" matches "strikes"), but "art" does not match "party".
 */
export function containsTerm(haystack: string, term: string): boolean {
  const needle = term.toLowerCase().trim().replace(/\s+/g, ' ');
  if (!needle) return false;
  const text = haystack.toLowerCase();
  let from = 0;
  while (true) {
    const i = text.indexOf(needle, from);
    if (i < 0) return false;
    const end = i + needle.length;
    const startOk = !isWordChar(text[i - 1]);
    const endOk = !isWordChar(text[end]) || (text[end] === 's' && !isWordChar(text[end + 1]));
    if (startOk && endOk) return true;
    from = i + 1;
  }
}

export function topicText(a: TopicText): string {
  return [a.title, a.summary ?? '', a.section ?? '', ...(a.tags ?? [])].join('\n').replace(/[ \t]+/g, ' ');
}

/** The active mute and watch rules, ready to test articles against. */
export interface TopicFilter {
  rules: TopicRule[];
  watchTerms: string[];
  /** The muted term this article matches, or null. */
  muted(a: TopicText): string | null;
  /** The watched term this article matches, or null. */
  watched(a: TopicText): string | null;
}

export function makeTopicFilter(rules: TopicRule[]): TopicFilter {
  const mutes = rules.filter((r) => r.kind === 'mute').map((r) => r.term);
  const watches = rules.filter((r) => r.kind === 'watch').map((r) => r.term);
  const first = (terms: string[], a: TopicText) => {
    if (!terms.length) return null;
    const text = topicText(a);
    for (const t of terms) if (containsTerm(text, t)) return t;
    return null;
  };
  return {
    rules,
    watchTerms: watches,
    muted: (a) => first(mutes, a),
    watched: (a) => first(watches, a),
  };
}

function rowToRule(r: any): TopicRule {
  return { id: r.id, kind: r.kind, term: r.term, createdAt: r.created_at, expiresAt: r.expires_at ?? null };
}

/** Rules in force at `now`, newest first. */
export async function listRules(db: Db, now: number): Promise<TopicRule[]> {
  const rows = await db.all<any>(
    'SELECT * FROM topic_rule WHERE mode_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, id DESC',
    [NEWS_MODE_ID, now],
  );
  return rows.map(rowToRule);
}

export async function loadTopicFilter(db: Db, now: number): Promise<TopicFilter> {
  return makeTopicFilter(await listRules(db, now));
}

/**
 * Mutes or watches a term until `expiresAt` (null: until removed). A term has one rule at a time:
 * adding it again replaces the earlier rule, whichever list that was on.
 */
export async function addRule(db: Db, kind: TopicRuleKind, term: string, expiresAt: number | null, now: number): Promise<number | null> {
  const clean = term.trim().replace(/\s+/g, ' ');
  if (clean.length < 2) return null;
  return db.tx(async () => {
    await db.run('DELETE FROM topic_rule WHERE mode_id = ? AND lower(term) = lower(?)', [NEWS_MODE_ID, clean]);
    const r = await db.run('INSERT INTO topic_rule(kind, term, created_at, expires_at) VALUES(?,?,?,?)', [kind, clean, now, expiresAt]);
    return r.lastInsertRowId;
  });
}

export async function removeRule(db: Db, id: number): Promise<void> {
  await db.run('DELETE FROM topic_rule WHERE id = ?', [id]);
}
