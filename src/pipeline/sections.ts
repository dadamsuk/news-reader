import { inColdStart, loadWeights, normTag, relevance, signalsSince, tagWeightExtremes, recentSignals } from '../core/learning';
import { loadSectionsSettings, saveModeSettings, type Mode, type SectionsSettings } from '../core/modes';
import { addProfileVersion, enforcePinned, getProfile, normaliseMarkdown, PROFILE_HEADINGS, type Profile } from '../core/profile';
import { placement } from '../core/sections';
import { DAY, HOUR, type Priority, type RawItem, type Source, type StepResult } from '../core/types';
import {
  blobToVec, canonicalUrl, countWords, dot, errMsg, mapLimit, normalize, safeJson, stripHtml, truncateWords, vecToBlob,
} from '../core/util';
import type { Db } from '../db/db';
import { BudgetExceededError, chatJson, overBudget } from '../llm/openrouter';
import { stepEmbed, stepFetch, type StepDeps } from './steps';

/**
 * The pipeline of a sections-layout mode (PRD "Ingestion and processing"): fetch, split digests,
 * prefilter, embed and cluster, enrich (one model call per story, batched), score, assign. Plain
 * TypeScript with its dependencies passed in; nothing awaited depends on a JavaScript timer.
 */

const PRIORITY_RANK: Record<Priority, number> = { high: 3, normal: 2, low: 1 };
const OVERLAP = 6 * HOUR;

// ---------------------------------------------------------------- fetch, prefilter, store

/** The earliest item wanted: never older than the mode's max age. Hacker News is read in full each time (points grow). */
export function sinceFor(s: SectionsSettings) {
  return (src: Source, now: number) => {
    const oldest = now - s.maxAgeDays * DAY;
    if (src.adapter === 'hn_api' || !src.lastOkAt) return oldest;
    return Math.max(oldest, src.lastOkAt - OVERLAP);
  };
}

/**
 * Stores a source's items in the mode, one row per canonical URL. When another source brings a URL
 * the mode already has, that is more coverage of the same story: it is recorded as a mention (with
 * its Hacker News points and digest words), and if the new source has the higher priority it takes
 * the item over (the original beats commentary, which beats digests). Returns rows and mentions added.
 */
