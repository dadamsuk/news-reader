import type { Db } from '../db/db';
import { NEWS_MODE_ID } from './types';
import { safeJson } from './util';

export interface Settings {
  openrouterBaseUrl: string;
  embeddingModel: string;
  /** Requested embedding size. Longer vectors are truncated and re-normalised. 0 keeps the model's native size. */
  embeddingDimensions: number;
  chatModel: string;
  monthlyBudgetUsd: number;
  refreshMinutes: number;
  wifiOnlyPrefetch: boolean;
  textSize: number;
  /**
   * Latest first: the For you feed is the newest stories (up to 100), newest at the top, and a story
   * stays however often it has been on screen. Off: each story shows once, ranked.
   */
  chronological: boolean;
  /**
   * Unfiltered: what the app has learned does not decide what For you shows or its order; each card
   * shows instead how likely it is to suit you.
   */
  unfiltered: boolean;
  /**
   * Filtered (not unfiltered): stories whose match (5 to 95, against the other stories on offer)
   * is below this are left out of For you. 0 leaves nothing out.
   */
  filterThreshold: number;
  /** Words and names left out of Pulse, as written by him (matched ignoring case). */
  pulseHidden: string[];
  clusterThreshold: number;
  /** Second-source candidates need at least this similarity; Haiku then confirms. */
  matchThreshold: number;
  /** A primary article this close to a Right press story means it is already covered. */
  digestCoveredThreshold: number;
  /** Between this and digestCoveredThreshold, Haiku decides whether the primary covered it. */
  digestGreyLow: number;
  capMatchThreshold: number;
  /** An article this close to a followed story's starting point joins it (looser than "same event"). */
  followThreshold: number;
  /** Show a catch-up card after this many hours away. */
  briefingEnabled: boolean;
  briefingGapHours: number;
  weightA: number;
  weightS: number;
  weightF: number;
  weightI: number;
  coldStartDays: number;
  coldStartFactor: number;
  /** USD per million tokens, used when a response carries no cost figure. */
  priceChatIn: number;
  priceChatOut: number;
  priceEmbedIn: number;
  learningStartedAt: number;
  setupDone: boolean;
  sessionId: string;
  sessionStartedAt: number;
  lastBackgroundAt: number;
  lastRefreshAt: number;
  extractFailures: number;
  /** When the app was last in use (set on going to the background and on each new session). */
  lastActiveAt: number;
  /** Non-zero: a catch-up briefing is due, covering the time since this moment. */
  briefingSince: number;
  /** The mode on screen; the app opens on the last one used. */
  currentModeId: number;
}

/**
 * The settings that belong to the News mode rather than the app (PRD: "A mode definition holds"):
 * ranking weights and thresholds, the cold-start date, Latest first, Unfiltered, the filter
 * threshold and Pulse's hidden words. They are stored in the News mode's row; everything else is
 * shared and stays in `setting`. Mute and watch lists are per mode in `topic_rule`.
 */
export const NEWS_MODE_KEYS: (keyof Settings)[] = [
  'weightA', 'weightS', 'weightF', 'weightI', 'coldStartDays', 'coldStartFactor', 'learningStartedAt',
  'clusterThreshold', 'matchThreshold', 'digestCoveredThreshold', 'digestGreyLow', 'capMatchThreshold', 'followThreshold',
  'chronological', 'unfiltered', 'filterThreshold', 'pulseHidden',
];

export const DEFAULT_SETTINGS: Settings = {
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingDimensions: 512,
  chatModel: 'anthropic/claude-haiku-4.5',
  monthlyBudgetUsd: 15,
  refreshMinutes: 30,
  wifiOnlyPrefetch: true,
  textSize: 18,
  chronological: false,
  unfiltered: false,
  filterThreshold: 20,
  pulseHidden: ['UK', 'USA'],
  // Tuned on real headlines for text-embedding-3-small at 512 dimensions (see docs/decisions.md).
  clusterThreshold: 0.75,
  matchThreshold: 0.6,
  digestCoveredThreshold: 0.72,
  digestGreyLow: 0.55,
  capMatchThreshold: 0.8,
  followThreshold: 0.62,
  briefingEnabled: true,
  briefingGapHours: 8,
  weightA: 1.0,
  weightS: 1.5,
  weightF: 1.0,
  weightI: 0.5,
  coldStartDays: 14,
  coldStartFactor: 0.3,
  priceChatIn: 1,
  priceChatOut: 5,
  priceEmbedIn: 0.02,
  learningStartedAt: 0,
  setupDone: false,
  sessionId: '',
  sessionStartedAt: 0,
  lastBackgroundAt: 0,
  lastRefreshAt: 0,
  extractFailures: 0,
  lastActiveAt: 0,
  briefingSince: 0,
  currentModeId: NEWS_MODE_ID,
};

const isNewsKey = (k: string) => (NEWS_MODE_KEYS as string[]).includes(k);

/** The app's settings, with the News mode's own settings in place. */
export async function loadSettings(db: Db): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM setting');
  const mode = await db.get<{ settings: string }>('SELECT settings FROM mode WHERE id = ?', [NEWS_MODE_ID]);
  const news = safeJson<Record<string, unknown>>(mode?.settings, {});
  const out: any = { ...DEFAULT_SETTINGS };
  const take = (k: string, v: unknown) => {
    const def = (DEFAULT_SETTINGS as any)[k];
    if (typeof v === typeof def && Array.isArray(v) === Array.isArray(def)) out[k] = v;
  };
  for (const r of rows) {
    // A News setting is read from the mode row once it is there (the old copy in `setting` is kept).
    if (r.key in DEFAULT_SETTINGS && !(isNewsKey(r.key) && r.key in news)) take(r.key, safeJson<any>(r.value, undefined));
  }
  for (const [k, v] of Object.entries(news)) if (isNewsKey(k)) take(k, v);
  return out as Settings;
}

/** Saves settings: News's own to the News mode, the rest to the shared table. */
export async function saveSettings(db: Db, patch: Partial<Settings>): Promise<void> {
  await db.tx(async () => {
    const news: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (isNewsKey(k)) {
        news[k] = v;
        continue;
      }
      await db.run(
        'INSERT INTO setting(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [k, JSON.stringify(v)],
      );
    }
    if (Object.keys(news).length) {
      const mode = await db.get<{ settings: string }>('SELECT settings FROM mode WHERE id = ?', [NEWS_MODE_ID]);
      const cur = { ...safeJson<Record<string, unknown>>(mode?.settings, {}), ...news };
      await db.run('UPDATE mode SET settings = ? WHERE id = ?', [JSON.stringify(cur), NEWS_MODE_ID]);
    }
  });
}
