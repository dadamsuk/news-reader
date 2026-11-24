import { listModes } from '../core/modes';
import { finalScore, scoreArticles } from '../core/ranking';
import { loadSettings, saveSettings } from '../core/settings';
import type { Secrets } from '../core/sources';
import { HOUR, NEWS_MODE_ID, type FetchFn, type StepResult } from '../core/types';
import { errMsg, mapLimit, safeJson } from '../core/util';
import type { Db } from '../db/db';
import { ensureBody, type Files } from '../reader/body';
import { stepBriefing, stepStories } from './extras';
import { runSectionsMode } from './sections';
import {
  stepCluster, stepDigest, stepEmbed, stepFetch, stepRetention, stepSecondSources, type StepDeps,
} from './steps';

export type Trigger = 'open' | 'manual' | 'background' | 'setup' | 'test';

export interface RefreshDeps {
  db: Db;
  fetch: FetchFn;
  secrets: Secrets;
  now: () => number;
  files: Files | null;
  isWifi: () => Promise<boolean>;
  prefetchThumbs?: (urls: string[]) => Promise<void>;
  /** Called after each step, so the UI can show the feed as soon as articles exist. */
  onStep?: (step: StepResult, index: number) => void;
  /** Called whenever more new articles have entered the feeds (they arrive in batches during a run). */
  onArticlesReady?: () => void;
  /** Lets a background task stop early when the system is about to end it. */
  shouldStop?: () => boolean;
  /**
   * Gives the UI thread a turn between prefetched articles. Left out in a background task: there
   * is no UI, and on Android JavaScript timers do not fire in the background at all.
   */
  yieldUi?: () => Promise<void>;
}

export interface RefreshResult {
  runId: number;
  steps: StepResult[];
  newArticles: number;
  skipped?: boolean;
}

export const OPENROUTER_KEY_REF = 'openrouter_api_key';
export const PREFETCH_COUNT = 30;
/** The step after which every new article of the run is in the feeds. */
export const SCORE_STEP = '6 Score';

let inFlight: Promise<RefreshResult> | null = null;

/** Runs the refresh pipeline. Only one runs at a time; a second caller gets the run in progress. */
export function refresh(deps: RefreshDeps, trigger: Trigger): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = run(deps, trigger).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function isRefreshing(): boolean {
  return inFlight != null;
}

