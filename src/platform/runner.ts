import { Image } from 'expo-image';
import * as Network from 'expo-network';
import { ensureSession, noteBackground } from '../core/feed';
import { loadSettings, saveSettings, type Settings } from '../core/settings';
import { errMsg } from '../core/util';
import { monthSpend } from '../llm/openrouter';
import { refresh, type RefreshDeps, type RefreshResult, type Trigger } from '../pipeline/refresh';
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

const STEP_LABELS = [
  'Reading headlines', 'Grouping stories', 'Finding second sources', 'Building Right press', 'Ranking',
  'Saving articles for offline', 'Tidying up', 'Done',
];

/**
 * Runs a refresh. `onReady` is called once new articles are matched, ranked and in the feed (the
 * prefetch and tidy-up steps carry on after it); without it the lists simply reload at that point.
 */
export async function runRefresh(
  trigger: Trigger, shouldStop?: () => boolean, onReady?: () => void,
): Promise<RefreshResult | null> {
  const db = await getDb();
  if (trigger !== 'background') setState({ refreshing: true, refreshStep: 'Fetching sources' });
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
      setState({ refreshStep: STEP_LABELS[index] ?? null });
      // New articles join the feed once they are matched and ranked (after the Score step).
      if (step.name.startsWith('7')) {
        if (onReady) onReady();
        else bumpData();
      }
    },
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
  if (Date.now() - settings.lastRefreshAt < 2 * 60_000) return;
  runRefresh('open').catch(() => {});
}