export async function insertSectionItems(db: Db, source: Source, items: RawItem[], now: number): Promise<number> {
  let added = 0;
  const titles = new Set<string>();
  await db.tx(async () => {
    for (const it of items) {
      const canonical = canonicalUrl(it.url);
      const title = it.title.trim();
      if (!canonical || !title || titles.has(title.toLowerCase())) continue;
      titles.add(title.toLowerCase());
      const existing = await db.get<any>(
        `SELECT a.id, a.source_id, a.hn_points, a.digest_context, a.url, s.priority, s.is_digest
         FROM article a JOIN source s ON s.id = a.source_id WHERE a.mode_id = ? AND a.canonical_url = ?`,
        [source.modeId, canonical],
      );
      if (!existing) {
        const r = await db.run(
          `INSERT OR IGNORE INTO article(mode_id, source_id, canonical_url, url, external_id, title, summary, image_url, published_at,
             section, tags, tone, byline, word_count, adapter_body, fetched_at, digest_context, hn_points)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
           WHERE NOT EXISTS (SELECT 1 FROM article WHERE source_id = ? AND title = ? AND published_at > ?)`,
          [source.modeId, source.id, canonical, it.url, it.externalId ?? null, title, (it.summary ?? '').trim(), it.imageUrl ?? null,
            it.publishedAt ?? now, it.section ?? null, JSON.stringify(it.tags ?? []), it.tone ?? null, it.byline ?? null,
            it.wordCount ?? null, it.adapterBody ?? null, now, it.digestContext ?? null, it.hnPoints ?? null,
            source.id, title, now - 7 * DAY],
        );
        added += r.changes;
        continue;
      }
      if (existing.source_id === source.id) {
        // The same source again: points may have grown; nothing else changes.
        if (it.hnPoints != null && it.hnPoints !== existing.hn_points) {
          await db.run('UPDATE article SET hn_points = ? WHERE id = ?', [it.hnPoints, existing.id]);
        }
        await db.run('UPDATE article_mention SET hn_points = COALESCE(?, hn_points) WHERE article_id = ? AND source_id = ?', [it.hnPoints ?? null, existing.id, source.id]);
        continue;
      }
      const mine = PRIORITY_RANK[source.priority] * 2 + (source.isDigest ? 0 : 1);
      const theirs = PRIORITY_RANK[(existing.priority ?? 'normal') as Priority] * 2 + (existing.is_digest ? 0 : 1);
      if (mine > theirs) {
        // The new source is the better owner of this story: it takes the item, the old one becomes a mention.
        const oldMention = await db.get<any>('SELECT 1 x FROM article_mention WHERE article_id = ? AND source_id = ?', [existing.id, existing.source_id]);
        if (!oldMention) {
          await db.run(
            'INSERT INTO article_mention(article_id, source_id, url, hn_points, context, at) VALUES(?,?,?,?,?,?)',
            [existing.id, existing.source_id, existing.url, existing.hn_points ?? null, existing.digest_context ?? null, now],
          );
        }
        await db.run(
          `UPDATE article SET source_id = ?, url = ?, title = ?, summary = CASE WHEN ? != '' THEN ? ELSE summary END,
             image_url = COALESCE(?, image_url), word_count = COALESCE(?, word_count), adapter_body = COALESCE(?, adapter_body),
             published_at = MIN(published_at, ?) WHERE id = ?`,
          [source.id, it.url, title, (it.summary ?? '').trim(), (it.summary ?? '').trim(), it.imageUrl ?? null, it.wordCount ?? null,
            it.adapterBody ?? null, it.publishedAt ?? now, existing.id],
        );
        await db.run('DELETE FROM article_mention WHERE article_id = ? AND source_id = ?', [existing.id, source.id]);
        added++;
        continue;
      }
      const r = await db.run(
        `INSERT INTO article_mention(article_id, source_id, url, hn_points, context, at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(article_id, source_id) DO UPDATE SET hn_points = COALESCE(excluded.hn_points, hn_points)`,
        [existing.id, source.id, it.mentionUrl ?? it.url, it.hnPoints ?? null, it.digestContext ?? null, now],
      );
      if (r.changes && it.hnPoints != null) await db.run('UPDATE article SET hn_points = MAX(COALESCE(hn_points, 0), ?) WHERE id = ?', [it.hnPoints, existing.id]);
      const fresh = await db.get<{ n: number }>('SELECT COUNT(*) n FROM article_mention WHERE article_id = ? AND source_id = ? AND at = ?', [existing.id, source.id, now]);
      added += fresh?.n ?? 0;
    }
  });
  return added;
}

// ---------------------------------------------------------------- cluster

interface MemCluster {
  id: number;
  sum: Float32Array;
  unit: Float32Array;
  size: number;
  dirty: boolean;
  isNew: boolean;
}

/**
 * Same story, one card. Each new item joins the closest story of the last 72 hours at or above the
 * mode's threshold (0.75), else starts one. Then each touched story's primary item is chosen by
 * source priority (original beats commentary beats digests). A story whose primary changes to a
 * higher-priority source is enriched again; otherwise late coverage only adds sources.
 */
