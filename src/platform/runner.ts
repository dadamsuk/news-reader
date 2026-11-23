import { Image } from 'expo-image';
import * as Network from 'expo-network';
import { ensureSession, noteBackground } from '../core/feed';
import { loadSettings, saveSettings, type Settings } from '../core/settings';
import { errMsg } from '../core/util';
import { monthSpend } from '../llm/openrouter';
import type { LlmDeps } from '../llm/openrouter';
import { stepBriefing } from '../pipeline/extras';
import { OPENROUTER_KEY_REF, SCORE_STEP, refresh, type RefreshDeps, type RefreshResult, type Trigger } from '../pipeline/refresh';
import type { BodyDeps } from '../reader/body';
import { bumpData, getState, setState } from '../state/store';
import { getDb } from './db';
import { appFetch } from './fetch';
import { files } from './files';
import { secrets } from './secrets';

async function isWifi(): Promise<boolean> {
  try {
    const s = await Network.getNetworkStateAsync();
    return s.type === Network.NetworkStateType.WIFI || s.type === Network.NetworkStateType.ETHERNET;
  } catch {
    return false;
  }
}

export async function bodyDeps(): Promise<BodyDeps> {
  return { db: await getDb(), fetch: appFetch, secrets, now: () => Date.now(), files };
}

async function syncBudget(settings: Settings): Promise<void> {
  const db = await getDb();
  const spend = await monthSpend(db, Date.now());
  setState({ monthSpend: spend, overBudget: spend >= settings.monthlyBudgetUsd });
}

/** Reloads settings into the store (after any Settings change). */
export async function reloadSettings(): Promise<Settings> {
  const db = await getDb();
  const settings = await loadSettings(db);
  setState({ settings, lastRefreshAt: settings.lastRefreshAt });
  await syncBudget(settings);
  return settings;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const db = await getDb();
  await saveSettings(db, patch);
  await reloadSettings();
}

let setUpAtLaunch = false;

/** True when this launch found setup already done, so the cached feed was the first screen. */
export function launchedIntoFeed(): boolean {
  return setUpAtLaunch;
}

/** Opens the database and the session. Called once at launch, before anything is drawn. */
export async function initApp(): Promise<void> {
  try {
    const db = await getDb();
    const { sessionId } = await ensureSession(db, Date.now());
    const settings = await loadSettings(db);
    setUpAtLaunch = settings.setupDone;
    setState({ ready: true, initError: null, settings, sessionId, lastRefreshAt: settings.lastRefreshAt });
    syncBudget(settings).catch(() => {});
  } catch (e) {
    setState({ initError: errMsg(e) });
  }
}

/** Starts a new session when due (pull-to-refresh, or 10 minutes in the background). */
export async function startSession(forceNew: boolean): Promise<void> {
  const db = await getDb();
  const { sessionId, isNew } = await ensureSession(db, Date.now(), forceNew);
  if (isNew || sessionId !== getState().sessionId) {
    setState({ sessionId, sessionVersion: getState().sessionVersion + 1 });
  }
}

export async function appWentBackground(): Promise<void> {
  const db = await getDb();
  await noteBackground(db, Date.now());
}

// What runs next, shown after each step finishes.
const STEP_LABELS = [
  'Reading headlines', 'Grouping stories', 'Finding second sources', 'Ranking', 'Building Right press',
  'Updating followed stories', 'Writing your briefing', 'Saving articles for offline', 'Tidying up', 'Done',
];

/** For model calls made from a screen (comparing coverage), outside a refresh. */
export async function llmDeps(): Promise<LlmDeps> {
  const db = await getDb();
  const apiKey = await secrets.get(OPENROUTER_KEY_REF).catch(() => null);
  return { db, fetch: appFetch, settings: getState().settings, apiKey, now: () => Date.now() };
}

let bumpTimer: ReturnType<typeof setTimeout> | null = null;
function throttledBump(): void {
  if (bumpTimer) return;
  bumpData();
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    bumpData();
  }, 1500);
}

/**
 * Runs a refresh. `onReady` is called once new articles are matched, ranked and in the feed (the
 * prefetch and tidy-up steps carry on after it); without it the lists simply reload at that point.
 */
export async function runRefresh(
  trigger: Trigger, shouldStop?: () => boolean, onReady?: () => void,
): Promise<RefreshResult | null> {
  const db = await getDb();
  if (trigger !== 'background') setState({ refreshing: true, refreshStep: 'Fetching sources' });
  let cardsIn = false;
  const deps: RefreshDeps = {
    db,
    fetch: appFetch,
    secrets,
    now: () => Date.now(),
    files,
    isWifi,
    shouldStop,
    prefetchThumbs: async (urls) => {
      if (urls.length) await Image.prefetch(urls, 'disk');
    },
    onStep: (step, index) => {
      if (cardsIn) return;
      setState({ refreshStep: STEP_LABELS[index] ?? null });
      // Every new article is in the feed after the Score step.
      if (step.name === SCORE_STEP) {
        cardsIn = true;
        if (onReady) onReady();
        else bumpData();
        // Right press, followed stories and the offline copies carry on quietly: the header stops
        // saying "Refreshing" now, not when they finish.
        setState({ refreshing: false, refreshStep: null });
      }
    },
    // Articles stream into the feeds during the run; reload the lists at most every 1.5 seconds.
    // Not for pull-to-refresh (onReady): that starts a new session at the end, and cards seen in
    // the old one meanwhile would be gone from the new one.
    onArticlesReady: onReady ? undefined : throttledBump,
  };
  try {
    return await refresh(deps, trigger);
  } catch {
    return null;
  } finally {
    const settings = await reloadSettings().catch(() => getState().settings);
    setState({ refreshing: false, refreshStep: null, lastRefreshAt: settings.lastRefreshAt });
    bumpData();
  }
}

/** Refresh on open: the cached feed is already on screen; this brings it up to date. */
export function refreshOnOpen(): void {
  const { settings, refreshing } = getState();
  if (refreshing || !settings.setupDone) return;
  if (Date.now() - settings.lastRefreshAt < 2 * 60_000) {
    // Just refreshed (in the background, say): no need to fetch again, but a catch-up briefing
    // may still be due for this return to the app.
    briefingOnly().catch(() => {});
    return;
  }
  runRefresh('open').catch(() => {});
}

async function briefingOnly(): Promise<void> {
  const db = await getDb();
  const settings = await loadSettings(db);
  if (!settings.briefingSince) return;
  const llm = { ...(await llmDeps()), settings };
  const info = await stepBriefing({ db, fetch: appFetch, secrets, settings, now: () => Date.now(), llm });
  if (info !== 'not due') {
    await syncBudget(settings);
    bumpData();
  }
}
