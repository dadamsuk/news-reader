import type { Db } from '../db/db';
import { placeholders } from '../db/db';
import {
  BASELINE_RATIO, HIDING_KINDS, applySignal, finalScore, goodFits, importance, loadStats, lowerReasons, preferencePart, relativeMatch,
} from './ranking';
import { loadSettings, saveSettings, type Settings } from './settings';
import { isRightLeaning } from './sources';
import { readEstimate } from './learning';
import { loadTopicFilter } from './topics';
import {
  DAY, HOUR, NEWS_MODE_ID,
  type Article, type BubbleItem, type DigestItem, type FeedCard, type InteractionKind, type Lean, type LessReason, type Surface,
} from './types';
import { safeJson } from './util';

export const SESSION_GAP_MS = 10 * 60_000;
export const CLUSTER_SUPPRESS_MS = 72 * HOUR;
export const DIGEST_WINDOW_MS = 36 * HOUR;
export const FEED_LIMIT = 300;
/** Unseen articles older than this are no longer offered in the feed (their freshness is nil). */
export const FEED_WINDOW_MS = 4 * DAY;

// ---------- sessions ----------

/**
 * Returns the current session id, starting a new session when there is none, when forced
 * (pull-to-refresh), or when the app has been in the background for 10 minutes or more.
 */
export async function ensureSession(db: Db, now: number, forceNew = false): Promise<{ sessionId: string; isNew: boolean }> {
  const s = await loadSettings(db);
  const expired = s.lastBackgroundAt > 0 && now - s.lastBackgroundAt >= SESSION_GAP_MS;
  // When the app was last in use: the moment it went to the background, or the last session start.
  const awaySince = Math.max(s.lastBackgroundAt, s.lastActiveAt);
  if (s.sessionId && !forceNew && !expired) {
    if (s.lastBackgroundAt) await saveSettings(db, { lastBackgroundAt: 0 });
    return { sessionId: s.sessionId, isNew: false };
  }
  const sessionId = now.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  const patch: Partial<Settings> = { sessionId, sessionStartedAt: now, lastBackgroundAt: 0, lastActiveAt: now };
  // Back after a long gap: the next refresh writes a catch-up briefing for the time away.
  if (!forceNew && s.briefingEnabled && awaySince > 0 && now - awaySince >= s.briefingGapHours * HOUR) {
    patch.briefingSince = awaySince;
  }
  await saveSettings(db, patch);
  await scoreIgnoredImpressions(db, sessionId, now);
  return { sessionId, isNew: true };
}

export async function noteBackground(db: Db, now: number): Promise<void> {
  await saveSettings(db, { lastBackgroundAt: now, lastActiveAt: now });
}

/**
 * "Shown, not opened": cards from finished sessions that drew no reaction count as a weak negative.
 * A card swiped away (hidden) drew no reaction either: it counts the same as one scrolled past.
 */
export async function scoreIgnoredImpressions(db: Db, currentSessionId: string, now: number): Promise<number> {
  const rows = await db.all<{ article_id: number }>(
    `SELECT i.article_id FROM impression i
     WHERE i.scored = 0 AND i.session_id != ? AND i.surface = 'feed'
       AND NOT EXISTS (SELECT 1 FROM interaction x WHERE x.article_id = i.article_id AND x.kind != 'hidden')`,
    [currentSessionId],
  );
  for (const r of rows) {
    await db.run("INSERT INTO interaction(article_id, kind, at) VALUES(?, 'ignored', ?)", [r.article_id, now]);
    await applySignal(db, r.article_id, 'ignored', now);
  }
  await db.run('UPDATE impression SET scored = 1 WHERE scored = 0 AND session_id != ?', [currentSessionId]);
  return rows.length;
}

// ---------- seen rule ----------

/** Writes the seen timestamp for articles the first time they are on screen. Never overwrites. */
export async function recordImpressions(
  db: Db, items: { articleId: number; surface: Surface }[], sessionId: string, now: number,
): Promise<void> {
  if (!items.length) return;
  await db.tx(async () => {
    // Items seen in one batch keep their on-screen order (one millisecond apart).
    for (let i = 0; i < items.length; i++) {
      await db.run(
        'INSERT OR IGNORE INTO impression(article_id, first_seen_at, session_id, surface) VALUES(?,?,?,?)',
        [items[i].articleId, now + i, sessionId, items[i].surface],
      );
    }
  });
}

/**
 * Index of the furthest card that has been at least half on screen. A list scrolled past a card
 * must have shown it, even if a fast fling skipped its viewability callback, so everything up to
 * the high-water mark counts as seen.
 */
export function highWaterMark(previous: number, viewableIndexes: number[]): number {
  let hw = previous;
  for (const i of viewableIndexes) if (i > hw) hw = i;
  return hw;
}

// ---------- rows ----------

export function rowToArticle(r: any): Article {
  return {
    id: r.id,
    sourceId: r.source_id,
    canonicalUrl: r.canonical_url,
    url: r.url,
    externalId: r.external_id ?? null,
    title: r.title,
    summary: r.summary ?? '',
    imageUrl: r.image_url ?? null,
    publishedAt: r.published_at,
    section: r.section ?? null,
    tags: safeJson<string[]>(r.tags, []),
    tone: r.tone ?? null,
    byline: r.byline ?? null,
    wordCount: r.word_count ?? null,
    clusterId: r.cluster_id ?? null,
    fetchedAt: r.fetched_at,
    scoreA: r.score_a ?? 0,
    scoreS: r.score_s ?? 0,
    scoreI: r.score_i ?? 0,
    hasBody: !!r.has_body,
  };
}

