import { fetchSource } from '../adapters';
import { finalScore } from '../core/ranking';
import type { Settings } from '../core/settings';
import { LEAN_ORDER, listSources, type Secrets } from '../core/sources';
import { DAY, HOUR, type FetchFn, type Lean, type RawItem, type Source } from '../core/types';
import {
  blobToVec, canonicalUrl, countWords, dot, errMsg, mapLimit, normalize, safeJson, stripHtml, truncateWords, vecToBlob,
} from '../core/util';
import type { Db } from '../db/db';
import { BudgetExceededError, chatJson, embedTexts, overBudget, type LlmDeps } from '../llm/openrouter';

export interface StepDeps {
  db: Db;
  fetch: FetchFn;
  secrets: Secrets;
  settings: Settings;
  now: () => number;
  llm: LlmDeps;
}

const FIRST_LOOKBACK = 36 * HOUR;
const OVERLAP = 6 * HOUR;
const CLUSTER_WINDOW = 72 * HOUR;

// ---------------------------------------------------------------- 1 + 2: fetch, normalise, de-duplicate

export async function insertItems(db: Db, source: Pick<Source, 'id'>, items: RawItem[], now: number): Promise<number> {
  let added = 0;
  const seenTitles = new Set<string>();
  await db.tx(async () => {
    for (const it of items) {
      const canonical = canonicalUrl(it.url);
      const title = it.title.trim();
      if (!canonical || !title) continue;
      const tkey = title.toLowerCase();
      if (seenTitles.has(tkey)) continue;
      seenTitles.add(tkey);
      const r = await db.run(
        `INSERT OR IGNORE INTO article(source_id, canonical_url, url, external_id, title, summary, image_url, published_at,
           section, tags, tone, byline, word_count, adapter_body, fetched_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE NOT EXISTS (SELECT 1 FROM article WHERE source_id = ? AND title = ? AND published_at > ?)`,
        [source.id, canonical, it.url, it.externalId ?? null, title, (it.summary ?? '').trim(), it.imageUrl ?? null,
          it.publishedAt ?? now, it.section ?? null, JSON.stringify(it.tags ?? []), it.tone ?? null,
          it.byline ?? null, it.wordCount ?? null, it.adapterBody ?? null, now,
          source.id, title, now - 7 * DAY],
      );
      added += r.changes;
    }
  });
  return added;
}