export async function clusterSections(db: Db, modeId: number, s: SectionsSettings, now: number): Promise<string> {
  const window = s.clusterWindowHours * HOUR;
  const crows = await db.all<{ id: number; centroid: Uint8Array; size: number }>(
    'SELECT id, centroid, size FROM cluster WHERE mode_id = ? AND created_at > ? AND centroid IS NOT NULL', [modeId, now - window],
  );
  const clusters: MemCluster[] = [];
  for (const c of crows) {
    const mean = blobToVec(c.centroid);
    if (!mean) continue;
    const sum = new Float32Array(mean.length);
    for (let i = 0; i < mean.length; i++) sum[i] = mean[i] * c.size;
    clusters.push({ id: c.id, sum, unit: normalize(mean), size: c.size, dirty: false, isNew: false });
  }
  const arts = await db.all<{ id: number; embedding: Uint8Array; published_at: number }>(
    'SELECT id, embedding, published_at FROM article WHERE mode_id = ? AND cluster_id IS NULL AND embedding IS NOT NULL ORDER BY published_at ASC',
    [modeId],
  );
  const touched = new Set<number>();
  let joined = 0;
  let created = 0;
  for (const a of arts) {
    const v = blobToVec(a.embedding);
    if (!v) continue;
    let best: MemCluster | null = null;
    let bestSim = -1;
    for (const c of clusters) {
      if (c.unit.length !== v.length) continue;
      const sim = dot(v, c.unit);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= s.clusterThreshold) {
      for (let i = 0; i < v.length; i++) best.sum[i] += v[i];
      best.size++;
      best.unit = normalize(best.sum);
      best.dirty = true;
      await db.run('UPDATE article SET cluster_id = ? WHERE id = ?', [best.id, a.id]);
      touched.add(best.id);
      joined++;
    } else {
      const r = await db.run(
        'INSERT INTO cluster(mode_id, created_at, last_article_at, centroid, size) VALUES(?,?,?,?,1)',
        [modeId, Math.min(now, a.published_at), a.published_at, vecToBlob(v)],
      );
      await db.run('UPDATE article SET cluster_id = ? WHERE id = ?', [r.lastInsertRowId, a.id]);
      clusters.push({ id: r.lastInsertRowId, sum: Float32Array.from(v), unit: v, size: 1, dirty: false, isNew: true });
      touched.add(r.lastInsertRowId);
      created++;
    }
  }
  await db.tx(async () => {
    for (const c of clusters) {
      if (!c.dirty) continue;
      const mean = new Float32Array(c.sum.length);
      for (let i = 0; i < mean.length; i++) mean[i] = c.sum[i] / c.size;
      await db.run('UPDATE cluster SET centroid = ?, size = ? WHERE id = ?', [vecToBlob(mean), c.size, c.id]);
    }
  });
  let reenrich = 0;
  for (const cid of touched) if (await choosePrimary(db, cid)) reenrich++;
  return `${arts.length} items: ${joined} joined a story, ${created} new stories` + (reenrich ? `, ${reenrich} to summarise again (a higher-priority source arrived)` : '');
}

/** Picks a story's primary item. Returns true when it moved to a higher-priority source (the story is enriched again). */
async function choosePrimary(db: Db, clusterId: number): Promise<boolean> {
  const members = await db.all<any>(
    `SELECT a.id, a.published_at, s.priority, s.is_digest FROM article a JOIN source s ON s.id = a.source_id
     WHERE a.cluster_id = ? ORDER BY a.published_at ASC, a.id ASC`,
    [clusterId],
  );
  if (!members.length) return false;
  const rank = (m: any) => PRIORITY_RANK[(m.priority ?? 'normal') as Priority] * 2 + (m.is_digest ? 0 : 1);
  const best = members.slice().sort((a, b) => rank(b) - rank(a))[0];
  const cur = await db.get<{ primary_article_id: number | null; enriched_at: number | null }>(
    'SELECT primary_article_id, enriched_at FROM cluster WHERE id = ?', [clusterId],
  );
  if (cur?.primary_article_id === best.id) return false;
  const old = members.find((m) => m.id === cur?.primary_article_id);
  const higher = !!old && rank(best) > rank(old);
  await db.run(
    `UPDATE cluster SET primary_article_id = ?, last_article_at = MAX(last_article_at, ?)${higher ? ', enriched_at = NULL' : ''} WHERE id = ?`,
    [best.id, Math.max(...members.map((m) => m.published_at)), clusterId],
  );
  return higher && cur?.enriched_at != null;
}

// ---------------------------------------------------------------- enrich

export interface EnrichItem {
  id: string;
  headline: string;
  summary: string;
  why: string;
  tags: string[];
  type: string;
  profile_match: number;
  impact: number;
  profile_lines: string[];
}

const HYPE = /\b(groundbreaking|game-chang\w*|revolution\w*|unprecedented|mind-blowing|jaw-dropping|stunning|insane)\b/gi;

/** Holds a text to the style rules that can be checked: no exclamation marks, no em dashes, word limits. */
export function styled(s: string, maxWords: number): string {
  const t = String(s ?? '').replace(/\s*[—–]\s*/g, ', ').replace(/!+/g, '.').replace(HYPE, '').replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1').replace(/^[,.;:\s]+/, '').trim();
  return countWords(t) > maxWords ? truncateWords(t, maxWords).replace(/…$/, '') : t;
}

const clamp01 = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : null);