/** Article columns without the heavy blobs. */
export const ARTICLE_COLS = `a.id, a.source_id, a.canonical_url, a.url, a.external_id, a.title, a.summary, a.image_url,
  a.published_at, a.section, a.tags, a.tone, a.byline, a.word_count, a.cluster_id, a.fetched_at,
  a.score_a, a.score_s, a.score_i, (a.body_html IS NOT NULL) has_body`;

// ---------- exploration ----------

export interface RankItem {
  id: number;
  score: number;
  section: string | null;
  publishedAt: number;
}

export const BLOCK_SIZE = 20;
/** Positions inside each block of 20 that go to exploration (3 of every 20). */
export const EXPLORE_SLOTS = [5, 11, 17];

/**
 * Orders the unseen feed. Most slots go to the highest scores; three in every twenty go to a
 * random pick from sections he rarely opens, drawn from the fresher half of those articles.
 */
export function buildFeedOrder(
  items: RankItem[], sectionPositive: Map<string, number>, rng: () => number,
): { id: number; explore: boolean }[] {
  const ranked = items.slice().sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt || a.id - b.id);
  const key = (s: string | null) => (s ?? '').toLowerCase().trim();
  const sections = Array.from(new Set(items.map((i) => key(i.section))));
  const weights = sections.map((s) => sectionPositive.get(s) ?? 0).sort((a, b) => a - b);
  const median = weights.length ? weights[Math.floor((weights.length - 1) / 2)] : 0;
  const rare = new Set(sections.filter((s) => (sectionPositive.get(s) ?? 0) <= median));
  const rareItems = items.filter((i) => rare.has(key(i.section))).sort((a, b) => b.publishedAt - a.publishedAt || a.id - b.id);

  const used = new Set<number>();
  const out: { id: number; explore: boolean }[] = [];
  let next = 0;
  for (let slot = 0; slot < items.length; slot++) {
    let picked: RankItem | undefined;
    let explore = false;
    if (EXPLORE_SLOTS.includes(slot % BLOCK_SIZE)) {
      // The fresher half of the rare-section articles not yet placed.
      const remaining = rareItems.filter((p) => !used.has(p.id));
      const pool = remaining.slice(0, Math.ceil(remaining.length / 2));
      if (pool.length) {
        picked = pool[Math.floor(rng() * pool.length)];
        explore = true;
      }
    }
    if (!picked) {
      while (next < ranked.length && used.has(ranked[next].id)) next++;
      picked = ranked[next];
      if (!picked) break;
    }
    used.add(picked.id);
    out.push({ id: picked.id, explore });
  }
  return out;
}

// ---------- feed ----------

/** Clusters already seen in an earlier session within the last 72 hours. */
async function seenClusters(db: Db, sessionId: string, now: number): Promise<Set<number>> {
  const rows = await db.all<{ cluster_id: number }>(
    `SELECT DISTINCT a.cluster_id FROM impression i JOIN article a ON a.id = i.article_id
     WHERE a.cluster_id IS NOT NULL AND i.session_id != ? AND i.first_seen_at > ?`,
    [sessionId, now - CLUSTER_SUPPRESS_MS],
  );
  return new Set(rows.map((r) => r.cluster_id));
}

/** What a watched term adds to a card's score: enough to put it among the first cards. */
export const WATCH_BOOST = 3;
/** Latest first shows at most this many stories. */
export const LATEST_LIMIT = 100;

const FEED_SELECT = `SELECT ${ARTICLE_COLS}, s.name source_name, i.first_seen_at seen_at,
            COALESCE(c.outlet_count, 1) outlets,
            (rl.article_id IS NOT NULL AND rl.done_at IS NULL) saved,
            EXISTS (SELECT 1 FROM interaction m WHERE m.article_id = a.id AND m.kind = 'interested') interested,
            EXISTS (SELECT 1 FROM interaction v WHERE v.article_id = a.id AND v.kind = 'viewed') opened,
            EXISTS (SELECT 1 FROM story_article sa WHERE sa.article_id = a.id) following`;
/** An article open for five seconds or more has been read as far as the feeds are concerned. */
const FEED_HIDING: InteractionKind[] = [...HIDING_KINDS, 'viewed', 'hidden'];
const notHiddenBy = (kinds: InteractionKind[]) =>
  `NOT EXISTS (SELECT 1 FROM interaction x WHERE x.article_id = a.id AND x.kind IN (${kinds.map((k) => `'${k}'`).join(',')}))`;