export async function stepFetch(d: StepDeps, force: boolean): Promise<{ info: string; added: number; failed: string[] }> {
  const now = d.now();
  const sources = (await listSources(d.db)).filter((s) => s.enabled);
  // A pull-to-refresh fetches every source again, but not more than once every ten seconds.
  const minGap = force ? 10_000 : 0;
  const due = sources.filter((s) => {
    if (!s.lastFetchAt) return true;
    const gap = now - s.lastFetchAt;
    return force ? gap >= minGap : gap >= s.refreshMinutes * 60_000 - 30_000;
  });
  let added = 0;
  const failed: string[] = [];
  await mapLimit(due, 4, async (s) => {
    let key: string | null = null;
    try {
      key = s.apiKeyRef ? await d.secrets.get(s.apiKeyRef) : null;
      const since = Math.max(now - CLUSTER_WINDOW, s.lastOkAt ? s.lastOkAt - OVERLAP : now - FIRST_LOOKBACK);
      const { items, partialError } = await fetchSource(s, { fetch: d.fetch, apiKey: key, since, now });
      const n = await insertItems(d.db, s, items, now);
      added += n;
      if (partialError) failed.push(s.name);
      await d.db.run(
        `UPDATE source SET last_fetch_at = ?, last_ok_at = ?, last_error = ?, last_new_at = CASE WHEN ? > 0 THEN ? ELSE last_new_at END WHERE id = ?`,
        [now, partialError ? s.lastOkAt : now, partialError ? errMsg(partialError, [key]) : null, n, now, s.id],
      );
    } catch (e) {
      failed.push(s.name);
      await d.db.run('UPDATE source SET last_fetch_at = ?, last_error = ? WHERE id = ?', [now, errMsg(e, [key]), s.id]);
    }
  });
  return {
    info: `${due.length} of ${sources.length} sources fetched, ${added} new${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    added,
    failed,
  };
}

// ---------------------------------------------------------------- 3: embed

export async function stepEmbed(d: StepDeps): Promise<string> {
  const rows = await d.db.all<{ id: number; title: string; summary: string }>(
    'SELECT id, title, summary FROM article WHERE embedding IS NULL AND published_at > ? ORDER BY published_at DESC LIMIT 1500',
    [d.now() - CLUSTER_WINDOW - 12 * HOUR],
  );
  if (!rows.length) return 'nothing to embed';
  if (!d.llm.apiKey) throw new Error('No OpenRouter key set');
  let done = 0;
  for (let i = 0; i < rows.length; i += 96) {
    const batch = rows.slice(i, i + 96);
    const vecs = await embedTexts(d.llm, batch.map((r) => (r.summary ? `${r.title}\n${r.summary}` : r.title)));
    await d.db.tx(async () => {
      for (let j = 0; j < batch.length; j++) {
        await d.db.run('UPDATE article SET embedding = ? WHERE id = ?', [vecToBlob(vecs[j]), batch[j].id]);
      }
    });
    done += batch.length;
  }
  return `${done} embedded`;
}

// ---------------------------------------------------------------- 4: cluster

interface MemCluster {
  id: number;
  sum: Float32Array;
  unit: Float32Array;
  size: number;
  dirty: boolean;
}

/** Greedy online clustering: join the nearest recent cluster at or above the threshold, else start one. */
export async function stepCluster(d: StepDeps): Promise<string> {
  const now = d.now();
  const threshold = d.settings.clusterThreshold;
  const crows = await d.db.all<{ id: number; centroid: Uint8Array; size: number }>(
    'SELECT id, centroid, size FROM cluster WHERE created_at > ? AND centroid IS NOT NULL',
    [now - CLUSTER_WINDOW],
  );
  const clusters: MemCluster[] = [];
  for (const c of crows) {
    const mean = blobToVec(c.centroid);
    if (!mean) continue;
    const sum = new Float32Array(mean.length);
    for (let i = 0; i < mean.length; i++) sum[i] = mean[i] * c.size;
    clusters.push({ id: c.id, sum, unit: normalize(mean), size: c.size, dirty: false });
  }
  const arts = await d.db.all<{ id: number; embedding: Uint8Array; published_at: number }>(
    'SELECT id, embedding, published_at FROM article WHERE cluster_id IS NULL AND embedding IS NOT NULL ORDER BY published_at ASC',
  );
  let joined = 0;
  let created = 0;
  const assign: [number, number][] = [];
  for (const a of arts) {
    const v = blobToVec(a.embedding);
    if (!v) continue;
    let best: MemCluster | null = null;
    let bestSim = -1;
    for (const c of clusters) {
      if (c.unit.length !== v.length) continue;
      const s = dot(v, c.unit);
      if (s > bestSim) {
        bestSim = s;
        best = c;
      }
    }
    if (best && bestSim >= threshold) {
      for (let i = 0; i < v.length; i++) best.sum[i] += v[i];
      best.size++;
      best.unit = normalize(best.sum);
      best.dirty = true;
      assign.push([a.id, best.id]);
      joined++;
    } else {
      const r = await d.db.run(
        'INSERT INTO cluster(created_at, last_article_at, centroid, size) VALUES(?,?,?,1)',
        [Math.min(now, a.published_at), a.published_at, vecToBlob(v)],
      );
      clusters.push({ id: r.lastInsertRowId, sum: Float32Array.from(v), unit: v, size: 1, dirty: false });
      assign.push([a.id, r.lastInsertRowId]);
      created++;
    }
  }
  await d.db.tx(async () => {
    for (const [aid, cid] of assign) await d.db.run('UPDATE article SET cluster_id = ? WHERE id = ?', [cid, aid]);
    for (const c of clusters) {
      if (!c.dirty) continue;
      const mean = new Float32Array(c.sum.length);
      for (let i = 0; i < mean.length; i++) mean[i] = c.sum[i] / c.size;
      await d.db.run('UPDATE cluster SET centroid = ?, size = ? WHERE id = ?', [vecToBlob(mean), c.size, c.id]);
    }
  });
  await refreshClusterStats(d.db, now);
  return `${arts.length} articles: ${joined} joined a cluster, ${created} new clusters`;
}

/** Outlet counts depend on source roles and leans, which are settings, so they are recomputed every refresh. */
export async function refreshClusterStats(db: Db, now: number): Promise<void> {
  await db.run(
    `UPDATE cluster SET
       outlet_count = (SELECT COUNT(DISTINCT a.source_id) FROM article a WHERE a.cluster_id = cluster.id),
       last_article_at = COALESCE((SELECT MAX(a.published_at) FROM article a WHERE a.cluster_id = cluster.id), last_article_at),
       has_primary = EXISTS (SELECT 1 FROM article a JOIN source s ON s.id = a.source_id
                             WHERE a.cluster_id = cluster.id AND s.role = 'primary' AND s.enabled = 1),
       right_outlet_count = (SELECT COUNT(DISTINCT a.source_id) FROM article a JOIN source s ON s.id = a.source_id
                             WHERE a.cluster_id = cluster.id AND s.role = 'perspective' AND s.enabled = 1
                               AND s.lean IN ('right','centre-right') AND a.published_at > ?)
     WHERE created_at > ?`,
    [now - 36 * HOUR, now - 5 * DAY],
  );
}

// ---------------------------------------------------------------- 5: second sources

export interface Candidate {
  id: number;
  sourceId: number;
  sourceName: string;
  lean: Lean;
  title: string;
  summary: string;
  body: string | null;
  similarity: number;
}

/** Candidate order: explicit preference list if set, else the lean furthest from the primary; ties by similarity. */
export function orderCandidates(cands: Candidate[], primaryLean: Lean, preference: string[]): Candidate[] {
  const prefIndex = (name: string) => {
    const i = preference.findIndex((p) => p.toLowerCase().trim() === name.toLowerCase().trim());
    return i < 0 ? preference.length : i;
  };
  const dist = (c: Candidate) => Math.abs(LEAN_ORDER[c.lean] - LEAN_ORDER[primaryLean]);
  return cands.slice().sort((a, b) => {
    if (preference.length) {
      const p = prefIndex(a.sourceName) - prefIndex(b.sourceName);
      if (p !== 0) return p;
    }
    return dist(b) - dist(a) || b.similarity - a.similarity;
  });
}

export interface MatchAnswer {
  match_id: string | null;
  same_event: boolean;
  angle_note: string;
}

export function validateMatch(v: unknown, validIds: string[]): MatchAnswer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as any;
  if (typeof o.same_event !== 'boolean') return null;
  if (!(o.match_id === null || typeof o.match_id === 'string')) return null;
  if (typeof o.angle_note !== 'string') return null;
  if (o.same_event) {
    if (!o.match_id || !validIds.includes(o.match_id)) return null;
    const note = o.angle_note.trim();
    // No more than 20 words, and written for a reader rather than in the prompt's own terms.
    if (!note || countWords(note) > 20 || /\b(primary|candidate)\b/i.test(note)) return null;
    return { match_id: o.match_id, same_event: true, angle_note: note };
  }
  return { match_id: null, same_event: false, angle_note: '' };
}

const MATCH_SYSTEM = `You compare news coverage. You are given a PRIMARY article and CANDIDATE articles from other outlets, listed in order of preference.

Decide whether any candidate reports the SAME EVENT as the primary: the same specific incident, announcement, decision, ruling, report or development. Sharing a topic, a person or a wider running story is NOT enough, and a comment piece about a different aspect is not a match. If you are unsure, it is not a match.

Pick the FIRST candidate in the list that reports the same event. For it, write an angle note that tells a reader how that outlet's take differs from the primary's:
- at most 20 words, British spelling, neutral in tone;
- about framing and emphasis: what it leads on, whom it quotes, what it stresses or leaves out;
- do not restate the facts and do not judge either outlet;
- never use the words "primary" or "candidate": if you must refer to the first article, name its outlet;
- if only a headline is available, describe the emphasis of that headline.
Example: "Leads on the cost to taxpayers; quotes the opposition rather than the minister."

Reply with only this JSON object:
{"match_id": "<candidate id>" or null, "same_event": true or false, "angle_note": "<note, or empty string when there is no match>"}`;

function firstWords(html: string | null, n: number): string | null {
  if (!html) return null;
  const words = stripHtml(html).split(/\s+/);
  return words.length < 40 ? null : words.slice(0, n).join(' ');
}

export function matchPrompt(primary: { title: string; summary: string; sourceName?: string }, cands: Candidate[]): string {
  // The outlet line comes after the headline so the model can name the outlet instead of saying "the primary".
  const outlet = primary.sourceName ? `\nOutlet: ${primary.sourceName}` : '';
  const lines = [`PRIMARY\nHeadline: ${primary.title}${outlet}\nStandfirst: ${primary.summary || '(none)'}`, '', 'CANDIDATES'];
  cands.forEach((c, i) => {
    lines.push(`id: c${i + 1}\nOutlet: ${c.sourceName}\nHeadline: ${c.title}\nSummary: ${c.summary || '(none)'}${c.body ? `\nOpening text: ${c.body}` : ''}`);
    lines.push('');
  });
  return lines.join('\n');
}

async function logDecision(db: Db, kind: string, refId: number | null, summary: string, detail: unknown, now: number): Promise<void> {
  await db.run('INSERT INTO decision_log(at, kind, ref_id, summary, detail) VALUES(?,?,?,?,?)',
    [now, kind, refId, summary.slice(0, 300), JSON.stringify(detail)]);
}

/** Model calls in flight at once in the second-source and Right press steps. */
export const LLM_CONCURRENCY = 8;

export interface SecondSourceHooks {
  /** Called once, before any check, with the primary articles about to be checked. */
  checking?: (articleIds: number[]) => Promise<void>;
  /** Called after each primary article's check, whatever the outcome. */
  checked?: (articleId: number) => Promise<void>;
}

export async function stepSecondSources(d: StepDeps, hooks: SecondSourceHooks = {}): Promise<string> {
  const now = d.now();
  const s = d.settings;
  // Top 60 unseen primary articles by feed score that still need a (re)check.
  const prim = await d.db.all<any>(
    `SELECT a.id, a.title, a.summary, a.embedding, a.published_at, a.fetched_at, a.score_a, a.score_s, a.score_i,
            src.lean, src.name source_name, ss.other_article_id ss_other, ss.method ss_method, (ss.primary_article_id IS NOT NULL) has_row
     FROM article a JOIN source src ON src.id = a.source_id AND src.role = 'primary' AND src.enabled = 1
     LEFT JOIN impression i ON i.article_id = a.id
     LEFT JOIN second_source ss ON ss.primary_article_id = a.id
     WHERE i.article_id IS NULL AND a.embedding IS NOT NULL AND a.published_at > ?`,
    [now - 4 * DAY],
  );
  const top = prim
    .map((p) => ({ ...p, score: finalScore({ a: p.score_a, s: p.score_s, i: p.score_i, publishedAt: p.published_at }, s, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
    .filter((p) => {
      if (p.ss_other != null && p.ss_method === 'llm') return false; // confirmed: never re-query
      if (p.has_row && p.ss_other == null && now - p.fetched_at > 24 * HOUR) return false; // recheck window over
      return true;
    });
  if (!top.length) return 'nothing to check';

  const pers = await d.db.all<any>(
    `SELECT a.id, a.source_id, a.title, a.summary, a.embedding, a.published_at, a.body_html, src.name, src.lean, src.paywalled
     FROM article a JOIN source src ON src.id = a.source_id AND src.role = 'perspective' AND src.enabled = 1
     LEFT JOIN impression i ON i.article_id = a.id
     WHERE i.article_id IS NULL AND a.embedding IS NOT NULL AND a.published_at > ? AND a.published_at < ?`,
    [Math.min(...top.map((p) => p.published_at)) - 48 * HOUR, Math.max(...top.map((p) => p.published_at)) + 48 * HOUR],
  );
  const persVecs = pers.map((p) => blobToVec(p.embedding));
  const capped = await overBudget(d.db, s, now);
  let matched = 0;
  let none = 0;
  let calls = 0;
  let fallback = 0;
  let budgetHit = capped;
  await hooks.checking?.(top.map((p) => p.id));

  const checkOne = async (p: any) => {
    const pv = blobToVec(p.embedding);
    if (!pv) return;
    const checked = new Set(
      (await d.db.all<{ other_article_id: number }>('SELECT other_article_id FROM match_pair WHERE primary_article_id = ?', [p.id]))
        .map((r) => r.other_article_id),
    );
    const cands: Candidate[] = [];
    for (let i = 0; i < pers.length; i++) {
      const c = pers[i];
      const v = persVecs[i];
      if (!v || v.length !== pv.length) continue;
      if (Math.abs(c.published_at - p.published_at) > 48 * HOUR) continue;
      const sim = dot(pv, v);
      if (sim < s.matchThreshold) continue;
      cands.push({
        id: c.id, sourceId: c.source_id, sourceName: c.name, lean: c.lean, title: c.title, summary: c.summary,
        body: c.paywalled ? null : firstWords(c.body_html, 600), similarity: sim,
      });
    }
    const top5 = cands.sort((a, b) => b.similarity - a.similarity).slice(0, 5);

    if (budgetHit) {
      // At the cap: best match above the stricter threshold, with no angle note.
      const best = top5[0];
      if (best && best.similarity >= s.capMatchThreshold && p.ss_other == null) {
        await upsertSecond(d.db, p.id, best.id, null, best.similarity, 'similarity', now);
        fallback++;
      }
      return;
    }
    const fresh = top5.filter((c) => !checked.has(c.id));
    if (!fresh.length) {
      if (!p.has_row) await upsertSecond(d.db, p.id, null, null, null, 'none', now);
      none++;
      return;
    }
    const ordered = orderCandidates(fresh, p.lean, s.secondSourcePreference);
    const ids = ordered.map((_, i) => `c${i + 1}`);
    try {
      calls++;
      const res = await chatJson<MatchAnswer>(d.llm, {
        purpose: 'second_source',
        system: MATCH_SYSTEM,
        user: matchPrompt({ title: p.title, summary: p.summary, sourceName: p.source_name }, ordered),
        validate: (v) => validateMatch(v, ids),
        maxTokens: 200,
      });
      const detail = {
        primary: p.title,
        candidates: ordered.map((c, i) => ({ id: ids[i], articleId: c.id, outlet: c.sourceName, title: c.title, similarity: +c.similarity.toFixed(3) })),
        llm: safeJson<unknown>(res.raw, res.raw),
        error: res.error,
      };
      if (!res.value) {
        await logDecision(d.db, 'match', p.id, `Skipped (${res.error}): ${p.title}`, detail, now);
        return;
      }
      const idx = res.value.same_event ? ids.indexOf(res.value.match_id!) : -1;
      await d.db.tx(async () => {
        for (let i = 0; i < ordered.length; i++) {
          // Candidates listed after the chosen one were not ruled out, so they are not recorded.
          if (idx >= 0 && i > idx) break;
          await d.db.run(
            'INSERT OR REPLACE INTO match_pair(primary_article_id, other_article_id, similarity, same_event, checked_at) VALUES(?,?,?,?,?)',
            [p.id, ordered[i].id, ordered[i].similarity, i === idx ? 1 : 0, now],
          );
        }
      });
      if (idx >= 0) {
        const c = ordered[idx];
        await upsertSecond(d.db, p.id, c.id, truncateWords(res.value.angle_note, 20), c.similarity, 'llm', now);
        await logDecision(d.db, 'match', p.id, `Match: ${p.title} ↔ ${c.sourceName} (${c.similarity.toFixed(2)})`, detail, now);
        matched++;
      } else {
        if (p.ss_other == null) await upsertSecond(d.db, p.id, null, null, null, 'none', now);
        await logDecision(d.db, 'match', p.id, `No match: ${p.title} (${ordered.length} candidates)`, detail, now);
        none++;
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        budgetHit = true;
        return;
      }
      await logDecision(d.db, 'match', p.id, `Error: ${p.title}`, { error: errMsg(e, [d.llm.apiKey]) }, now);
    }
  };
  await mapLimit(top, LLM_CONCURRENCY, async (p) => {
    try {
      await checkOne(p);
    } finally {
      await hooks.checked?.(p.id).catch(() => {});
    }
  });
  return `${top.length} checked: ${matched} matched, ${none} without a match, ${calls} LLM calls` +
    (budgetHit ? `, budget reached (${fallback} similarity-only matches)` : '');
}

async function upsertSecond(
  db: Db, primaryId: number, otherId: number | null, note: string | null, sim: number | null, method: string, now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO second_source(primary_article_id, other_article_id, angle_note, similarity, method, checked_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(primary_article_id) DO UPDATE SET other_article_id = excluded.other_article_id,
       angle_note = excluded.angle_note, similarity = excluded.similarity, method = excluded.method, checked_at = excluded.checked_at`,
    [primaryId, otherId, note, sim, method, now],
  );
}

