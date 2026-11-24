import { useSyncExternalStore } from 'react';
import type { Mode } from '../core/modes';
import { DEFAULT_SETTINGS, type Settings } from '../core/settings';

/** When this JavaScript context started, for the launch-time figure in Debug. */
export const APP_START = Date.now();

export interface Snack {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface AppState {
  ready: boolean;
  initError: string | null;
  settings: Settings;
  sessionId: string;
  /** Bumped whenever the session changes (new session: only unseen articles). */
  sessionVersion: number;
  /** Bumped whenever stored data changed and lists should reload. */
  dataVersion: number;
  refreshing: boolean;
  refreshStep: string | null;
  lastRefreshAt: number;
  overBudget: boolean;
  monthSpend: number;
  snack: Snack | null;
  /** Milliseconds from JavaScript start to the cached feed being on screen. */
  feedReadyMs: number | null;
  /** The modes, in mode-bar order. */
  modes: Mode[];
  /** Unseen cards per mode id, for the mode bar. */
  modeCounts: Record<number, number>;
}

let state: AppState = {
  ready: false,
  initError: null,
  settings: DEFAULT_SETTINGS,
  sessionId: '',
  sessionVersion: 0,
  dataVersion: 0,
  refreshing: false,
  refreshStep: null,
  lastRefreshAt: 0,
  overBudget: false,
  monthSpend: 0,
  snack: null,
  feedReadyMs: null,
  modes: [],
  modeCounts: {},
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function bumpData(): void {
  setState({ dataVersion: state.dataVersion + 1 });
}

let snackId = 0;
let snackTimer: ReturnType<typeof setTimeout> | null = null;

export function showSnack(text: string, actionLabel?: string, onAction?: () => void, ms = 5000): void {
  if (snackTimer) clearTimeout(snackTimer);
  const id = ++snackId;
  setState({ snack: { id, text, actionLabel, onAction } });
  snackTimer = setTimeout(() => {
    if (state.snack?.id === id) setState({ snack: null });
  }, ms);
}

export function hideSnack(): void {
  if (snackTimer) clearTimeout(snackTimer);
  setState({ snack: null });
}
