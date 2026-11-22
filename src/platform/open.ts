import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { AppState } from 'react-native';
import { recordOpen, recordReading } from '../core/feed';
import { effectiveReaderMode } from '../core/sources';
import type { Surface } from '../core/types';
import { bumpData, getState, showSnack } from '../state/store';
import { getDb } from './db';

/**
 * Opens a URL in the in-app browser (Chrome Custom Tabs on Android, SFSafariViewController on iOS)
 * and reports how long it was open, for learning.
 */
export async function openInBrowser(url: string, articleId?: number): Promise<void> {
  const started = Date.now();
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    sub.remove();
    if (articleId == null) return;
    const dwell = (Date.now() - started) / 1000;
    try {
      const db = await getDb();
      // No scroll depth is available from the system browser: time on page is the only signal.
      const res = await recordReading(db, articleId, dwell, 0, Date.now());
      if (res.kind || res.viewed) bumpData();
    } catch {}
  };
  // On Android the promise resolves as soon as the tab opens, so the return to the app marks the end.
  let leftApp = false;
  const sub = AppState.addEventListener('change', (s) => {
    if (s !== 'active') leftApp = true;
    else if (leftApp) finish();
  });
  try {
    const result = await WebBrowser.openBrowserAsync(url, { showTitle: true, enableBarCollapsing: true });
    if (result.type === 'cancel' || result.type === 'dismiss') await finish();
  } catch {
    sub.remove();
    showSnack('Could not open the browser');
  }
}

/** Read now: the reader for sources read in the app, the in-app browser for the rest. */
export async function openArticle(articleId: number, surface: Surface): Promise<void> {
  const db = await getDb();
  const row = await db.get<any>(
    `SELECT a.url, s.reader_mode, s.paywalled FROM article a JOIN source s ON s.id = a.source_id WHERE a.id = ?`,
    [articleId],
  );
  if (!row) {
    showSnack('That article is no longer stored');
    return;
  }
  await recordOpen(db, articleId, getState().sessionId, surface, Date.now());
  const mode = effectiveReaderMode({ readerMode: row.reader_mode, paywalled: !!row.paywalled });
  if (mode === 'browser') {
    await openInBrowser(row.url, articleId);
  } else {
    router.push({ pathname: '/reader/[id]', params: { id: String(articleId) } });
  }
}