// ---------------------------------------------------------------- 6: Right press digest

export interface DigestAnswer {
  covered_by_primary: boolean;
  summary: string;
}

export function validateDigest(v: unknown): DigestAnswer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as any;
  if (typeof o.covered_by_primary !== 'boolean' || typeof o.summary !== 'string') return null;
  const summary = o.summary.trim();
  if (!o.covered_by_primary && (!summary || countWords(summary) > 45)) return null;
  return { covered_by_primary: o.covered_by_primary, summary };
}

const DIGEST_SYSTEM = `You write a neutral news digest. You are given headlines and summaries from several outlets that are all reporting one story. You may also be given headlines from a PRIMARY outlet.

1. If PRIMARY headlines are given, decide whether any of them reports the same specific story (the same incident, announcement or development, not merely the same topic). Set covered_by_primary accordingly. With no PRIMARY headlines it is false.
2. Write one sentence, at most 35 words, in British spelling, saying what is being reported. Attribute claims ("is reported to", "according to") where the facts are contested. Do not say whether it is true or important, and do not adopt loaded wording from the headlines.

Reply with only this JSON object:
{"covered_by_primary": true or false, "summary": "<one sentence>"}`;

export const MAX_NEW_DIGEST = 15;

export async function stepDigest(d: StepDeps): Promise<string> {
  const now = d.now();
  const s = d.settings;
  const clusters = await d.db.all<any>(
    `SELECT id, centroid, right_outlet_count, last_article_at, digest_status, digest_summary, digest_checked
     FROM cluster
     WHERE created_at > ? AND has_primary = 0 AND right_outlet_count >= 2 AND last_article_at > ?
       AND (digest_status IS NULL OR digest_status = 'qualified')
     ORDER BY right_outlet_count DESC, last_article_at DESC`,
    [now - 5 * DAY, now - 36 * HOUR],
  );
  if (!clusters.length) return 'no candidate stories';
  const prim = await d.db.all<any>(
    `SELECT a.id, a.title, a.embedding FROM article a
     JOIN source src ON src.id = a.source_id AND src.role = 'primary' AND src.enabled = 1
     WHERE a.embedding IS NOT NULL AND a.published_at > ?`,
    [now - CLUSTER_WINDOW],
  );
  const primVecs = prim.map((p) => blobToVec(p.embedding));
  let budgetHit = await overBudget(d.db, s, now);
  let added = 0;
  let covered = 0;
  let calls = 0;

  interface Job {
    cluster: any;
    grey: { id: number; title: string; sim: number }[];
    cleared: Set<number>;
    nearest: number;
    isNew: boolean;
    needsSummary: boolean;
  }
  const jobs: Job[] = [];
  let newPlanned = 0;

  // First pass, no model: rule out covered stories and decide which ones need a call.
  for (const c of clusters) {
    const cv = blobToVec(c.centroid);
    if (!cv) continue;
    const unit = normalize(cv);
    const cleared = new Set(safeJson<number[]>(c.digest_checked, []));
    let nearest = -1;
    const grey: { id: number; title: string; sim: number }[] = [];
    for (let i = 0; i < prim.length; i++) {
      const v = primVecs[i];
      if (!v || v.length !== unit.length) continue;
      const sim = dot(unit, v);
      if (sim > nearest) nearest = sim;
      if (sim >= s.digestGreyLow && sim < s.digestCoveredThreshold && !cleared.has(prim[i].id)) {
        grey.push({ id: prim[i].id, title: prim[i].title, sim });
      }
    }
    if (nearest >= s.digestCoveredThreshold) {
      await d.db.run("UPDATE cluster SET digest_status = 'covered', digest_at = ? WHERE id = ?", [now, c.id]);
      await logDecision(d.db, 'digest', c.id, `Covered by a primary article (${nearest.toFixed(2)})`, { nearest }, now);
      covered++;
      continue;
    }
    const isNew = c.digest_status == null;
    const needsSummary = !c.digest_summary;
    if (!grey.length && !needsSummary) continue; // qualified, summarised, nothing new to check
    // At most 15 new stories per refresh; the rest wait for the next one.
    if (isNew && newPlanned >= MAX_NEW_DIGEST) continue;
    if (isNew) newPlanned++;

    if (budgetHit) {
      // At the cap the digest shows headlines; a grey-zone story cannot be checked, so it waits.
      if (isNew && !grey.length) {
        await d.db.run("UPDATE cluster SET digest_status = 'qualified', digest_at = ? WHERE id = ?", [now, c.id]);
        added++;
      }
      continue;
    }
    grey.sort((a, b) => b.sim - a.sim);
    jobs.push({ cluster: c, grey, cleared, nearest, isNew, needsSummary });
  }

  // Second pass: one model call per story, a few at a time.
  await mapLimit(jobs, LLM_CONCURRENCY, async (job) => {
    if (budgetHit) return;
    const c = job.cluster;
    const members = await d.db.all<any>(
      `SELECT a.title, a.summary, src.name FROM article a JOIN source src ON src.id = a.source_id
       WHERE a.cluster_id = ? AND src.role = 'perspective' AND src.enabled = 1 ORDER BY a.published_at DESC LIMIT 8`,
      [c.id],
    );
    const greyTop = job.grey.slice(0, 3);
    const user =
      'STORY COVERAGE\n' +
      members.map((m) => `- ${m.name}: ${m.title}${m.summary ? ` — ${m.summary.slice(0, 300)}` : ''}`).join('\n') +
      (greyTop.length ? '\n\nPRIMARY headlines\n' + greyTop.map((g) => `- ${g.title}`).join('\n') : '');
    try {
      calls++;
      const res = await chatJson<DigestAnswer>(d.llm, {
        purpose: 'digest', system: DIGEST_SYSTEM, user, validate: validateDigest, maxTokens: 200,
      });
      const detail = {
        headlines: members.map((m) => `${m.name}: ${m.title}`),
        primaryChecked: greyTop.map((g) => ({ title: g.title, similarity: +g.sim.toFixed(3) })),
        nearestPrimary: +job.nearest.toFixed(3),
        llm: safeJson<unknown>(res.raw, res.raw),
        error: res.error,
      };
      if (!res.value) {
        await logDecision(d.db, 'digest', c.id, `Skipped (${res.error}): ${members[0]?.title ?? ''}`, detail, now);
        return;
      }
      if (res.value.covered_by_primary) {
        await d.db.run("UPDATE cluster SET digest_status = 'covered', digest_at = ? WHERE id = ?", [now, c.id]);
        await logDecision(d.db, 'digest', c.id, `Covered (LLM): ${members[0]?.title ?? ''}`, detail, now);
        covered++;
        return;
      }
      const cleared = Array.from(new Set([...job.cleared, ...job.grey.map((g) => g.id)])).slice(-200);
      await d.db.run(
        "UPDATE cluster SET digest_status = 'qualified', digest_summary = COALESCE(?, digest_summary), digest_checked = ?, digest_at = COALESCE(digest_at, ?) WHERE id = ?",
        [job.needsSummary ? res.value.summary : null, JSON.stringify(cleared), now, c.id],
      );
      await logDecision(d.db, 'digest', c.id, `Qualified (${c.right_outlet_count} outlets): ${res.value.summary}`, detail, now);
      if (job.isNew) added++;
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        budgetHit = true;
        return;
      }
      await logDecision(d.db, 'digest', c.id, 'Error', { error: errMsg(e, [d.llm.apiKey]) }, now);
    }
  });
  return `${clusters.length} candidate stories: ${added} added, ${covered} already covered, ${calls} LLM calls` +
    (budgetHit ? ', budget reached (headlines only)' : '');
}

