import type { Db } from '../db/db';
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
  clusterThreshold: number;
  /** Second-source candidates need at least this similarity; Haiku then confirms. */
  matchThreshold: number;
  /** A primary article this close to a Right press story means it is already covered. */
  digestCoveredThreshold: number;
  /** Between this and digestCoveredThreshold, Haiku decides whether the primary covered it. */
  digestGreyLow: number;
  capMatchThreshold: number;
  weightA: number;
  weightS: number;
  weightF: number;
  weightI: number;
  coldStartDays: number;
  coldStartFactor: number;
  /** Source names in preferred order for second sources. Empty: furthest lean first. */
  secondSourcePreference: string[];
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
}

export const DEFAULT_SETTINGS: Settings = {
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingDimensions: 512,
  chatModel: 'anthropic/claude-haiku-4.5',
  monthlyBudgetUsd: 10,
  refreshMinutes: 30,
  wifiOnlyPrefetch: true,
  textSize: 18,
  // Tuned on real headlines for text-embedding-3-small at 512 dimensions (see docs/decisions.md).
  clusterThreshold: 0.75,
  matchThreshold: 0.6,
  digestCoveredThreshold: 0.72,
  digestGreyLow: 0.55,
  capMatchThreshold: 0.8,
  weightA: 1.0,
  weightS: 1.5,
  weightF: 1.0,
  weightI: 0.5,
  coldStartDays: 14,
  coldStartFactor: 0.3,
  secondSourcePreference: [],
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
};

export async function loadSettings(db: Db): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM setting');
  const out: any = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      const def = (DEFAULT_SETTINGS as any)[r.key];
      const v = safeJson<any>(r.value, def);
      if (typeof v === typeof def && Array.isArray(v) === Array.isArray(def)) out[r.key] = v;
    }
  }
  return out as Settings;
}

export async function saveSettings(db: Db, patch: Partial<Settings>): Promise<void> {
  await db.tx(async () => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      await db.run(
        'INSERT INTO setting(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [k, JSON.stringify(v)],
      );
    }
  });
}