/** Checks one enrichment answer: known id, the fields, limits and the mode's taxonomy and item types. */
export function validateEnrich(v: unknown, ids: string[], s: SectionsSettings): EnrichItem[] | null {
  const list = (v as any)?.items;
  if (!Array.isArray(list)) return null;
  const tax = new Map(s.taxonomy.map((t) => [normTag(t), t]));
  const out: EnrichItem[] = [];
  for (const o of list) {
    if (!o || typeof o !== 'object' || !ids.includes(o.id) || out.some((x) => x.id === o.id)) continue;
    const pm = clamp01(o.profile_match);
    const impact = clamp01(o.impact);
    if (typeof o.headline !== 'string' || !o.headline.trim() || typeof o.summary !== 'string' || pm == null || impact == null) continue;
    const tags = (Array.isArray(o.tags) ? o.tags : []).map((t: unknown) => normTag(String(t)))
      .filter((t: string) => !tax.size || tax.has(t)).slice(0, 4);
    const type = s.itemTypes.includes(String(o.type)) ? String(o.type) : 'opinion';
    out.push({
      id: o.id,
      headline: styled(o.headline, 10),
      summary: styled(o.summary, 20),
      why: styled(typeof o.why === 'string' ? o.why : '', 15),
      tags: Array.from(new Set(tags)),
      type,
      profile_match: pm,
      impact,
      profile_lines: (Array.isArray(o.profile_lines) ? o.profile_lines : []).map(String).filter(Boolean).slice(0, 3),
    });
  }
  return out.length ? out : null;
}

export function enrichSystem(s: SectionsSettings, profile: string): string {
  return `You prepare an ENRICHMENT of news items for one reader's feed. Each item is one story (sometimes covered by several sources).

For each item write:
- headline: a plain rewritten headline, at most 9 words (never more than 10).
- summary: one line of at most 18 words (never more than 20), saying what the thing is and what changed.
- why: "why it matters to you", one short sentence of at most 12 words (never more than 15), written for this reader against the profile below. Do not start with "Direct" or "Critical".
- tags: 1 to 4 topic tags chosen only from this list: ${s.taxonomy.join('; ') || '(any short topic words)'}.
- type: one of ${s.itemTypes.join(', ')}.
- profile_match: 0 to 1, how well the story fits the reader's profile (interests up, "not interested in" down).
- impact: 0 to 1, how much this matters to the industry as a whole, whatever the reader's interests.
- profile_lines: the profile lines (copied exactly) that most decide profile_match, at most 2; empty if none.

Style rules:
${s.styleRules}

READER PROFILE
${profile}

Reply with only this JSON object:
{"items": [{"id": "<item id>", "headline": "...", "summary": "...", "why": "...", "tags": ["..."], "type": "...", "profile_match": 0.0, "impact": 0.0, "profile_lines": ["..."]}]}`;
}

function firstWords(html: string | null, n: number): string {
  if (!html) return '';
  return stripHtml(html).split(/\s+/).slice(0, n).join(' ');
}

interface PendingStory {
  clusterId: number;
  primaryId: number;
  title: string;
  summary: string;
  source: string;
  context: string | null;
  body: string;
  others: string[];
}

async function pendingStories(db: Db, modeId: number, now: number, limit: number): Promise<PendingStory[]> {
  const rows = await db.all<any>(
    `SELECT c.id cid, a.id aid, a.title, a.summary, a.digest_context, a.adapter_body, a.body_html, s.name
     FROM cluster c JOIN article a ON a.id = c.primary_article_id JOIN source s ON s.id = a.source_id
     WHERE c.mode_id = ? AND c.enriched_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?)
       AND NOT EXISTS (SELECT 1 FROM impression i JOIN article m ON m.id = i.article_id WHERE m.cluster_id = c.id)
     ORDER BY c.last_article_at DESC LIMIT ?`,
    [modeId, now, limit],
  );
  const out: PendingStory[] = [];
  for (const r of rows) {
    const others = await db.all<{ t: string }>(
      `SELECT s.name || ': ' || a.title t FROM article a JOIN source s ON s.id = a.source_id WHERE a.cluster_id = ? AND a.id != ?
       UNION ALL SELECT s.name || ': ' || COALESCE(m.context, '') FROM article_mention m JOIN source s ON s.id = m.source_id WHERE m.article_id = ?
       LIMIT 4`,
      [r.cid, r.aid, r.aid],
    );
    out.push({
      clusterId: r.cid, primaryId: r.aid, title: r.title, summary: stripHtml(r.summary).slice(0, 500), source: r.name,
      context: r.digest_context ? String(r.digest_context).slice(0, 600) : null,
      body: firstWords(r.adapter_body ?? r.body_html, 150), others: others.map((o) => o.t.slice(0, 240)),
    });
  }
  return out;
}