// ---------------------------------------------------------------- retention

export async function stepRetention(d: StepDeps, removeFiles?: (articleIds: number[]) => Promise<void>): Promise<string> {
  const now = d.now();
  const cutoff = now - 14 * DAY;
  const old = await d.db.all<{ id: number }>(
    `SELECT a.id FROM article a
     LEFT JOIN impression i ON i.article_id = a.id
     WHERE a.published_at < ? AND a.fetched_at < ?
       AND (i.article_id IS NULL OR i.first_seen_at < ?)
       AND a.id NOT IN (SELECT article_id FROM read_later WHERE done_at IS NULL OR done_at > ?)`,
    [cutoff, cutoff, cutoff, cutoff],
  );
  const ids = old.map((r) => r.id);
  await d.db.tx(async () => {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500).join(',');
      await d.db.exec(`
        DELETE FROM article WHERE id IN (${chunk});
        DELETE FROM impression WHERE article_id IN (${chunk});
        DELETE FROM read_later WHERE article_id IN (${chunk});
        DELETE FROM second_source WHERE primary_article_id IN (${chunk}) OR other_article_id IN (${chunk});
        DELETE FROM match_pair WHERE primary_article_id IN (${chunk}) OR other_article_id IN (${chunk});
      `);
    }
    await d.db.run('DELETE FROM cluster WHERE created_at < ? AND id NOT IN (SELECT cluster_id FROM article WHERE cluster_id IS NOT NULL)', [cutoff]);
    await d.db.run('DELETE FROM decision_log WHERE at < ?', [cutoff]);
    await d.db.run('DELETE FROM refresh_run WHERE id NOT IN (SELECT id FROM refresh_run ORDER BY id DESC LIMIT 60)');
  });
  if (ids.length && removeFiles) await removeFiles(ids).catch(() => {});
  return `${ids.length} old articles removed`;
}
