import type { Db } from '../db/db';
import { DAY, NEWS_MODE_ID, type Briefing, type BriefingItem } from './types';
import { safeJson } from './util';

/** A briefing stays at the top of For you until it is dismissed, replaced, or a day old. */
export const BRIEFING_SHOWN_MS = DAY;

export async function loadBriefing(db: Db, now: number): Promise<Briefing | null> {
  const r = await db.get<any>('SELECT * FROM briefing WHERE mode_id = ? ORDER BY id DESC LIMIT 1', [NEWS_MODE_ID]);
  if (!r || r.dismissed_at != null || now - r.created_at > BRIEFING_SHOWN_MS) return null;
  const items = safeJson<BriefingItem[]>(r.items, []);
  if (!items.length) return null;
  return { id: r.id, createdAt: r.created_at, sinceAt: r.since_at, items };
}

export async function dismissBriefing(db: Db, id: number, now: number): Promise<void> {
  await db.run('UPDATE briefing SET dismissed_at = ? WHERE id = ?', [now, id]);
}

/** "14 hours", "2 days": how long the briefing covers. */
export function awayLabel(sinceAt: number, createdAt: number): string {
  const hours = Math.max(1, Math.round((createdAt - sinceAt) / 3600_000));
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(hours / 24)} days`;
}
