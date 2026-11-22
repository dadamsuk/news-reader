/**
 * The model-written parts of followed stories, the catch-up briefing and coverage comparisons.
 * Same rules as the other model calls: temperature 0, validated JSON, public text only, and at
 * the budget cap each falls back to headlines.
 */
import { loadCoverage, saveCoverageNote, type CoverageNote } from '../core/coverage';
import { saveSettings } from '../core/settings';
import { attachToStories } from '../core/stories';
import { loadTopicFilter } from '../core/topics';
import { DAY, HOUR, type BriefingItem } from '../core/types';
import { countWords, errMsg, mapLimit, safeJson } from '../core/util';
import type { Db } from '../db/db';
import { BudgetExceededError, chatJson, overBudget, type LlmDeps } from '../llm/openrouter';
import type { StepDeps } from './steps';

async function logDecision(db: Db, kind: string, refId: number | null, summary: string, detail: unknown, now: number): Promise<void> {
  await db.run('INSERT INTO decision_log(at, kind, ref_id, summary, detail) VALUES(?,?,?,?,?)',
    [now, kind, refId, summary.slice(0, 300), JSON.stringify(detail)]);
}

const clip = (s: string | null | undefined, n = 300) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------- followed stories

export const STORY_UPDATE_MAX_WORDS = 60;

export function validateStoryUpdate(v: unknown): { summary: string } | null {
  if (!v || typeof v !== 'object') return null;
  const summary = typeof (v as any).summary === 'string' ? (v as any).summary.trim() : '';
  if (!summary || countWords(summary) > STORY_UPDATE_MAX_WORDS) return null;
  return { summary };
}

const STORY_SYSTEM = `You write short updates on a FOLLOWED STORY for a reader who is following it. You are given the headline the reader started from, some EARLIER coverage they have already had, and NEW coverage published since they last looked.

Say what has changed: what the new coverage reports that the earlier coverage did not.
- at most 45 words, one or two sentences, British spelling, neutral in tone;
- attribute contested claims ("is reported to", "according to");
- do not repeat the background and do not judge any outlet;
- if the new coverage adds nothing of substance, say so in a few words.

Reply with only this JSON object:
{"summary": "<the update>"}`;

/**
 * Attaches new articles to followed stories, then writes "what changed" for each story whose new
 * coverage has grown since its note was last written. One model call per such story.
 */
export async function stepStories(d: StepDeps): Promise<string> {
  const now = d.now();
  const count = await d.db.get<{ n: number }>('SELECT COUNT(*) n FROM story');
  if (!count?.n) return 'no followed stories';
  const added = await attachToStories(d.db, d.settings.followThreshold, now);
  const stories = await d.db.all<any>(
    `SELECT st.id, st.title, st.last_checked_at, st.update_n,
            (SELECT COUNT(*) FROM story_article sa WHERE sa.story_id = st.id AND sa.added_at > st.last_checked_at) fresh
     FROM story st`,
  );
  const due = stories.filter((s) => s.fresh > 0 && s.fresh !== s.update_n);
  let calls = 0;
  let written = 0;
  let budgetHit = due.length ? await overBudget(d.db, d.settings, now) : false;
  await mapLimit(due, 4, async (st) => {
    if (budgetHit || !d.llm.apiKey) return;
    const rows = await d.db.all<any>(
      `SELECT a.title, a.summary, src.name, sa.added_at FROM story_article sa
       JOIN article a ON a.id = sa.article_id JOIN source src ON src.id = a.source_id
       WHERE sa.story_id = ? ORDER BY a.published_at DESC`,
      [st.id],
    );
    const line = (r: any) => `- ${r.name}: ${r.title}${r.summary ? ` — ${clip(r.summary)}` : ''}`;
    const fresh = rows.filter((r) => r.added_at > st.last_checked_at).slice(0, 8);
    const earlier = rows.filter((r) => r.added_at <= st.last_checked_at).slice(0, 5);
    const user = `STARTED FROM\n${st.title}\n\nEARLIER coverage\n${earlier.map(line).join('\n') || '(none kept)'}\n\nNEW coverage\n${fresh.map(line).join('\n')}`;
    try {
      calls++;
      const res = await chatJson(d.llm, { purpose: 'story', system: STORY_SYSTEM, user, validate: validateStoryUpdate, maxTokens: 220 });
      if (!res.value) {
        await logDecision(d.db, 'story', st.id, `Skipped (${res.error}): ${st.title}`, { llm: safeJson<unknown>(res.raw, res.raw) }, now);
        return;
      }
      // Only if the story was not opened meanwhile (opening clears the note).
      await d.db.run(
        'UPDATE story SET update_summary = ?, update_n = ?, update_at = ? WHERE id = ? AND last_checked_at = ?',
        [res.value.summary, st.fresh, now, st.id, st.last_checked_at],
      );
      await logDecision(d.db, 'story', st.id, `Update (${st.fresh} new): ${res.value.summary}`, { headlines: fresh.map((r) => `${r.name}: ${r.title}`) }, now);
      written++;
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        budgetHit = true;
        return;
      }
      await logDecision(d.db, 'story', st.id, 'Error', { error: errMsg(e, [d.llm.apiKey]) }, now);
    }
  });
  return `${stories.length} followed: ${added} articles joined, ${written} updates written, ${calls} LLM calls` +
    (budgetHit ? ', budget reached (headlines only)' : '');
}