async function prefetch(deps: RefreshDeps, d: StepDeps): Promise<string> {
  const now = d.now();
  if (d.settings.wifiOnlyPrefetch && !(await deps.isWifi())) return 'skipped: not on Wi-Fi';
  const rows = await d.db.all<any>(
    `SELECT a.id, a.image_url, a.published_at, a.score_a, a.score_s, a.score_i, a.body_html, a.body_tried_at, a.offline_images
     FROM article a JOIN source s ON s.id = a.source_id AND s.role = 'primary' AND s.enabled = 1 AND s.mode_id = ?
     LEFT JOIN impression i ON i.article_id = a.id
     WHERE i.article_id IS NULL AND NOT (s.paywalled = 1 OR s.reader_mode = 'browser')`,
    [NEWS_MODE_ID],
  );
  const top = rows
    .map((r) => ({ ...r, score: finalScore({ a: r.score_a, s: r.score_s, i: r.score_i, publishedAt: r.published_at }, d.settings, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PREFETCH_COUNT);
  const later = await d.db.all<any>(
    `SELECT a.id, a.image_url, a.body_html, a.body_tried_at, a.offline_images FROM read_later rl JOIN article a ON a.id = rl.article_id
     WHERE rl.done_at IS NULL`,
  );
  const seen = new Set<number>();
  const todo = [...later, ...top].filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    if (r.body_html && r.offline_images) return false;
    // A failed fetch is not retried for six hours.
    if (!r.body_html && r.body_tried_at && now - r.body_tried_at < 6 * 3600_000) return false;
    return true;
  });
  let ok = 0;
  await mapLimit(todo, 3, async (r) => {
    if (deps.shouldStop?.()) return;
    try {
      const res = await ensureBody({ db: d.db, fetch: d.fetch, secrets: d.secrets, now: d.now, files: deps.files }, r.id, { withImages: true });
      if (res.status === 'ok') ok++;
    } catch {
      // one bad article never stops the rest
    }
    // Give the UI thread a turn between articles.
    if (deps.yieldUi) await deps.yieldUi();
  });
  if (deps.prefetchThumbs) {
    const thumbs = top.map((r) => r.image_url).filter(Boolean) as string[];
    await deps.prefetchThumbs(thumbs).catch(() => {});
  }
  return `${ok} of ${todo.length} bodies fetched (${top.length} top items, ${later.length} saved)`;
}

async function run(deps: RefreshDeps, trigger: Trigger): Promise<RefreshResult> {
  const { db } = deps;
  const settings = await loadSettings(db);
  const startedAt = deps.now();
  if (!settings.learningStartedAt) {
    settings.learningStartedAt = startedAt;
    await saveSettings(db, { learningStartedAt: startedAt });
  }
  const apiKey = await deps.secrets.get(OPENROUTER_KEY_REF).catch(() => null);
  const d: StepDeps = {
    db, fetch: deps.fetch, secrets: deps.secrets, settings, now: deps.now,
    llm: { db, fetch: deps.fetch, settings, apiKey, now: deps.now },
  };
  const ins = await db.run('INSERT INTO refresh_run(started_at, trigger) VALUES(?, ?)', [startedAt, trigger]);
  const runId = ins.lastInsertRowId;
  const steps: StepResult[] = [];
  let newArticles = 0;
  let sourcesFetched = 0;

  // A failed step is logged and skipped. It never blocks the steps after it.
  const step = async (name: string, fn: () => Promise<string>) => {
    if (deps.shouldStop?.()) {
      steps.push({ name, ms: 0, ok: false, error: 'stopped: out of background time' });
      return;
    }
    const t0 = Date.now();
    let res: StepResult;
    try {
      const info = await fn();
      res = { name, ms: Date.now() - t0, ok: true, info };
    } catch (e) {
      res = { name, ms: Date.now() - t0, ok: false, error: errMsg(e, [apiKey]) };
    }
    steps.push(res);
    await db.run('UPDATE refresh_run SET steps = ?, new_articles = ? WHERE id = ?', [JSON.stringify(steps), newArticles, runId]).catch(() => {});
    try {
      deps.onStep?.(res, steps.length - 1);
    } catch {}
  };

  await step('1-2 Fetch and de-duplicate', async () => {
    const r = await stepFetch(d, trigger === 'manual' || trigger === 'setup' || trigger === 'test');
    newArticles = r.added;
    sourcesFetched = r.fetched;
    return r.info;
  });
  await step('3 Embed', () => stepEmbed(d));
  await step('4 Cluster', () => stepCluster(d));
  // New articles enter the feeds as soon as they can be shown properly, not all at the end:
  // - those not due a second-source check this run straight away (they will not get one now);
  // - each article being checked the moment its own check is done, so no card is ever seen before
  //   its second source was looked for (seen cards never come back to show one later).
  const markReady = async (ids: number[] | null) => {
    const at = deps.now();
    const r = ids == null
      ? await db.run('UPDATE article SET ready_at = ? WHERE ready_at IS NULL AND mode_id = ?', [at, NEWS_MODE_ID])
      : ids.length
        ? await db.run(`UPDATE article SET ready_at = ? WHERE ready_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [at, ...ids])
        : { changes: 0 };
    if (r.changes > 0) {
      try {
        deps.onArticlesReady?.();
      } catch {}
    }
  };
  // An automatic refresh (on opening, or in the background) with no source due yet has nothing new
  // to work on: running the model steps again would only repeat the last refresh's work and cost.
  // Anything left over is picked up by the next refresh that fetches. Pull-to-refresh, setup and a
  // refresh after a settings change always run every step.
  const idle = sourcesFetched === 0 && (trigger === 'open' || trigger === 'background');
  const NOTHING_NEW = 'skipped: no source due yet';
  await step('5 Second sources', async () => {
    if (idle) return NOTHING_NEW;
    await scoreArticles(db, deps.now());
    return stepSecondSources(d, {
      checking: async (ids) => {
        const holding = new Set(ids);
        const rows = await db.all<{ id: number }>('SELECT id FROM article WHERE ready_at IS NULL AND mode_id = ?', [NEWS_MODE_ID]);
        await markReady(rows.map((r) => r.id).filter((id) => !holding.has(id)));
      },
      checked: (id) => markReady([id]),
    });
  });
  await step(SCORE_STEP, async () => {
    try {
      return `${await scoreArticles(db, deps.now())} articles scored`;
    } finally {
      // Anything still held (a step failed or was skipped) goes in now.
      await markReady(null);
    }
  });
  // Right press does not touch For you, so it runs after the new cards are already showing.
  await step('7 Right press', async () => (idle ? NOTHING_NEW : stepDigest(d)));
  await step('7b Followed stories', async () => (idle ? NOTHING_NEW : stepStories(d)));
  await step('7c Briefing', async () => {
    // In the background, away long enough for a briefing: write it now, ready for the return.
    const awaySince = Math.max(settings.lastBackgroundAt, settings.lastActiveAt);
    const awayLongEnough = trigger === 'background' && settings.lastBackgroundAt > 0
      && deps.now() - awaySince >= settings.briefingGapHours * HOUR;
    const info = await stepBriefing(d, awayLongEnough ? awaySince : 0);
    if (info !== 'not due') {
      try {
        deps.onArticlesReady?.();
      } catch {}
    }
    return info;
  });
  await step('8 Prefetch', () => prefetch(deps, d));
  // Then every other mode in turn (sections layout), each under its own named steps. A mode with no
  // enabled source has nothing to do and adds no steps.
  for (const mode of (await listModes(db)).filter((m) => m.layout.type === 'sections')) {
    const n = await db.get<{ n: number }>('SELECT COUNT(*) n FROM source WHERE mode_id = ? AND enabled = 1', [mode.id]);
    if (!n?.n) continue;
    await runSectionsMode({ ...d, shouldStop: deps.shouldStop }, mode, trigger === 'manual' || trigger === 'setup' || trigger === 'test', step, () => {
      try {
        deps.onArticlesReady?.();
      } catch {}
    });
  }
  await step('9 Retention', () => stepRetention(d, deps.files ? (ids) => deps.files!.removeArticles(ids) : undefined));

  const finishedAt = deps.now();
  await db.run('UPDATE refresh_run SET finished_at = ?, steps = ?, new_articles = ? WHERE id = ?',
    [finishedAt, JSON.stringify(steps), newArticles, runId]);
  await saveSettings(db, { lastRefreshAt: finishedAt });
  return { runId, steps, newArticles };
}

export async function listRuns(db: Db, limit = 20) {
  const rows = await db.all<any>('SELECT * FROM refresh_run ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map((r) => ({
    id: r.id as number,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at ?? null) as number | null,
    trigger: r.trigger as string,
    steps: safeJson<StepResult[]>(r.steps, []),
    newArticles: r.new_articles as number,
  }));
}

/** The last background refresh: when it started, and whether it finished (null: none yet). */
export async function lastBackgroundRun(db: Db): Promise<{ startedAt: number; finished: boolean; newArticles: number } | null> {
  const r = await db.get<any>("SELECT started_at, finished_at, new_articles FROM refresh_run WHERE trigger = 'background' ORDER BY id DESC LIMIT 1");
  return r ? { startedAt: r.started_at, finished: r.finished_at != null, newArticles: r.new_articles ?? 0 } : null;
}
