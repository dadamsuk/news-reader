import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { recordImpressions } from '../core/feed';
import type { Surface } from '../core/types';
import { getDb } from '../platform/db';
import { getState } from '../state/store';

/** A card is seen once at least half of it is on screen, for any length of time. */
export const VIEWABILITY = { itemVisiblePercentThreshold: 50, minimumViewTime: 0, waitForInteraction: false } as const;

interface ViewToken {
  index?: number | null;
  isViewable: boolean;
}

export interface SeenEntry {
  key: number;
  impressions: { articleId: number; surface: Surface }[];
}

/**
 * Applies the seen rule to a list. Everything from the top down to the furthest card that is at
 * least half visible is recorded immediately (a fast fling cannot skip a card). Nothing is recorded
 * while the list is hidden, covered by another screen, or the app is in the background; the cards
 * in view are recorded as soon as it is visible again.
 */
export function useSeenTracker(entries: SeenEntry[], active: boolean, sessionKey: string) {
  const focused = useIsFocused();
  const entriesRef = useRef(entries);
  const liveRef = useRef(false);
  const viewableMax = useRef(-1);
  const recorded = useRef(new Set<number>());

  // A new session starts with nothing recorded. (Declared first: it must run before the flush below.)
  useLayoutEffect(() => {
    recorded.current = new Set();
    viewableMax.current = -1;
  }, [sessionKey]);
  // Keep the callbacks' view of the list current. Layout effects run before any scroll event can arrive.
  useLayoutEffect(() => {
    entriesRef.current = entries;
    liveRef.current = focused && active;
  }, [entries, focused, active]);

  const flush = useCallback(() => {
    if (!liveRef.current || AppState.currentState !== 'active') return;
    const max = viewableMax.current;
    if (max < 0) return;
    const list = entriesRef.current;
    const batch: { articleId: number; surface: Surface }[] = [];
    for (let i = 0; i <= max && i < list.length; i++) {
      const e = list[i];
      if (recorded.current.has(e.key)) continue;
      recorded.current.add(e.key);
      batch.push(...e.impressions);
    }
    if (!batch.length) return;
    const sessionId = getState().sessionId;
    getDb()
      .then((db) => recordImpressions(db, batch, sessionId, Date.now()))
      .catch(() => {});
  }, []);

  // Stable for the life of the list: FlatList does not allow this callback to change.
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      let max = -1;
      for (const v of viewableItems) if (v.isViewable && v.index != null && v.index > max) max = v.index;
      viewableMax.current = max;
      flush();
    },
    [flush],
  );

  // Back on screen (tab switch, reader closed, app resumed): record what is in view now.
  useEffect(() => {
    if (focused && active) flush();
  }, [focused, active, flush, entries]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') flush();
    });
    return () => sub.remove();
  }, [flush]);

  return { onViewableItemsChanged, recorded };
}

// ---------- independent check of the seen rule (used by the end-to-end flows) ----------

interface Audit {
  heights: Map<number, number>;
  maxFraction: Map<number, number>;
  order: number[];
  recorded: Set<number>;
  titles: Map<number, string>;
  /** Last known scroll position, so cards measured after the last scroll event are still counted. */
  last: { offsetY: number; viewportH: number; paddingTop: number } | null;
}

const audit: Audit = {
  heights: new Map(), maxFraction: new Map(), order: [], recorded: new Set(), titles: new Map(), last: null,
};

export function auditReset(): void {
  audit.heights.clear();
  audit.maxFraction.clear();
  audit.order = [];
  audit.recorded = new Set();
  audit.titles.clear();
  audit.last = null;
}

export function auditSetOrder(order: { id: number; title: string }[], recorded: Set<number>): void {
  audit.order = order.map((o) => o.id);
  audit.recorded = recorded;
  for (const o of order) audit.titles.set(o.id, o.title);
  if (audit.last) auditScroll(audit.last.offsetY, audit.last.viewportH, audit.last.paddingTop);
}

export function auditSetHeight(id: number, h: number): void {
  audit.heights.set(id, h);
  // A card laid out without any scrolling (the first screenful) is on screen all the same.
  if (audit.last) auditScroll(audit.last.offsetY, audit.last.viewportH, audit.last.paddingTop);
}

/** Works out, from layout alone, how much of each card is on screen at this scroll offset. */
export function auditScroll(offsetY: number, viewportH: number, paddingTop: number): void {
  audit.last = { offsetY, viewportH, paddingTop };
  if (viewportH <= 0) return;
  let y = paddingTop;
  for (const id of audit.order) {
    const h = audit.heights.get(id);
    if (!h) break;
    const visible = Math.min(y + h, offsetY + viewportH) - Math.max(y, offsetY);
    const frac = Math.max(0, visible) / h;
    if (frac > (audit.maxFraction.get(id) ?? 0)) audit.maxFraction.set(id, frac);
    y += h;
    if (y > offsetY + viewportH) break;
  }
}

export interface AuditReport {
  ok: boolean;
  seen: number;
  peeked: number;
  missed: string[];
  wrong: string[];
}

/**
 * Compares what geometry says with what was recorded: every card that reached clearly more than
 * half on screen must be recorded, and no card that stayed clearly under half may be.
 */
export function auditReport(): AuditReport {
  const missed: string[] = [];
  const wrong: string[] = [];
  let peeked = 0;
  for (const id of audit.order) {
    const f = audit.maxFraction.get(id) ?? 0;
    const rec = audit.recorded.has(id);
    if (f >= 0.56 && !rec) missed.push(audit.titles.get(id) ?? String(id));
    if (f <= 0.44 && rec) wrong.push(audit.titles.get(id) ?? String(id));
    if (f > 0 && f <= 0.44 && !rec) peeked++;
  }
  return { ok: !missed.length && !wrong.length, seen: audit.recorded.size, peeked, missed, wrong };
}