// ---------------------------------------------------------------- catch-up briefing

export const BRIEFING_ITEMS = 5;
export const BRIEFING_MIN_OUTLETS = 2;
/** However long the app was away, the briefing looks back no further than this. */
export const BRIEFING_MAX_LOOKBACK = 3 * DAY;
export const BRIEFING_MAX_WORDS = 40;

export function validateBriefing(v: unknown, ids: string[]): Record<string, string> | null {
  if (!v || typeof v !== 'object' || !Array.isArray((v as any).items)) return null;
  const out: Record<string, string> = {};
  for (const it of (v as any).items) {
    if (!it || typeof it.id !== 'string' || typeof it.sentence !== 'string') return null;
    const sentence = it.sentence.trim();
    if (!ids.includes(it.id) || !sentence || countWords(sentence) > BRIEFING_MAX_WORDS) return null;
    out[it.id] = sentence;
  }
  return ids.every((id) => out[id]) ? out : null;
}

const BRIEFING_SYSTEM = `You write a catch-up NEWS BRIEFING for a reader who has been away. You are given several stories, each with headlines and summaries from the outlets reporting it.

For each story write one sentence, at most 30 words, in British spelling, saying what happened. Attribute claims ("is reported to", "according to") where the facts are contested. Do not say whether a story is true or important, and do not adopt loaded wording from the headlines.

Reply with only this JSON object, one entry per story, using the ids given:
{"items": [{"id": "<story id>", "sentence": "<one sentence>"}]}`;

/**
 * Writes the catch-up briefing when one is due (the app came back after a long gap): the stories
 * most outlets ran while it was away, one sentence each. Muted topics are left out. Without the
 * model (no key, or the budget cap) each item shows a headline instead.
 */
