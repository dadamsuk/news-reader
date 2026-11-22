export type AdapterType = 'guardian_content_api' | 'rss' | 'google_news_search';
export type Role = 'primary' | 'perspective';
export type Lean = 'left' | 'centre-left' | 'centre' | 'centre-right' | 'right';
export type ReaderMode = 'extract' | 'api_body' | 'browser';
export type Tone = 'news' | 'comment' | 'analysis' | 'live';
export type Surface = 'feed' | 'second_source' | 'digest';
export type InteractionKind = 'open' | 'read' | 'save' | 'unsave' | 'dismiss' | 'more' | 'less' | 'bounce' | 'ignored';

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
  second: SecondSourceView | null;
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