const NOT_HIDDEN = notHiddenBy(FEED_HIDING);
/** Latest first keeps what has been read; only a card put away by hand (hidden, marked down) goes. */
const NOT_PUT_AWAY = notHiddenBy(FEED_HIDING.filter((k) => k !== 'viewed'));
const likeTerm = (t: string) => `%${t.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
const LIKE_ANY = "(a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\' OR a.tags LIKE ? ESCAPE '\\' OR a.section LIKE ? ESCAPE '\\')";

/**
 * The For you feed. Two settings shape it.
 *
 * Normally (seen rule): processed articles from enabled primary sources that are unseen, or were
 * first seen in this session (so scrolling back up still works). Cards seen this session keep
 * their place at the top in the order they were seen; the rest follow in order (see below).
 *
 * Latest first (settings.chronological): the seen rule is off. The newest stories, up to
 * LATEST_LIMIT, newest at the top, whether or not they have been on screen or read; only those put
 * away by hand (hidden, not interested, less like this) go. Filtered, the 100 best matches, best
 * first; unfiltered, simply the newest 100, newest first.
 *
 * Every card carries `match`: how well it suits him against the other stories on offer, 5 to 95.
 *
 * Filtered (the default): sorted by match, watched topics first. Stories whose match is below
 * settings.filterThreshold are left out, except watched ones and (seen rule) cards already seen this
 * session, which keep their place. There are no exploration slots: the Outside tab does that job.
 *
 * Unfiltered (settings.unfiltered): what has been learned decides nothing. The feed is ordered on
 * news value alone (freshness and how widely it is covered), or by time with Latest first.
 *
 * Mute and watch lists apply in every mode: an article matching a muted term is left out, and one
 * matching a watched term is lifted to the top (ranked feed). A watched term also brings in
 * perspective-source articles, one per story, when no primary source in the feed is carrying that story.
 */
export async function loadFeed(db: Db, settings: Settings, sessionId: string, now: number): Promise<FeedCard[]> {
  const latest = settings.chronological;
  const unfiltered = settings.unfiltered;
  // Unfiltered, cards are ordered as though nothing had been learned.
  const rankSettings = unfiltered ? { ...settings, weightA: 0, weightS: 0 } : settings;
  const topics = await loadTopicFilter(db, now);
  const visible = latest
    ? `a.published_at > ? AND ${NOT_PUT_AWAY}`
    : `((i.article_id IS NULL AND a.published_at > ?) OR (i.session_id = ? AND i.surface NOT IN ('bubble', 'coverage'))) AND ${NOT_HIDDEN}`;
  const visibleParams = latest ? [now - FEED_WINDOW_MS] : [now - FEED_WINDOW_MS, sessionId];
  const rows = await db.all<any>(
    `${FEED_SELECT}
     FROM article a
     JOIN source s ON s.id = a.source_id AND s.role = 'primary' AND s.enabled = 1 AND s.mode_id = ${NEWS_MODE_ID}
     LEFT JOIN cluster c ON c.id = a.cluster_id
     LEFT JOIN impression i ON i.article_id = a.id
     LEFT JOIN read_later rl ON rl.article_id = a.id
     WHERE a.ready_at IS NOT NULL AND ${visible}`,
    visibleParams,
  );
  const cards = new Map<number, FeedCard>();
  const addCard = (r: any, article: Article, watch: string | null) => {
    const prefs = { a: article.scoreA, s: article.scoreS };
    cards.set(article.id, {
      article,
      sourceName: r.source_name,
      score: finalScore({ ...prefs, i: article.scoreI, publishedAt: article.publishedAt }, rankSettings, now)
        + (watch ? WATCH_BOOST : 0),
      explore: false,
      seenAt: latest ? null : (r.seen_at ?? null),
      saved: !!r.saved,
      interested: !!r.interested,
      goodFit: false,
      second: null,
      outletCount: r.outlets ?? 1,
      watch,
      following: !!r.following,
      match: null,
      opened: !!r.opened,
    });
  };
  const primaryClusters = new Set<number>();
  for (const r of rows) {
    const article = rowToArticle(r);
    if (topics.muted(article)) continue;
    addCard(r, article, topics.watched(article));
    if (article.clusterId != null) primaryClusters.add(article.clusterId);
  }
  if (topics.watchTerms.length) {
    // Watched terms reach into the perspective sources too. SQL narrows by substring; the whole-word
    // test decides. A story a primary card already carries, or (seen rule) one seen in an earlier
    // session, is skipped.
    const params = topics.watchTerms.flatMap((t) => [likeTerm(t), likeTerm(t), likeTerm(t), likeTerm(t)]);
    const extraVisible = latest
      ? `a.published_at > ? AND ${NOT_PUT_AWAY}`
      : `((i.article_id IS NULL AND a.published_at > ?) OR (i.session_id = ? AND i.surface = 'feed')) AND ${NOT_HIDDEN}`;
    const extra = await db.all<any>(
      `${FEED_SELECT}
       FROM article a
       JOIN source s ON s.id = a.source_id AND s.role = 'perspective' AND s.enabled = 1 AND s.mode_id = ${NEWS_MODE_ID}
       LEFT JOIN cluster c ON c.id = a.cluster_id
       LEFT JOIN impression i ON i.article_id = a.id
       LEFT JOIN read_later rl ON rl.article_id = a.id
       WHERE a.ready_at IS NOT NULL AND ${extraVisible} AND (${topics.watchTerms.map(() => LIKE_ANY).join(' OR ')})
       ORDER BY (i.article_id IS NULL), a.published_at DESC`,
      [...visibleParams, ...params],
    );
    const suppressed = extra.length && !latest ? await seenClusters(db, sessionId, now) : new Set<number>();
    const taken = new Set<number>();
    for (const r of extra) {
      const article = rowToArticle(r);
      const watch = topics.watched(article);
      if (!watch || topics.muted(article)) continue;
      const cid = article.clusterId;
      const fresh = latest || r.seen_at == null;
      if (fresh && cid != null && (primaryClusters.has(cid) || suppressed.has(cid) || taken.has(cid))) continue;
      if (cid != null) taken.add(cid);
      // Scoring covers primary and Right press articles only; one it has not reached counts as an
      // article with no history, not (score 0) as one strongly liked.
      if (article.scoreI === 0) {
        article.scoreA = BASELINE_RATIO;
        article.scoreI = importance(r.outlets ?? 1);
      }
      addCard(r, article, watch);
    }
  }
  const all = Array.from(cards.values());
  const fits = goodFits(all.map((c) => preferencePart({ a: c.article.scoreA, s: c.article.scoreS }, settings, now)));
  all.forEach((c, i) => { c.goodFit = fits[i]; });
  // Match: against every story on offer, so a card's figure does not depend on the scroll position.
  // Shown on every card. Undamped: the cold start only softens the unfiltered news-value order.
  const undamped = { ...settings, coldStartFactor: 1 };
  const matches = relativeMatch(all.map((c) => preferencePart({ a: c.article.scoreA, s: c.article.scoreS }, undamped, now)));
  all.forEach((c, i) => { c.match = matches[i]; });
  const threshold = unfiltered ? 0 : settings.filterThreshold;
  if (threshold > 0) {
    const keep = all.filter((c) => c.match! >= threshold || c.watch || c.seenAt != null);
    for (const c of all) if (!keep.includes(c)) cards.delete(c.article.id);
    all.length = 0;
    all.push(...keep);
  }
  // Filtered order: best match first (watched topics above all), the newer of two equal matches first.
  const byMatch = (a: FeedCard, b: FeedCard) =>
    (b.watch ? 1 : 0) - (a.watch ? 1 : 0) || b.match! - a.match! || b.article.publishedAt - a.article.publishedAt || b.article.id - a.article.id;
  const byTime = (a: FeedCard, b: FeedCard) => b.article.publishedAt - a.article.publishedAt || b.article.id - a.article.id;

  if (latest) {
    // Filtered: the best matches among the recent stories, best first. Unfiltered: the newest, newest first.
    const result = all.sort(unfiltered ? byTime : byMatch).slice(0, LATEST_LIMIT);
    await attachSecondSources(db, result, sessionId, now, true);
    return result;
  }

  // Seen this session: kept in the order seen, at the top. The rest: by match (filtered) or on news
  // value (unfiltered).
  const seen = all.filter((c) => c.seenAt != null).sort((a, b) => a.seenAt! - b.seenAt! || a.article.id - b.article.id);
  const unseen = all.filter((c) => c.seenAt == null)
    .sort(unfiltered ? (a, b) => b.score - a.score || byTime(a, b) : byMatch)
    .slice(0, FEED_LIMIT);
  const result = [...seen, ...unseen];
  await attachSecondSources(db, result, sessionId, now);
  return result;
}

/**
 * The second-source strip under each card. Under the seen rule a strip seen in an earlier session,
 * or one whose story was, is not shown again; Latest first (`keepSeen`) always shows it.
 */
async function attachSecondSources(db: Db, cards: FeedCard[], sessionId: string, now: number, keepSeen = false): Promise<void> {
  if (!cards.length) return;
  const suppressed = keepSeen ? new Set<number>() : await seenClusters(db, sessionId, now);
  const byId = new Map(cards.map((c) => [c.article.id, c]));
  const ids = cards.map((c) => c.article.id);
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = await db.all<any>(
      `SELECT ss.primary_article_id pid, ss.angle_note, o.id oid, o.cluster_id, os.name, oi.session_id seen_session
       FROM second_source ss
       JOIN article o ON o.id = ss.other_article_id
       JOIN source os ON os.id = o.source_id AND os.enabled = 1 AND os.role = 'perspective'
       LEFT JOIN impression oi ON oi.article_id = o.id
       WHERE ss.primary_article_id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const r of rows) {
      const card = byId.get(r.pid);
      if (!card) continue;
      if (!keepSeen) {
        // Seen in an earlier session, or its story already seen: the strip is not shown again.
        if (r.seen_session && r.seen_session !== sessionId) continue;
        if (card.seenAt == null && r.cluster_id != null && suppressed.has(r.cluster_id)) continue;
      }
      card.second = { articleId: r.oid, sourceName: r.name, angleNote: r.angle_note ?? null };
    }
  }
}

