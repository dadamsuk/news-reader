export type AdapterType = 'guardian_content_api' | 'rss' | 'google_news_search';
export type Role = 'primary' | 'perspective';
export type Lean = 'left' | 'centre-left' | 'centre' | 'centre-right' | 'right';
export type ReaderMode = 'extract' | 'api_body' | 'browser';
export type Tone = 'news' | 'comment' | 'analysis' | 'live';
/** Where an article was first on screen. 'coverage' is the Full coverage and followed-story lists (opened from there, not shown as a card). */
export type Surface = 'feed' | 'second_source' | 'digest' | 'bubble' | 'coverage';
export type InteractionKind =
  | 'open' | 'read' | 'save' | 'unsave' | 'dismiss' | 'more' | 'less' | 'bounce' | 'ignored'
  | 'interested' | 'less_source' | 'less_section' | 'less_topic'
  /** Open for five seconds or more: the card leaves the feeds (History still lists it). Teaches nothing by itself. */
  | 'viewed'
  /** Swiped away: the card leaves the feeds and counts exactly as if it had been scrolled past. */
  | 'hidden';

/** Why a swipe asked for less: one part of the article, not all of it. */
export type LessReason = 'source' | 'section' | 'topic';

export const ADAPTERS: AdapterType[] = ['guardian_content_api', 'rss', 'google_news_search'];
export const ROLES: Role[] = ['primary', 'perspective'];
export const LEANS: Lean[] = ['left', 'centre-left', 'centre', 'centre-right', 'right'];
export const READER_MODES: ReaderMode[] = ['extract', 'api_body', 'browser'];

export interface Source {
  id: number;
  name: string;
  adapter: AdapterType;
  /** One or more URLs (one per line), or a search query for google_news_search. */
  endpoint: string;
  apiKeyRef: string | null;
  role: Role;
  lean: Lean;
  readerMode: ReaderMode;
  paywalled: boolean;
  includeSections: string[];
  excludeSections: string[];
  refreshMinutes: number;
  enabled: boolean;
  lastOkAt: number | null;
  lastError: string | null;
  lastFetchAt: number | null;
  lastNewAt: number | null;
}

export type SourceInput = Omit<Source, 'id' | 'lastOkAt' | 'lastError' | 'lastFetchAt' | 'lastNewAt'>;

/** What an adapter returns before normalisation. */
export interface RawItem {
  url: string;
  title: string;
  summary?: string;
  imageUrl?: string;
  publishedAt?: number;
  section?: string;
  tags?: string[];
  tone?: Tone;
  byline?: string;
  wordCount?: number;
  externalId?: string;
  adapterBody?: string;
}

export interface Article {
  id: number;
  sourceId: number;
  canonicalUrl: string;
  url: string;
  externalId: string | null;
  title: string;
  summary: string;
  imageUrl: string | null;
  publishedAt: number;
  section: string | null;
  tags: string[];
  tone: Tone | null;
  byline: string | null;
  wordCount: number | null;
  clusterId: number | null;
  fetchedAt: number;
  scoreA: number;
  scoreS: number;
  scoreI: number;
  hasBody: boolean;
}

export interface SecondSourceView {
  articleId: number;
  sourceName: string;
  angleNote: string | null;
}

export interface FeedCard {
  article: Article;
  sourceName: string;
  score: number;
  explore: boolean;
  seenAt: number | null;
  saved: boolean;
  /** Thumbs-up given: interested, though not reading or saving it. */
  interested: boolean;
  /** Preferences lifted it above the typical story on offer (false: it is here for being recent). */
  goodFit: boolean;
  second: SecondSourceView | null;
  /** Distinct outlets covering this story (1 when it stands alone). */
  outletCount: number;
  /** The watch-list term that put or kept it here, if any. */
  watch: string | null;
  /** Part of a story being followed. */
  following: boolean;
}

export type TopicRuleKind = 'mute' | 'watch';

/** A muted or watched term. Expired rules stop applying by themselves. */
export interface TopicRule {
  id: number;
  kind: TopicRuleKind;
  term: string;
  createdAt: number;
  expiresAt: number | null;
}

/** A followed story as listed in the Following tab. */
export interface StoryView {
  id: number;
  title: string;
  followedAt: number;
  articleCount: number;
  /** Articles that joined since it was last opened. */
  newCount: number;
  newOutlets: number;
  latestAt: number | null;
  /** What changed, written by the model; null until written (or at the budget cap). */
  updateSummary: string | null;
  /** Newest new headline, shown when there is no summary. */
  latestTitle: string | null;
  imageUrl: string | null;
}

export interface BriefingItem {
  clusterId: number;
  /** The article to open: a primary one when there is one. */
  articleId: number;
  headline: string;
  /** One neutral sentence from the model; null shows the headline. */
  sentence: string | null;
  outletCount: number;
}

export interface Briefing {
  id: number;
  createdAt: number;
  sinceAt: number;
  items: BriefingItem[];
}

/** A widely covered primary story that the learned ranking pushed far down the For you feed. */
export interface BubbleItem {
  card: FeedCard;
  outletCount: number;
  /** 0-based position among unseen stories with preferences applied. */
  personalRank: number;
  /** 0-based position among unseen stories on news value alone (freshness and coverage). */
  neutralRank: number;
  /** What pulled it down, most first, e.g. ['Sport', 'Rugby union']. */
  reasons: string[];
}

export interface DigestOutlet {
  articleId: number;
  sourceId: number;
  sourceName: string;
  title: string;
  publishedAt: number;
}

export interface DigestItem {
  clusterId: number;
  summary: string;
  hasSummary: boolean;
  imageUrl: string | null;
  outlets: DigestOutlet[];
  outletCount: number;
  latestAt: number;
  score: number;
  seenAt: number | null;
}

export interface StepResult {
  name: string;
  ms: number;
  ok: boolean;
  info?: string;
  error?: string;
}

export interface RefreshRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  trigger: string;
  steps: StepResult[];
  newArticles: number;
}

export type FetchFn = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
