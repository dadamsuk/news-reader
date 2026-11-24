import type { Db } from '../db/db';
import { safeJson } from './util';

/**
 * Layer 2 of a sections-layout mode's learning: a readable interest profile, one markdown document
 * per mode under four headings. Every change is a new version, so any earlier one can be restored.
 * Lines he writes or edits are pinned: a rewrite by the model must keep them word for word.
 */
export const PROFILE_HEADINGS = ['Interested in', 'Not interested in', 'Sources I value', 'Notes'] as const;

export type ProfileAuthor = 'llm' | 'user' | 'starter';

export interface Profile {
  id: number;
  modeId: number;
  version: number;
  markdown: string;
  /** Lines (trimmed, as written) that a rewrite must keep word for word. */
  pinned: string[];
  createdBy: ProfileAuthor;
  createdAt: number;
}

function rowToProfile(r: any): Profile {
  return {
    id: r.id,
    modeId: r.mode_id,
    version: r.version,
    markdown: r.markdown,
    pinned: safeJson<string[]>(r.pinned_lines, []),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function getProfile(db: Db, modeId: number): Promise<Profile | null> {
  const r = await db.get('SELECT * FROM profile WHERE mode_id = ? ORDER BY version DESC LIMIT 1', [modeId]);
  return r ? rowToProfile(r) : null;
}

export async function listProfileVersions(db: Db, modeId: number, limit = 30): Promise<Profile[]> {
  return (await db.all('SELECT * FROM profile WHERE mode_id = ? ORDER BY version DESC LIMIT ?', [modeId, limit])).map(rowToProfile);
}

export async function addProfileVersion(
  db: Db, modeId: number, markdown: string, pinned: string[], by: ProfileAuthor, now: number,
): Promise<Profile> {
  const cur = await db.get<{ v: number | null }>('SELECT MAX(version) v FROM profile WHERE mode_id = ?', [modeId]);
  const version = (cur?.v ?? 0) + 1;
  const text = normaliseMarkdown(markdown);
  const keep = Array.from(new Set(pinned.map((l) => l.trim()).filter((l) => l && contentLines(text).includes(l))));
  const r = await db.run(
    'INSERT INTO profile(mode_id, version, markdown, pinned_lines, created_by, created_at) VALUES(?,?,?,?,?,?)',
    [modeId, version, text, JSON.stringify(keep), by, now],
  );
  return { id: r.lastInsertRowId, modeId, version, markdown: text, pinned: keep, createdBy: by, createdAt: now };
}

/** Trims trailing spaces and runs of blank lines; makes sure every heading is there. */
export function normaliseMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  const out: string[] = [];
  for (const l of lines) {
    if (!l && (!out.length || !out[out.length - 1])) continue;
    out.push(l);
  }
  let text = out.join('\n').trim();
  for (const h of PROFILE_HEADINGS) {
    if (!new RegExp(`^##\\s+${h}\\s*$`, 'mi').test(text)) text += `\n\n## ${h}`;
  }
  return text.trim() + '\n';
}

/** The lines that say something: not headings, not blank. Trimmed. */
export function contentLines(md: string): string[] {
  return md.split('\n').map((l) => l.trim()).filter((l) => l && !/^#{1,6}\s/.test(l));
}

/** The profile as sections: heading → its content lines, in order. */
export function profileSections(md: string): { heading: string; lines: string[] }[] {
  const out: { heading: string; lines: string[] }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const raw of md.split('\n')) {
    const l = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h) {
      cur = { heading: h[1].trim(), lines: [] };
      out.push(cur);
    } else if (l) {
      if (!cur) {
        cur = { heading: '', lines: [] };
        out.push(cur);
      }
      cur.lines.push(l);
    }
  }
  return out;
}

/**
 * He saved an edit: a new version. Lines he added or changed become pinned; lines that were pinned
 * and are still there stay pinned; a pinned line he deleted is gone (and unpinned).
 */
export async function saveProfileEdit(db: Db, modeId: number, markdown: string, now: number): Promise<Profile> {
  const cur = await getProfile(db, modeId);
  const before = new Set(cur ? contentLines(cur.markdown) : []);
  const after = contentLines(normaliseMarkdown(markdown));
  const pinned = new Set((cur?.pinned ?? []).filter((l) => after.includes(l)));
  for (const l of after) if (!before.has(l)) pinned.add(l);
  return addProfileVersion(db, modeId, markdown, Array.from(pinned), 'user', now);
}

/** Pins or unpins one line without changing the text (a new version all the same). */
export async function setLinePinned(db: Db, modeId: number, line: string, pin: boolean, now: number): Promise<Profile | null> {
  const cur = await getProfile(db, modeId);
  if (!cur) return null;
  const set = new Set(cur.pinned);
  if (pin) set.add(line.trim());
  else set.delete(line.trim());
  return addProfileVersion(db, modeId, cur.markdown, Array.from(set), 'user', now);
}

/** Brings back an earlier version as the newest one, pins and all. */
export async function restoreProfileVersion(db: Db, modeId: number, version: number, now: number): Promise<Profile | null> {
  const r = await db.get('SELECT * FROM profile WHERE mode_id = ? AND version = ?', [modeId, version]);
  if (!r) return null;
  const old = rowToProfile(r);
  return addProfileVersion(db, modeId, old.markdown, old.pinned, 'user', now);
}

/**
 * Makes a rewritten profile keep every pinned line word for word. A pinned line the rewrite lost
 * goes back under the heading it was under before (or Notes); a reworded copy of it is dropped.
 */
export function enforcePinned(rewritten: string, previous: string, pinned: string[]): string {
  const text = normaliseMarkdown(rewritten);
  const have = new Set(contentLines(text));
  const missing = pinned.filter((l) => !have.has(l));
  if (!missing.length) return text;
  const prevSections = profileSections(previous);
  const headingOf = (line: string) => prevSections.find((s) => s.lines.includes(line))?.heading ?? 'Notes';
  const sections = profileSections(text);
  const norm = (s: string) => s.toLowerCase().replace(/^[-*]\s*/, '').replace(/[^a-z0-9 ]/g, '').trim();
  for (const line of missing) {
    const heading = headingOf(line);
    let sec = sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase());
    if (!sec) {
      sec = { heading, lines: [] };
      sections.push(sec);
    }
    // A near-copy (the model reworded a pinned line) is replaced by the original.
    const near = sec.lines.findIndex((l) => norm(l) === norm(line));
    if (near >= 0) sec.lines.splice(near, 1, line);
    else sec.lines.push(line);
  }
  return normaliseMarkdown(sections.map((s) => (s.heading ? `## ${s.heading}\n${s.lines.join('\n')}` : s.lines.join('\n'))).join('\n\n'));
}