export async function stepBriefing(d: StepDeps): Promise<string> {
  // Read afresh: a session that began during this run may have asked for one.
  const row = await d.db.get<{ value: string }>("SELECT value FROM setting WHERE key = 'briefingSince'");
  const asked = Number(safeJson<number>(row?.value, 0)) || 0;
  if (!asked) return 'not due';
  const now = d.now();
  if (!d.settings.briefingEnabled) {
    await saveSettings(d.db, { briefingSince: 0 });
    return 'switched off';
  }
  const since = Math.max(asked, now - BRIEFING_MAX_LOOKBACK);
  const rows = await d.db.all<any>(
    `SELECT a.id, a.cluster_id, a.source_id, a.title, a.summary, a.section, a.tags, a.published_at,
            src.name, src.role, src.paywalled
     FROM article a JOIN source src ON src.id = a.source_id AND src.enabled = 1
     WHERE a.cluster_id IS NOT NULL AND a.published_at > ? AND a.published_at <= ?
     ORDER BY a.published_at DESC, a.id`,
    [since, now + HOUR],
  );
  const topics = await loadTopicFilter(d.db, now);
  const byCluster = new Map<number, any[]>();
  for (const r of rows) {
    const list = byCluster.get(r.cluster_id) ?? [];
    list.push(r);
    byCluster.set(r.cluster_id, list);
  }
  const stories = Array.from(byCluster.entries())
    .map(([clusterId, members]) => ({
      clusterId,
      members,
      outlets: new Set(members.map((m) => m.source_id)).size,
      latest: members[0].published_at as number,
    }))
    .filter((s) => s.outlets >= BRIEFING_MIN_OUTLETS)
    .filter((s) => !s.members.some((m) => topics.muted({ title: m.title, summary: m.summary, section: m.section, tags: safeJson<string[]>(m.tags, []) })))
    .sort((a, b) => b.outlets - a.outlets || b.latest - a.latest)
    .slice(0, BRIEFING_ITEMS);
  if (!stories.length) {
    await saveSettings(d.db, { briefingSince: 0 });
    return 'nothing widely covered while away';
  }
  const items: BriefingItem[] = stories.map((s) => {
    // The piece to open: a primary source's, else one that reads in the app, else the newest.
    const lead = s.members.find((m) => m.role === 'primary') ?? s.members.find((m) => !m.paywalled) ?? s.members[0];
    return { clusterId: s.clusterId, articleId: lead.id, headline: lead.title, sentence: null, outletCount: s.outlets };
  });

  let how = 'headlines only';
  if (d.llm.apiKey && !(await overBudget(d.db, d.settings, now))) {
    const ids = stories.map((_, i) => `s${i + 1}`);
    const user = stories.map((s, i) => {
      const seen = new Set<number>();
      const lines = s.members.filter((m) => !seen.has(m.source_id) && seen.add(m.source_id)).slice(0, 5)
        .map((m) => `- ${m.name}: ${m.title}${m.summary ? ` — ${clip(m.summary, 240)}` : ''}`);
      return `STORY ${ids[i]}\n${lines.join('\n')}`;
    }).join('\n\n');
    try {
      const res = await chatJson(d.llm, {
        purpose: 'briefing', system: BRIEFING_SYSTEM, user, validate: (v) => validateBriefing(v, ids), maxTokens: 500,
      });
      if (res.value) {
        items.forEach((it, i) => { it.sentence = res.value![ids[i]]; });
        how = '1 LLM call';
      } else {
        how = `headlines only (${res.error})`;
      }
    } catch (e) {
      how = e instanceof BudgetExceededError ? 'headlines only (budget reached)' : `headlines only (${errMsg(e, [d.llm.apiKey])})`;
    }
  }
  await d.db.tx(async () => {
    await d.db.run('INSERT INTO briefing(created_at, since_at, items) VALUES(?,?,?)', [now, since, JSON.stringify(items)]);
    await d.db.run(
      "INSERT INTO setting(key, value) VALUES('briefingSince', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
  });
  return `${items.length} stories since ${new Date(since).toISOString().slice(0, 16)}Z, ${how}`;
}

// ---------------------------------------------------------------- coverage comparison

export const COMPARE_MAX_WORDS = 60;

export function validateCompare(v: unknown): { agree: string; differ: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as any;
  if (typeof o.agree !== 'string' || typeof o.differ !== 'string') return null;
  const agree = o.agree.trim();
  const differ = o.differ.trim();
  if (!agree || !differ || countWords(agree) > COMPARE_MAX_WORDS || countWords(differ) > COMPARE_MAX_WORDS) return null;
  return { agree, differ };
}

const COMPARE_SYSTEM = `You COMPARE COVERAGE of one news story across outlets. You are given each outlet's headline and summary.

Write two short notes for a reader who wants to see how the coverage differs:
- "agree": the facts the outlets share, at most 45 words;
- "differ": how they differ in framing and emphasis (what each leads on, whom it quotes, what it stresses or leaves out), naming the outlets, at most 45 words.
British spelling, neutral in tone. Do not judge any outlet, do not describe an outlet's politics, and where only headlines are available describe the emphasis of the headlines.

Reply with only this JSON object:
{"agree": "<note>", "differ": "<note>"}`;

/**
 * Writes (and stores) the "where they agree, where they differ" note for the story an article
 * reports. Made on request from the Full coverage screen, one model call. Throws
 * BudgetExceededError at the cap and an Error when there is nothing to compare.
 */
export async function compareCoverage(llm: LlmDeps, articleId: number): Promise<CoverageNote> {
  const cov = await loadCoverage(llm.db, articleId);
  if (!cov) throw new Error('That article is no longer stored');
  // One piece per outlet, newest first, at most ten outlets.
  const perOutlet = new Map<string, (typeof cov.rows)[number]>();
  for (const r of cov.rows.slice().sort((a, b) => b.article.publishedAt - a.article.publishedAt)) {
    if (!perOutlet.has(r.sourceName)) perOutlet.set(r.sourceName, r);
  }
  if (perOutlet.size < 2) throw new Error('Only one outlet has covered this story so far');
  const user = Array.from(perOutlet.values()).slice(0, 10)
    .map((r) => `Outlet: ${r.sourceName}\nHeadline: ${r.article.title}\nSummary: ${clip(r.article.summary, 400) || '(none)'}`)
    .join('\n\n');
  const res = await chatJson(llm, { purpose: 'compare', system: COMPARE_SYSTEM, user, validate: validateCompare, maxTokens: 320 });
  const now = llm.now();
  if (!res.value) {
    await logDecision(llm.db, 'compare', articleId, `Skipped (${res.error}): ${cov.title}`, { llm: safeJson<unknown>(res.raw, res.raw) }, now);
    throw new Error('The model did not give a usable answer');
  }
  await saveCoverageNote(llm.db, cov.key, res.value.agree, res.value.differ, cov.outletCount, now);
  await logDecision(llm.db, 'compare', articleId, `Compared ${perOutlet.size} outlets: ${cov.title}`, res.value, now);
  return { ...res.value, outlets: cov.outletCount, at: now };
}