// ---------- Right press digest ----------

export async function loadDigest(db: Db, settings: Settings, sessionId: string, now: number): Promise<DigestItem[]> {
  const rows = await db.all<any>(
    `SELECT a.id, a.cluster_id, a.source_id, a.title, a.summary, a.section, a.tags, a.image_url, a.published_at, a.score_a, a.score_s,
            s.name source_name, s.lean, s.paywalled, c.digest_summary, c.digest_at,
            i.first_seen_at seen_at, i.session_id seen_session,
            NOT ${NOT_HIDDEN} hidden
     FROM cluster c
     JOIN article a ON a.cluster_id = c.id
     JOIN source s ON s.id = a.source_id AND s.enabled = 1 AND s.role = 'perspective' AND s.mode_id = ${NEWS_MODE_ID}
     LEFT JOIN impression i ON i.article_id = a.id
     WHERE c.mode_id = ${NEWS_MODE_ID} AND c.digest_status = 'qualified' AND c.has_primary = 0 AND c.right_outlet_count >= 2
       AND c.last_article_at > ?
     ORDER BY a.published_at DESC`,
    [now - DIGEST_WINDOW_MS],
  );
  const byCluster = new Map<number, any[]>();
  for (const r of rows) {
    if (!isRightLeaning(r.lean as Lean)) continue;
    const list = byCluster.get(r.cluster_id) ?? [];
    list.push(r);
    byCluster.set(r.cluster_id, list);
  }
  const topics = await loadTopicFilter(db, now);
  const mutedPiece = (m: any) => topics.muted({ title: m.title, summary: m.summary, section: m.section, tags: safeJson<string[]>(m.tags, []) });
  const items: DigestItem[] = [];
  for (const [clusterId, members] of byCluster) {
    // Once any article of the story was seen in an earlier session, the story is done.
    if (members.some((m) => m.seen_session && m.seen_session !== sessionId)) continue;
    // A muted term in any outlet's piece mutes the story.
    if (topics.rules.length && members.some(mutedPiece)) continue;
    // Hidden, marked down or read in any outlet's piece: the story is done, as in For you.
    if (members.some((m) => m.hidden)) continue;
    const seenTimes = members.filter((m) => m.seen_at != null).map((m) => m.seen_at as number);
    const perSource = new Map<number, any>();
    for (const m of members) if (!perSource.has(m.source_id)) perSource.set(m.source_id, m);
    const outlets = Array.from(perSource.values());
    if (outlets.length < 2) continue;
    const free = members.find((m) => !m.paywalled && m.image_url) ?? members.find((m) => m.image_url);
    const latestAt = Math.max(...members.map((m) => m.published_at));
    const learned = finalScore(
      { a: members[0].score_a, s: members[0].score_s, i: 0, publishedAt: latestAt }, { ...settings, weightF: 0 }, now,
    );
    const summary = members[0].digest_summary as string | null;
    items.push({
      clusterId,
      card: null as unknown as FeedCard, // filled in below
      summary: summary || outlets[0].title,
      hasSummary: !!summary,
      imageUrl: free?.image_url ?? null,
      outlets: outlets.map((m) => ({
        articleId: m.id, sourceId: m.source_id, sourceName: m.source_name, title: m.title, publishedAt: m.published_at,
      })),
      outletCount: outlets.length,
      latestAt,
      score: learned,
      seenAt: seenTimes.length ? Math.min(...seenTimes) : null,
    });
  }
  // Each story as a feed card, so the tab looks and works like For you: the newest outlet's piece,
  // with the neutral summary as its standfirst.
  const leadIds = items.map((it) => it.outlets[0].articleId);
  const leads = new Map<number, any>();
  for (let i = 0; i < leadIds.length; i += 400) {
    const chunk = leadIds.slice(i, i + 400);
    const rows = await db.all<any>(
      `${FEED_SELECT}
       FROM article a JOIN source s ON s.id = a.source_id
       LEFT JOIN cluster c ON c.id = a.cluster_id
       LEFT JOIN impression i ON i.article_id = a.id
       LEFT JOIN read_later rl ON rl.article_id = a.id
       WHERE a.id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const r of rows) leads.set(r.id, r);
  }
  for (const it of items) {
    const r = leads.get(it.outlets[0].articleId);
    if (!r) continue;
    const article = rowToArticle(r);
    it.card = {
      article: { ...article, summary: it.hasSummary ? it.summary : article.summary, imageUrl: article.imageUrl ?? it.imageUrl },
      sourceName: r.source_name,
      score: it.score,
      explore: false,
      seenAt: it.seenAt,
      saved: !!r.saved,
      interested: !!r.interested,
      goodFit: false,
      second: null,
      outletCount: it.outletCount,
      watch: null,
      following: !!r.following,
    };
  }
  const withCards = items.filter((it) => it.card);
  items.length = 0;
  items.push(...withCards);
  // Seen-this-session items keep their place; the rest: outlets, then recency, then learned interest.
  const rank = (a: DigestItem, b: DigestItem) =>
    b.outletCount - a.outletCount ||
    Math.floor(b.latestAt / (3 * HOUR)) - Math.floor(a.latestAt / (3 * HOUR)) ||
    b.score - a.score ||
    b.latestAt - a.latestAt;
  const seen = items.filter((i) => i.seenAt != null).sort((a, b) => a.seenAt! - b.seenAt!);
  const unseen = items.filter((i) => i.seenAt == null).sort(rank);
  return [...seen, ...unseen];
}

// ---------- outside your bubble ----------

/** Distinct outlets (primary included) a story needs to count as widely covered. */
export const BUBBLE_MIN_OUTLETS = 3;
/** On news value alone it would be within this many places of the top. */
export const BUBBLE_NEUTRAL_TOP = 30;
/** Preferences must push it at least this many places further down. */
export const BUBBLE_MIN_DROP = 20;
export const BUBBLE_LIMIT = 20;

/**
 * Outside your bubble: widely covered stories from the primary sources that the learned ranking
 * pushed far down For you. Each unseen story is ranked twice, with preferences (as For you does)
 * and on news value alone (freshness and coverage); a story qualifies when it is widely covered,
 * near the top on news value, and well down with preferences. Stories dismissed or marked "less
 * like this" never qualify. Seen rule as elsewhere: cards seen here this session keep their place,
 * and anything seen anywhere in an earlier session is gone.
 */
export async function loadBubble(db: Db, settings: Settings, sessionId: string, now: number): Promise<BubbleItem[]> {
  const rows = await db.all<any>(
    `SELECT ${ARTICLE_COLS}, s.name source_name, i.first_seen_at seen_at, i.surface seen_surface,
            COALESCE(c.outlet_count, 1) outlets,
            (rl.article_id IS NOT NULL AND rl.done_at IS NULL) saved,
            EXISTS (SELECT 1 FROM interaction m WHERE m.article_id = a.id AND m.kind = 'interested') interested
     FROM article a
     JOIN source s ON s.id = a.source_id AND s.role = 'primary' AND s.enabled = 1 AND s.mode_id = ${NEWS_MODE_ID}
     LEFT JOIN cluster c ON c.id = a.cluster_id
     LEFT JOIN impression i ON i.article_id = a.id
     LEFT JOIN read_later rl ON rl.article_id = a.id
     WHERE a.ready_at IS NOT NULL
       AND ((i.article_id IS NULL AND a.published_at > ?) OR (i.session_id = ? AND i.surface = 'bubble'))
       AND ${NOT_HIDDEN}`,
    [now - FEED_WINDOW_MS, sessionId],
  );
  const neutralSettings = { ...settings, weightA: 0, weightS: 0 };
  const topics = await loadTopicFilter(db, now);
  const kept = rows.map((r) => ({ r, article: rowToArticle(r) })).filter((x) => !topics.muted(x.article));
  const all = kept.map(({ r, article }) => {
    const parts = { a: article.scoreA, s: article.scoreS, i: article.scoreI, publishedAt: article.publishedAt };
    return {
      r,
      article,
      personal: finalScore(parts, settings, now),
      neutral: finalScore(parts, neutralSettings, now),
      goodFit: false,
    };
  });
  // Judged against the same pool For you draws from, so a card shows the same mark in both tabs.
  const fits = goodFits(all.map((x) => preferencePart({ a: x.article.scoreA, s: x.article.scoreS }, settings, now)));
  all.forEach((x, i) => { x.goodFit = fits[i]; });
  // Ranks are taken over the unseen pool, which is what For you orders.
  const unseen = all.filter((x) => x.r.seen_at == null);
  const tie = (a: (typeof all)[number], b: (typeof all)[number]) => b.article.publishedAt - a.article.publishedAt || a.article.id - b.article.id;
  const personalRank = new Map(unseen.slice().sort((a, b) => b.personal - a.personal || tie(a, b)).map((x, i) => [x.article.id, i]));
  const neutralRank = new Map(unseen.slice().sort((a, b) => b.neutral - a.neutral || tie(a, b)).map((x, i) => [x.article.id, i]));

  const stats = await loadStats(db, now);
  const toItem = (x: (typeof all)[number], pr: number, nr: number): BubbleItem => ({
    card: {
      article: x.article,
      sourceName: x.r.source_name,
      score: x.personal,
      explore: false,
      seenAt: x.r.seen_at ?? null,
      saved: !!x.r.saved,
      interested: !!x.r.interested,
      goodFit: !!x.goodFit,
      second: null,
      outletCount: x.r.outlets,
      watch: null,
      following: false,
    },
    outletCount: x.r.outlets,
    personalRank: pr,
    neutralRank: nr,
    reasons: lowerReasons(
      { sourceId: x.article.sourceId, section: x.article.section, tags: x.article.tags, tone: x.article.tone,
        byline: x.article.byline, wordCount: x.article.wordCount },
      x.r.source_name, stats, x.article.scoreS, settings, now,
    ),
  });

  const fresh: BubbleItem[] = [];
  for (const x of unseen) {
    const pr = personalRank.get(x.article.id)!;
    const nr = neutralRank.get(x.article.id)!;
    if (x.r.outlets < BUBBLE_MIN_OUTLETS) continue;
    if (nr >= BUBBLE_NEUTRAL_TOP) continue;
    if (pr - nr < BUBBLE_MIN_DROP) continue;
    if (x.personal >= x.neutral) continue; // pushed down by others rising, not by its own features
    fresh.push(toItem(x, pr, nr));
  }
  fresh.sort((a, b) =>
    b.outletCount - a.outletCount ||
    (b.personalRank - b.neutralRank) - (a.personalRank - a.neutralRank) ||
    b.card.article.publishedAt - a.card.article.publishedAt);
  // Seen here this session: kept in the order seen. They have left the unseen pool, so they have no rank (-1).
  const seen = all
    .filter((x) => x.r.seen_at != null)
    .sort((a, b) => a.r.seen_at - b.r.seen_at)
    .map((x) => toItem(x, personalRank.get(x.article.id) ?? -1, neutralRank.get(x.article.id) ?? -1));
  return [...seen, ...fresh.slice(0, BUBBLE_LIMIT)];
}

// ---------- interactions ----------

async function logInteraction(
  db: Db, articleId: number, kind: InteractionKind, now: number, dwell?: number, scroll?: number,
): Promise<void> {
  await db.run(
    'INSERT INTO interaction(article_id, kind, at, dwell_seconds, max_scroll_pct) VALUES(?,?,?,?,?)',
    [articleId, kind, now, dwell ?? null, scroll ?? null],
  );
}

/**
 * Opening counts as seeing (History must list it) and is logged for learning. In a sections-layout
 * mode the first open of an article is itself a signal (News learns from reading, not opening).
 */
export async function recordOpen(db: Db, articleId: number, sessionId: string, surface: Surface, now: number): Promise<void> {
  await recordImpressions(db, [{ articleId, surface }], sessionId, now);
  const first = !(await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'open'", [articleId]));
  await logInteraction(db, articleId, 'open', now);
  if (first) await applySignal(db, articleId, 'open', now);
}

/**
 * Sections layout: opened one of the other sources behind a card's "+N more". The signal goes on
 * the card's story; the other article is opened as coverage (it is not a card of its own).
 */
export async function recordOpenMore(db: Db, cardArticleId: number, otherArticleId: number, sessionId: string, now: number): Promise<void> {
  await recordImpressions(db, [{ articleId: cardArticleId, surface: 'feed' }, { articleId: otherArticleId, surface: 'coverage' }], sessionId, now);
  if (await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'open_more'", [cardArticleId])) return;
  await logInteraction(db, cardArticleId, 'open_more', now);
  await applySignal(db, cardArticleId, 'open_more', now);
}

export const READ_SCROLL_PCT = 60;
export const READ_SECONDS = 45;
export const BOUNCE_SECONDS = 3;
export const DONE_SCROLL_PCT = 70;
/** Open this long, an article moves out of the feeds: it is then only in History (and Read later, if saved). */
export const VIEWED_SECONDS = 5;

/** What leaving the reader means for learning: read, bounced, or nothing. */
export function classifyReading(dwellSeconds: number, maxScrollPct: number): 'read' | 'bounce' | null {
  // A short piece fits on one screen and reports 100% at once, so it needs 5 seconds to count as read;
  // under 3 seconds is a bounce whatever the scroll depth.
  if (dwellSeconds >= READ_SECONDS || (maxScrollPct >= READ_SCROLL_PCT && dwellSeconds >= 5)) return 'read';
  if (dwellSeconds < BOUNCE_SECONDS) return 'bounce';
  return null;
}

/**
 * Called when the reader closes. Returns whether a Read later item was marked done, and whether
 * the article was open long enough to leave the feeds.
 */
export async function recordReading(
  db: Db, articleId: number, dwellSeconds: number, maxScrollPct: number, now: number,
): Promise<{ kind: 'read' | 'bounce' | null; done: boolean; viewed: boolean }> {
  // A sections-layout mode counts a read as reaching the end, or staying for 60% of the estimated
  // read time; the five-second floor applies as in News. It has no bounce signal.
  const est = await readEstimate(db, articleId);
  const kind = est
    ? (dwellSeconds >= 5 && (maxScrollPct >= 90 || (est.seconds > 0 && dwellSeconds >= est.fraction * est.seconds)) ? 'read' : null)
    : classifyReading(dwellSeconds, maxScrollPct);
  if (kind) {
    const already = await db.get('SELECT 1 x FROM interaction WHERE article_id = ? AND kind = ?', [articleId, kind]);
    await logInteraction(db, articleId, kind, now, dwellSeconds, maxScrollPct);
    // Each article teaches the model once per kind, however often it is reopened.
    if (!already && !(kind === 'bounce' && (await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'read'", [articleId])))) {
      await applySignal(db, articleId, kind, now);
    }
  }
  let done = false;
  if (maxScrollPct >= DONE_SCROLL_PCT && dwellSeconds >= 5) done = await markDone(db, articleId, now);
  const viewed = dwellSeconds >= VIEWED_SECONDS;
  if (viewed && !(await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'viewed'", [articleId]))) {
    await logInteraction(db, articleId, 'viewed', now, dwellSeconds, maxScrollPct);
  }
  return { kind, done, viewed };
}

export async function saveForLater(db: Db, articleId: number, sessionId: string, now: number): Promise<void> {
  const existing = await db.get<{ done_at: number | null }>('SELECT done_at FROM read_later WHERE article_id = ?', [articleId]);
  await db.run(
    `INSERT INTO read_later(article_id, saved_at, done_at) VALUES(?, ?, NULL)
     ON CONFLICT(article_id) DO UPDATE SET saved_at = excluded.saved_at, done_at = NULL`,
    [articleId, now],
  );
  await recordImpressions(db, [{ articleId, surface: 'feed' }], sessionId, now);
  await logInteraction(db, articleId, 'save', now);
  if (!existing) await applySignal(db, articleId, 'save', now);
}

export async function unsave(db: Db, articleId: number, now: number): Promise<void> {
  await db.run('DELETE FROM read_later WHERE article_id = ?', [articleId]);
  await logInteraction(db, articleId, 'unsave', now);
}

/** Moves a Read later item to History. Returns false if it was not an open item. */
export async function markDone(db: Db, articleId: number, now: number): Promise<boolean> {
  const r = await db.run('UPDATE read_later SET done_at = ? WHERE article_id = ? AND done_at IS NULL', [now, articleId]);
  return r.changes > 0;
}

export async function undoDone(db: Db, articleId: number): Promise<void> {
  await db.run('UPDATE read_later SET done_at = NULL WHERE article_id = ?', [articleId]);
}

/**
 * Hide (swipe right): the card goes, and that is all. It teaches nothing now; when its session
 * ends it counts as scrolled past (-0.2), the same as any card seen and left alone.
 */
export async function hideArticle(db: Db, articleId: number, sessionId: string, now: number): Promise<void> {
  await recordImpressions(db, [{ articleId, surface: 'feed' }], sessionId, now);
  if (await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'hidden'", [articleId])) return;
  await logInteraction(db, articleId, 'hidden', now);
}

export async function unhideArticle(db: Db, articleId: number): Promise<void> {
  await db.run("DELETE FROM interaction WHERE article_id = ? AND kind = 'hidden'", [articleId]);
}

/** Not interested (thumbs-down): -1 on everything about the article. The card goes. */
export async function dismiss(db: Db, articleId: number, sessionId: string, now: number): Promise<void> {
  await recordImpressions(db, [{ articleId, surface: 'feed' }], sessionId, now);
  await logInteraction(db, articleId, 'dismiss', now);
  await applySignal(db, articleId, 'dismiss', now);
}

/** Takes back every signal of one kind for an article, reversing what it taught the model. */
async function takeBack(db: Db, articleId: number, kind: InteractionKind, now: number): Promise<void> {
  const row = await db.get<{ at: number | null }>('SELECT MIN(at) at FROM interaction WHERE article_id = ? AND kind = ?', [articleId, kind]);
  if (row?.at == null) return;
  await db.run('DELETE FROM interaction WHERE article_id = ? AND kind = ?', [articleId, kind]);
  await applySignal(db, articleId, kind, now, row.at);
}

export async function undoDismiss(db: Db, articleId: number, now = Date.now()): Promise<void> {
  await takeBack(db, articleId, 'dismiss', now);
}

/** More like this (long-press menu): the strongest positive signal. Counts once per article. */
export async function moreLikeThis(db: Db, articleId: number, now: number): Promise<void> {
  if (await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'more'", [articleId])) return;
  await logInteraction(db, articleId, 'more', now);
  await applySignal(db, articleId, 'more', now);
}

/**
 * Interested (the card's thumbs-up): "I like this, but I am not going to read it". Worth the same
 * as reading or saving it. Counts once per article; tapping again takes it back.
 */
export async function markInterested(db: Db, articleId: number, now: number): Promise<void> {
  if (await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'interested'", [articleId])) return;
  await logInteraction(db, articleId, 'interested', now);
  await applySignal(db, articleId, 'interested', now);
}

export async function unmarkInterested(db: Db, articleId: number, now: number): Promise<void> {
  await takeBack(db, articleId, 'interested', now);
}

const LESS_KIND: Record<LessReason, InteractionKind> = { source: 'less_source', section: 'less_section', topic: 'less_topic' };

/**
 * Swipe left, "Show me less like this, because": the full -3 on the one part named (its source,
 * its category or its topics) rather than spread over the whole article. The card goes.
 */
export async function lessBecause(db: Db, articleId: number, reason: LessReason, sessionId: string, now: number): Promise<void> {
  const kind = LESS_KIND[reason];
  await recordImpressions(db, [{ articleId, surface: 'feed' }], sessionId, now);
  if (await db.get('SELECT 1 x FROM interaction WHERE article_id = ? AND kind = ?', [articleId, kind])) return;
  await logInteraction(db, articleId, kind, now);
  await applySignal(db, articleId, kind, now);
}

export async function undoLessBecause(db: Db, articleId: number, reason: LessReason, now: number): Promise<void> {
  await takeBack(db, articleId, LESS_KIND[reason], now);
}

/** Less like this (long-press menu): the strongest general negative, -3 on everything about it. The card goes. */
export async function lessLikeThis(db: Db, articleId: number, sessionId: string, now: number): Promise<void> {
  await recordImpressions(db, [{ articleId, surface: 'feed' }], sessionId, now);
  if (await db.get("SELECT 1 x FROM interaction WHERE article_id = ? AND kind = 'less'", [articleId])) return;
  await logInteraction(db, articleId, 'less', now);
  await applySignal(db, articleId, 'less', now);
}

/** Undo for Less like this: the card comes back and the signal is reversed. */
export async function undoLess(db: Db, articleId: number, now: number): Promise<void> {
  await takeBack(db, articleId, 'less', now);
}

// ---------- read later & history ----------

export interface ListRow {
  article: Article;
  sourceName: string;
  at: number;
  offline: boolean;
}

/** One mode's Read later list (News unless another mode is named). */
export async function loadReadLater(db: Db, modeId: number = NEWS_MODE_ID): Promise<ListRow[]> {
  const rows = await db.all<any>(
    `SELECT ${ARTICLE_COLS}, s.name source_name, rl.saved_at at
     FROM read_later rl JOIN article a ON a.id = rl.article_id LEFT JOIN source s ON s.id = a.source_id
     WHERE rl.done_at IS NULL AND a.mode_id = ? ORDER BY rl.saved_at DESC`,
    [modeId],
  );
  return rows.map((r) => ({ article: rowToArticle(r), sourceName: r.source_name ?? '', at: r.at, offline: !!r.has_body }));
}

/** Everything seen in one mode in the last 14 days (and finished Read later items), newest first. */
export async function loadHistory(db: Db, now: number, search = '', limit = 300, modeId: number = NEWS_MODE_ID): Promise<ListRow[]> {
  const q = search.trim();
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const rows = await db.all<any>(
    `SELECT ${ARTICLE_COLS}, s.name source_name, MAX(COALESCE(i.first_seen_at, 0), COALESCE(rl.done_at, 0)) at
     FROM article a
     LEFT JOIN impression i ON i.article_id = a.id
     LEFT JOIN read_later rl ON rl.article_id = a.id AND rl.done_at IS NOT NULL
     LEFT JOIN source s ON s.id = a.source_id
     WHERE a.mode_id = ? AND (i.first_seen_at > ? OR rl.done_at > ?)
       ${q ? "AND a.title LIKE ? ESCAPE '\\'" : ''}
     ORDER BY at DESC, a.id DESC LIMIT ?`,
    q ? [modeId, now - 14 * DAY, now - 14 * DAY, like, limit] : [modeId, now - 14 * DAY, now - 14 * DAY, limit],
  );
  return rows.map((r) => ({ article: rowToArticle(r), sourceName: r.source_name ?? '', at: r.at, offline: !!r.has_body }));
}

/**
 * More: the newest headlines from the other (perspective) sources, exactly as published. No ranking,
 * no seen rule, no mute list.
 */
export async function loadMore(db: Db, limit = 300): Promise<ListRow[]> {
  const rows = await db.all<any>(
    `SELECT ${ARTICLE_COLS}, s.name source_name, a.published_at at
     FROM article a JOIN source s ON s.id = a.source_id AND s.role = 'perspective' AND s.enabled = 1 AND s.mode_id = ${NEWS_MODE_ID}
     ORDER BY a.published_at DESC, a.id DESC LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ article: rowToArticle(r), sourceName: r.source_name ?? '', at: r.at, offline: !!r.has_body }));
}

export async function getArticle(db: Db, id: number): Promise<Article | null> {
  const r = await db.get<any>(`SELECT ${ARTICLE_COLS} FROM article a WHERE a.id = ?`, [id]);
  return r ? rowToArticle(r) : null;
}
