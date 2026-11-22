import { finalScore, scoreArticles } from '../core/ranking';
import { loadSettings, saveSettings } from '../core/settings';
import type { Secrets } from '../core/sources';
import type { FetchFn, StepResult } from '../core/types';
import { errMsg, mapLimit, safeJson } from '../core/util';
import type { Db } from '../db/db';
import { ensureBody, type Files } from '../reader/body';
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
  /** Lets a background task stop early when the system is about to end it. */
  shouldStop?: () => boolean;
}

export interface RefreshResult {
  runId: number;
  steps: StepResult[];
  newArticles: number;
  skipped?: boolean;
}

export const OPENROUTER_KEY_REF = 'openrouter_api_key';
export const PREFETCH_COUNT = 30;

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
     FROM article a JOIN source s ON s.id = a.source_id AND s.role = 'primary' AND s.enabled = 1
     LEFT JOIN impression i ON i.article_id = a.id
     WHERE i.article_id IS NULL AND NOT (s.paywalled = 1 OR s.reader_mode = 'browser')`,
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    return r.info;
  });
  await step('3 Embed', () => stepEmbed(d));
  await step('4 Cluster', () => stepCluster(d));
  await step('5 Second sources', async () => {
    await scoreArticles(db, deps.now());
    return stepSecondSources(d);
  });
  await step('6 Right press', () => stepDigest(d));
  await step('7 Score', async () => {
    try {
      return `${await scoreArticles(db, deps.now())} articles scored`;
    } finally {
      // New articles enter the feed only now, matched and ranked. Shown any earlier, a card would
      // be seen before its second source had been looked for, and so never get one.
      await db.run('UPDATE article SET ready_at = ? WHERE ready_at IS NULL', [deps.now()]);
    }
  });
  await step('8 Prefetch', () => prefetch(deps, d));
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