export function enrichPrompt(items: PendingStory[]): string {
  return items.map((it, i) => [
    `ITEM s${i + 1}`,
    `Source: ${it.source}`,
    `Headline: ${it.title}`,
    it.summary ? `Summary: ${it.summary}` : '',
    it.context ? `Digest's words: ${it.context}` : '',
    it.body ? `Opening text: ${it.body}` : '',
    ...it.others.map((o) => `Also covered by ${o}`),
  ].filter(Boolean).join('\n')).join('\n\n');
}

export interface SectionsDeps extends StepDeps {
  shouldStop?: () => boolean;
}

/**
 * One model call per story, never per item, several stories to a request. Stories already seen,
 * or expired, are not enriched. At the budget cap nothing is called: the cards show the source's
 * headline, and the stories still unseen are enriched when the month turns. A failed call leaves
 * them for a later run.
 */
export async function enrichStories(d: SectionsDeps, mode: Mode, s: SectionsSettings): Promise<string> {
  const now = d.now();
  const profile = await getProfile(d.db, mode.id);
  const pending = await pendingStories(d.db, mode.id, now, 400);
  if (!pending.length) return 'nothing to enrich';
  // Every story pending is tried this run, so it can be shown with its source headline if it fails.
  const markTried = (ids: number[]) => d.db.run(
    `UPDATE cluster SET enrich_tried_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [now, ...ids],
  );
  if (await overBudget(d.db, d.settings, now)) {
    await markTried(pending.map((p) => p.clusterId));
    return `${pending.length} waiting: budget reached (source headlines shown)`;
  }
  if (!d.llm.apiKey) throw new Error('No OpenRouter key set');
  const size = Math.max(1, Math.round(s.enrichBatchSize));
  const batches: PendingStory[][] = [];
  for (let i = 0; i < pending.length; i += size) batches.push(pending.slice(i, i + size));
  const system = enrichSystem(s, profile?.markdown ?? '');
  let done = 0;
  let calls = 0;
  let failed = 0;
  let budgetHit = false;
  let stopped = false;
  await mapLimit(batches, 6, async (batch) => {
    if (budgetHit || d.shouldStop?.()) {
      stopped = stopped || !budgetHit;
      return;
    }
    const ids = batch.map((_, i) => `s${i + 1}`);
    try {
      calls++;
      const res = await chatJson<EnrichItem[]>(d.llm, {
        purpose: 'enrich', system, user: enrichPrompt(batch), validate: (v) => validateEnrich(v, ids, s), maxTokens: 220 * batch.length + 100,
      });
      const got = new Map((res.value ?? []).map((v) => [v.id, v]));
      await d.db.tx(async () => {
        for (let i = 0; i < batch.length; i++) {
          const e = got.get(ids[i]);
          const st = batch[i];
          if (!e) {
            failed++;
            await d.db.run('UPDATE cluster SET enrich_tried_at = ?, enrich_error = ? WHERE id = ?', [now, res.error ?? 'missing from the answer', st.clusterId]);
            continue;
          }
          await d.db.run(
            `UPDATE cluster SET headline = ?, summary = ?, why_it_matters = ?, tags = ?, item_type = ?, profile_match = ?, impact = ?,
               why_lines = ?, enriched_at = ?, enrich_tried_at = ?, enrich_error = NULL, profile_version = ? WHERE id = ?`,
            [e.headline, e.summary, e.why || null, JSON.stringify(e.tags), e.type, e.profile_match, e.impact,
              JSON.stringify(e.profile_lines), now, now, profile?.version ?? 0, st.clusterId],
          );
          done++;
        }
      });
    } catch (e) {
      if (e instanceof BudgetExceededError) budgetHit = true;
      failed += batch.length;
      await markTried(batch.map((b) => b.clusterId));
      if (!(e instanceof BudgetExceededError)) {
        await d.db.run('UPDATE cluster SET enrich_error = ? WHERE id IN (' + batch.map(() => '?').join(',') + ')',
          [errMsg(e, [d.llm.apiKey]), ...batch.map((b) => b.clusterId)]);
      }
    }
  });
  if (budgetHit || stopped) await markTried(pending.map((p) => p.clusterId));
  return `${pending.length} stories: ${done} enriched in ${calls} calls` + (failed ? `, ${failed} left for a later run` : '')
    + (budgetHit ? ', budget reached' : '') + (stopped ? ', stopped: out of background time' : '');
}

// ---------------------------------------------------------------- rescore after a profile change

export function validateRescore(v: unknown, ids: string[]): { id: string; profile_match: number; profile_lines: string[] }[] | null {
  const list = (v as any)?.items;
  if (!Array.isArray(list)) return null;
  const out = list
    .filter((o: any) => o && ids.includes(o.id) && clamp01(o.profile_match) != null)
    .map((o: any) => ({ id: o.id, profile_match: clamp01(o.profile_match)!, profile_lines: (Array.isArray(o.profile_lines) ? o.profile_lines : []).map(String).slice(0, 2) }));
  return out.length ? out : null;
}

/** Unseen stories scored against an older profile are scored again, many to a call (only the match is asked for). */
export async function rescoreStories(d: SectionsDeps, mode: Mode, s: SectionsSettings): Promise<string> {
  const now = d.now();
  const profile = await getProfile(d.db, mode.id);
  if (!profile) return 'no profile';
  const rows = await d.db.all<any>(
    `SELECT c.id, c.headline, c.summary, c.tags FROM cluster c
     WHERE c.mode_id = ? AND c.enriched_at IS NOT NULL AND (c.profile_version IS NULL OR c.profile_version < ?)
       AND (c.expires_at IS NULL OR c.expires_at > ?)
       AND NOT EXISTS (SELECT 1 FROM impression i JOIN article m ON m.id = i.article_id WHERE m.cluster_id = c.id)`,
    [mode.id, profile.version, now],
  );
  if (!rows.length) return 'nothing to rescore';
  if (await overBudget(d.db, d.settings, now)) return `${rows.length} waiting: budget reached`;
  const system = `You RESCORE stories against a reader's interest profile, which has changed. For each story give profile_match, 0 to 1 (interests up, "not interested in" down), and the profile lines (copied exactly, at most 2) that decide it.

READER PROFILE
${profile.markdown}

Reply with only this JSON object:
{"items": [{"id": "<id>", "profile_match": 0.0, "profile_lines": ["..."]}]}`;
  let done = 0;
  let calls = 0;
  const batches: any[][] = [];
  for (let i = 0; i < rows.length; i += 25) batches.push(rows.slice(i, i + 25));
  for (const batch of batches) {
    if (d.shouldStop?.()) break;
    const ids = batch.map((_, i) => `r${i + 1}`);
    const user = batch.map((r, i) => `ID ${ids[i]}\nHeadline: ${r.headline}\nSummary: ${r.summary ?? ''}\nTags: ${safeJson<string[]>(r.tags, []).join(', ')}`).join('\n\n');
    try {
      calls++;
      const res = await chatJson(d.llm, { purpose: 'rescore', system, user, validate: (v) => validateRescore(v, ids), maxTokens: 60 * batch.length + 60 });
      for (const v of res.value ?? []) {
        const r = batch[ids.indexOf(v.id)];
        await d.db.run('UPDATE cluster SET profile_match = ?, why_lines = ?, profile_version = ? WHERE id = ?',
          [v.profile_match, JSON.stringify(v.profile_lines), profile.version, r.id]);
        done++;
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) break;
    }
  }
  return `${done} of ${rows.length} rescored in ${calls} calls`;
}

// ---------------------------------------------------------------- score and assign

/** Significance, 0 to 1, independent of the profile, and which of its inputs did most. */
export function significance(
  inp: { sources: number; hnPoints: number; release: boolean; impact: number }, s: SectionsSettings,
): { value: number; reason: string | null } {
  const parts = {
    'Widely covered': s.sigSourcesWeight * Math.min(1, Math.max(0, inp.sources - 1) / Math.max(1, s.sourcesSaturate - 1)),
    'Trending on HN': s.sigHnWeight * Math.min(1, inp.hnPoints / s.hnPointsFull),
    'Major release': s.sigReleaseWeight * (inp.release ? 1 : 0),
  };
  const value = Object.values(parts).reduce((a, b) => a + b, 0) + s.sigImpactWeight * inp.impact;
  const [label, top] = Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
  return { value, reason: top > 0 ? label : inp.impact > 0 ? 'High impact' : null };
}

/**
 * Scores every story still able to be shown: relevance (profile match and learned weights) and
 * significance (coverage, Hacker News, a major vendor release, impact); places it in a section or
 * holds it back; sets when it expires (the max age, or longer for very significant stories).
 */
export async function scoreStories(db: Db, modeId: number, s: SectionsSettings, now: number): Promise<string> {
  const w = await loadWeights(db, modeId);
  const rows = await db.all<any>(
    `SELECT c.id, c.tags, c.item_type, c.profile_match, c.impact, c.enriched_at, c.created_at, c.expires_at,
            p.source_id primary_source,
            (SELECT MIN(a.published_at) FROM article a WHERE a.cluster_id = c.id) first_at
     FROM cluster c JOIN article p ON p.id = c.primary_article_id
     WHERE c.mode_id = ? AND (c.expires_at IS NULL OR c.expires_at > ?)`,
    [modeId, now],
  );
  const counts = { main: 0, other: 0, held: 0 };
  await db.tx(async () => {
    for (const r of rows) {
      const srcs = await db.all<{ source_id: number; priority: string; hn: number | null }>(
        `SELECT a.source_id, s.priority, a.hn_points hn FROM article a JOIN source s ON s.id = a.source_id WHERE a.cluster_id = ?
         UNION ALL
         SELECT m.source_id, s.priority, m.hn_points hn FROM article_mention m JOIN article a ON a.id = m.article_id
           JOIN source s ON s.id = m.source_id WHERE a.cluster_id = ?`,
        [r.id, r.id],
      );
      const distinct = new Set(srcs.map((x) => x.source_id)).size;
      const hn = Math.max(0, ...srcs.map((x) => x.hn ?? 0));
      const release = r.item_type === 'release' && srcs.some((x) => x.priority === 'high');
      const sig = significance({ sources: distinct, hnPoints: hn, release, impact: r.impact ?? 0 }, s);
      const tags = safeJson<string[]>(r.tags, []);
      // Not yet enriched (or never, at the cap): an even profile match, so the card still shows.
      const rel = relevance(r.enriched_at != null ? r.profile_match ?? 0.5 : 0.5, tags, r.primary_source, w, s);
      // A story not yet enriched (at the budget cap, or the call failed) still shows, with its source's headline.
      const place = r.enriched_at != null ? placement(rel, sig.value, s, now) : 'main';
      counts[place]++;
      const days = sig.value >= s.longAgeSignificance ? s.longAgeDays : s.maxAgeDays;
      await db.run(
        `UPDATE cluster SET relevance = ?, significance = ?, section = ?, reason = ?, source_count = ?, hn_points = ?, expires_at = ? WHERE id = ?`,
        [rel, sig.value, place, sig.reason, distinct, hn || null, (r.first_at ?? r.created_at) + days * DAY, r.id],
      );
    }
  });
  return `${rows.length} stories: ${counts.main} in the main section, ${counts.other} could go in In other news, ${counts.held} held back`
    + (inColdStart(s, now) ? ' (cold start)' : '');
}

// ---------------------------------------------------------------- profile rewrite

export function validateProfile(v: unknown): string | null {
  const md = (v as any)?.markdown;
  if (typeof md !== 'string' || !md.trim()) return null;
  if (!PROFILE_HEADINGS.every((h) => new RegExp(`^##\\s+${h}\\s*$`, 'mi').test(md))) return null;
  return md;
}

/** Due weekly or after 50 signals (settings), whichever first, and only when there is something new to learn from. */
export async function profileRewriteDue(db: Db, modeId: number, s: SectionsSettings, now: number): Promise<boolean> {
  const n = await signalsSince(db, modeId, s.lastProfileRewriteAt);
  if (!n) return false;
  return n >= s.profileRewriteSignals || now - s.lastProfileRewriteAt >= s.profileRewriteDays * DAY;
}

/**
 * The model rewrites the profile from the signal log. Pinned lines must survive word for word: the
 * prompt says so, and whatever comes back is checked and the pinned lines put back if any went.
 * Tags that graduated from In other news are put to it to consider. A new version; old ones stay.
 */
export async function rewriteProfile(d: SectionsDeps, mode: Mode, s: SectionsSettings): Promise<Profile | null> {
  const now = d.now();
  const cur = await getProfile(d.db, mode.id);
  if (!cur) return null;
  const signals = await recentSignals(d.db, mode.id, 120);
  const fresh = signals.filter((x) => x.at > s.lastProfileRewriteAt);
  const ext = await tagWeightExtremes(d.db, mode.id, 10);
  const graduated = Object.entries(s.graduated).filter(([, at]) => at > s.lastProfileRewriteAt).map(([t]) => t);
  const system = `You maintain a reader's PROFILE REWRITE: a short markdown document with exactly these headings: ${PROFILE_HEADINGS.map((h) => `"## ${h}"`).join(', ')}. Each heading has bullet lines ("- ...").

Rewrite it from the reader's recent signals so it describes what they want now. Rules:
- Keep every PINNED line exactly as written, word for word, under the heading it is under.
- You may add lines, and reword, merge or drop lines that are not pinned. Be conservative: change a line only when the signals clearly support it.
- Keep it short: at most 12 lines under any heading. Plain English, British spelling, no em dashes.
- "Sources I value" lists sources the reader clearly favours or avoids, if the signals show it.

Reply with only this JSON object:
{"markdown": "<the whole profile>"}`;
  const user = [
    'CURRENT PROFILE', cur.markdown,
    'PINNED LINES (keep word for word)', cur.pinned.length ? cur.pinned.join('\n') : '(none)',
    'RECENT SIGNALS (weight, what, story)',
    ...fresh.slice(0, 100).map((x) => `${x.weight >= 0 ? '+' : ''}${x.weight.toFixed(2)} ${x.kind}${x.section === 'other' ? ' (In other news)' : ''}: ${x.headline}`),
    'LEARNED TOPIC WEIGHTS', [...ext.top, ...ext.bottom].map(([t, v]) => `${t}: ${v.toFixed(2)}`).join('\n') || '(none)',
    graduated.length ? `NEW INTERESTS TO CONSIDER (opened repeatedly from In other news): ${graduated.join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
  const res = await chatJson<string>(d.llm, { purpose: 'profile', system, user, validate: validateProfile, maxTokens: 900 });
  if (!res.value) return null;
  const kept = enforcePinned(normaliseMarkdown(res.value), cur.markdown, cur.pinned);
  const next = await addProfileVersion(d.db, mode.id, kept, cur.pinned, 'llm', now);
  await saveModeSettings(d.db, mode.id, { lastProfileRewriteAt: now });
  return next;
}

// ---------------------------------------------------------------- the run for one mode

export type StepRunner = (name: string, fn: () => Promise<string>) => Promise<void>;

/**
 * One sections-layout mode's part of a refresh, as named steps (shown in Debug). Fetching respects
 * each source's refresh minutes (a pull fetches all); enrichment carries over from run to run.
 */
export async function runSectionsMode(
  d: SectionsDeps, mode: Mode, force: boolean, step: StepRunner, onReady?: () => void,
): Promise<void> {
  const s = await loadSectionsSettings(d.db, mode.id);
  const md: SectionsDeps = { ...d, llm: { ...d.llm, modeId: mode.id } };
  const p = `${mode.name}:`;
  await step(`${p} 1 Fetch, split and prefilter`, async () => {
    const r = await stepFetch(md, force, { modeId: mode.id, insert: (src, items, now) => insertSectionItems(md.db, src, items, now), since: sinceFor(s) });
    return r.info;
  });
  await step(`${p} 2 Embed and cluster`, async () => {
    const e = await stepEmbed(md, mode.id, s.maxAgeDays * DAY,
      (r) => [r.title, r.summary, r.digest_context].filter(Boolean).join('\n').slice(0, 1500));
    return `${e}; ${await clusterSections(md.db, mode.id, s, md.now())}`;
  });
  await step(`${p} 3 Enrich`, async () => {
    const e = await enrichStories(md, mode, s);
    const r = await rescoreStories(md, mode, s);
    return `${e}; ${r}`;
  });
  await step(`${p} 4 Score and assign`, async () => {
    try {
      return await scoreStories(md.db, mode.id, await loadSectionsSettings(md.db, mode.id), md.now());
    } finally {
      try {
        onReady?.();
      } catch {}
    }
  });
  await step(`${p} 5 Profile`, async () => {
    const now = md.now();
    const cur = await loadSectionsSettings(md.db, mode.id);
    if (!(await profileRewriteDue(md.db, mode.id, cur, now))) return 'not due';
    if (await overBudget(md.db, md.settings, now)) return 'due, but the budget is reached';
    const v = await rewriteProfile(md, mode, cur);
    return v ? `rewritten: version ${v.version}` : 'rewrite failed validation; kept the current profile';
  });
}

export type { StepResult };
