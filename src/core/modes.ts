import type { Db } from '../db/db';
import { addProfileVersion, getProfile } from './profile';
import { insertSource } from './sources';
import { AI_MODE_ID, NEWS_MODE_ID, type InteractionKind, type SourceInput } from './types';
import { safeJson } from './util';

export { AI_MODE_ID, NEWS_MODE_ID };

/**
 * Modes: separate reading feeds, each with its own sources, display and learning, defined by data.
 * News (id 1) is the original app and keeps the News layout. Further modes use the sections layout
 * and are driven entirely by their row in `mode`: settings, layout and sources.
 */

export type SectionType = 'ranked' | 'other_news';

export interface SectionDef {
  type: SectionType;
  title: string;
}

export type Layout = { type: 'news' } | { type: 'sections'; sections: SectionDef[] };

export interface Mode {
  id: number;
  name: string;
  /** An Ionicons name. */
  icon: string;
  order: number;
  layout: Layout;
  createdAt: number;
}

/** Every threshold, weight, interval and age a sections-layout mode uses. Stored in `mode.settings`. */
export interface SectionsSettings {
  /** Style rules put in the enrichment prompt. */
  styleRules: string;
  /** Topic tags the model may choose from. */
  taxonomy: string[];
  itemTypes: string[];
  /** Items older than this are not fetched, and unseen stories expire after it. */
  maxAgeDays: number;
  /** Unseen stories at or above longAgeSignificance last this long instead. */
  longAgeDays: number;
  longAgeSignificance: number;
  clusterThreshold: number;
  clusterWindowHours: number;
  relevanceThreshold: number;
  /** During the cold start the main section takes stories from this relevance. */
  coldRelevanceThreshold: number;
  coldStartDays: number;
  /** When learning (re)started; the cold start runs from here. */
  learningStartedAt: number;
  relevanceProfileWeight: number;
  relevanceLearnedWeight: number;
  sigSourcesWeight: number;
  sigHnWeight: number;
  sigReleaseWeight: number;
  sigImpactWeight: number;
  /** Distinct sources at which the coverage part of significance is full. */
  sourcesSaturate: number;
  /** Hacker News points at which the Hacker News part of significance is full. */
  hnPointsFull: number;
  otherNewsMinSignificance: number;
  otherNewsCount: number;
  coldOtherNewsCount: number;
  /** Cards in the main section before "Show more", and how many each tap reveals. */
  pageSize: number;
  emaAlpha: number;
  signalWeights: Partial<Record<InteractionKind, number>>;
  /** "Seen, not opened" in In other news is multiplied by this. */
  otherNewsIgnoreFactor: number;
  /** Read: time on page over this share of the estimated read time (or read to the end). */
  readFraction: number;
  wordsPerMinute: number;
  graduationOpens: number;
  graduationDays: number;
  graduationStep: number;
  profileRewriteDays: number;
  profileRewriteSignals: number;
  /** Stories per enrichment request (each story is enriched once). */
  enrichBatchSize: number;
  /** Set once the mode's default sources and starter profile are in. */
  seeded: boolean;
  lastProfileRewriteAt: number;
  /** Tags already raised by graduation, and when (raised once per graduation window). */
  graduated: Record<string, number>;
}

export const STYLE_RULES = [
  'Plain English and British spelling.',
  'No hype words ("groundbreaking", "game-changing", "revolutionary" and the like).',
  'No exclamation marks and no em dashes.',
  'Say what the thing is and what changed.',
  'Include numbers when the source gives them.',
].join('\n');

export const DEFAULT_SECTIONS_SETTINGS: SectionsSettings = {
  styleRules: STYLE_RULES,
  taxonomy: [],
  itemTypes: ['release', 'research', 'how-to', 'opinion', 'business', 'policy', 'tool'],
  maxAgeDays: 7,
  longAgeDays: 14,
  longAgeSignificance: 0.8,
  clusterThreshold: 0.75,
  clusterWindowHours: 72,
  relevanceThreshold: 0.5,
  coldRelevanceThreshold: 0.4,
  coldStartDays: 14,
  learningStartedAt: 0,
  relevanceProfileWeight: 0.6,
  relevanceLearnedWeight: 0.4,
  sigSourcesWeight: 0.35,
  sigHnWeight: 0.2,
  sigReleaseWeight: 0.2,
  sigImpactWeight: 0.25,
  sourcesSaturate: 5,
  hnPointsFull: 500,
  otherNewsMinSignificance: 0.6,
  otherNewsCount: 4,
  coldOtherNewsCount: 5,
  pageSize: 15,
  emaAlpha: 0.1,
  signalWeights: {
    more: 1, interested: 1, save: 0.7, read: 0.6, open: 0.4, open_more: 0.2,
    ignored: -0.15, dismiss: -1, less: -1, less_source: -1, less_topic: -1,
  },
  otherNewsIgnoreFactor: 0.2,
  readFraction: 0.6,
  wordsPerMinute: 230,
  graduationOpens: 3,
  graduationDays: 30,
  graduationStep: 0.25,
  profileRewriteDays: 7,
  profileRewriteSignals: 50,
  enrichBatchSize: 5,
  seeded: false,
  lastProfileRewriteAt: 0,
  graduated: {},
};

/** The AI mode's own settings on top of the defaults. */
export const AI_SETTINGS: Partial<SectionsSettings> = {
  taxonomy: [
    'coding agents', 'developer tools', 'developer productivity', 'engineering organisations', 'model releases',
    'pricing and licensing', 'AI security', 'governance and policy', 'LLMs in production', 'evaluation', 'research',
    'open-weight models', 'infrastructure', 'enterprise adoption', 'funding and business', 'consumer AI',
    'image and video generation', 'robotics', 'AI safety',
  ],
};

export const AI_STARTER_PROFILE = `## Interested in
- AI-assisted software engineering practice
- Coding agents and tools
- Evidence on AI and developer productivity
- AI adoption in engineering organisations
- Model releases that change capability or cost
- Vendor pricing, licensing and terms changes
- AI security, governance and data handling in companies
- Building and running LLM features in production

## Not interested in
- Consumer AI gadgets
- Funding rounds under $100M
- Prompt-tip listicles
- AI image and video generation for creative use

## Sources I value

## Notes
- Reads as a software engineer and as a CTO, so both hands-on detail and organisational implications matter.
`;

/** Keywords for the Hacker News prefilter (whole words or phrases, ignoring case). */
export const HN_AI_KEYWORDS = [
  'AI', 'LLM', 'LLMs', 'GPT', 'ChatGPT', 'Claude', 'Anthropic', 'OpenAI', 'Gemini', 'DeepMind', 'Copilot', 'Cursor',
  'agent', 'agentic', 'model', 'machine learning', 'neural', 'transformer', 'inference', 'fine-tuning', 'RAG',
  'embedding', 'prompt', 'chatbot', 'Llama', 'Mistral', 'Qwen', 'DeepSeek', 'MCP', 'vibe coding', 'coding assistant',
  'AGI', 'diffusion', 'GPU', 'Nvidia', 'tokens',
];

const ai = (s: Omit<SourceInput, 'apiKeyRef' | 'role' | 'lean' | 'includeSections' | 'excludeSections' | 'enabled' | 'paywalled' | 'readerMode' | 'refreshMinutes'> & Partial<SourceInput>): SourceInput => ({
  apiKeyRef: null, role: 'primary', lean: 'centre', readerMode: 'extract', paywalled: false,
  includeSections: [], excludeSections: [], refreshMinutes: 60, enabled: true, modeId: AI_MODE_ID,
  priority: 'normal', isDigest: false, config: {},
  ...s,
});

/** The AI mode's sources on first run. Every URL was checked live on 24 Nov 2026 (docs/decisions.md §15). */
export const AI_DEFAULT_SOURCES: SourceInput[] = [
  ai({ name: "Simon Willison's Weblog", adapter: 'rss', endpoint: 'https://simonwillison.net/atom/everything/' }),
  ai({ name: 'Latent Space', adapter: 'rss', endpoint: 'https://latent.space/feeds/articles.xml' }),
  ai({
    name: 'AINews (smol.ai)', adapter: 'rss', endpoint: 'https://latent.space/feeds/news.xml',
    isDigest: true, priority: 'low', readerMode: 'browser', config: { maxPerIssue: 25 },
  }),
  ai({
    name: 'TLDR AI', adapter: 'rss', endpoint: 'https://tldr.tech/api/rss/ai',
    isDigest: true, priority: 'low', config: { maxPerIssue: 25 },
  }),
  ai({ name: 'Engineering Enablement (DX)', adapter: 'rss', endpoint: 'https://newsletter.getdx.com/feed' }),
  ai({
    name: 'The Pragmatic Engineer', adapter: 'rss', endpoint: 'https://newsletter.pragmaticengineer.com/feed',
    readerMode: 'browser', paywalled: true,
  }),
  ai({ name: 'Interconnects', adapter: 'rss', endpoint: 'https://www.interconnects.ai/feed' }),
  ai({ name: 'Import AI', adapter: 'rss', endpoint: 'https://importai.substack.com/feed' }),
  ai({
    name: 'Hacker News', adapter: 'hn_api',
    endpoint: 'https://hacker-news.firebaseio.com/v0/topstories.json\nhttps://hacker-news.firebaseio.com/v0/beststories.json',
    priority: 'low', refreshMinutes: 30, config: { minPoints: 150, keywords: HN_AI_KEYWORDS, limit: 60 },
  }),
  ai({
    name: 'Anthropic', adapter: 'html_list', endpoint: 'https://www.anthropic.com/news', priority: 'high',
    config: { linkPattern: '^/news/[a-z0-9][a-z0-9-]+$', minTitleWords: 4 },
  }),
  ai({ name: 'OpenAI', adapter: 'rss', endpoint: 'https://openai.com/news/rss.xml', priority: 'high' }),
  ai({
    name: 'Google (Gemini and DeepMind)', adapter: 'rss', priority: 'high',
    endpoint: 'https://blog.google/products-and-platforms/products/gemini/rss/\nhttps://deepmind.google/blog/rss.xml\nhttps://blog.google/innovation-and-ai/technology/ai/rss/',
  }),
  ai({ name: 'GitHub Copilot changelog', adapter: 'rss', endpoint: 'https://github.blog/changelog/label/copilot/feed/', priority: 'high' }),
  ai({ name: 'Cursor changelog', adapter: 'rss', endpoint: 'https://cursor.com/changelog/rss.xml', priority: 'high' }),
];

function rowToMode(r: any): Mode {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    order: r.sort_order,
    layout: safeJson<Layout>(r.layout, { type: 'news' }),
    createdAt: r.created_at,
  };
}

export async function listModes(db: Db): Promise<Mode[]> {
  return (await db.all('SELECT * FROM mode ORDER BY sort_order, id')).map(rowToMode);
}

export async function getMode(db: Db, id: number): Promise<Mode | null> {
  const r = await db.get('SELECT * FROM mode WHERE id = ?', [id]);
  return r ? rowToMode(r) : null;
}

export function isSections(m: Pick<Mode, 'layout'> | null | undefined): boolean {
  return m?.layout.type === 'sections';
}

/** A mode's raw stored settings (JSON object). */
export async function rawModeSettings(db: Db, modeId: number): Promise<Record<string, unknown>> {
  const r = await db.get<{ settings: string }>('SELECT settings FROM mode WHERE id = ?', [modeId]);
  return safeJson<Record<string, unknown>>(r?.settings, {});
}

/** Merges a patch into a mode's stored settings. */
export async function saveModeSettings(db: Db, modeId: number, patch: Record<string, unknown>): Promise<void> {
  await db.tx(async () => {
    const cur = await rawModeSettings(db, modeId);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) cur[k] = v;
    await db.run('UPDATE mode SET settings = ? WHERE id = ?', [JSON.stringify(cur), modeId]);
  });
}

/** A sections-layout mode's settings: stored values over the defaults, each checked for type. */
export async function loadSectionsSettings(db: Db, modeId: number): Promise<SectionsSettings> {
  const stored = await rawModeSettings(db, modeId);
  const out: any = { ...DEFAULT_SECTIONS_SETTINGS, signalWeights: { ...DEFAULT_SECTIONS_SETTINGS.signalWeights } };
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in DEFAULT_SECTIONS_SETTINGS)) continue;
    const def = (DEFAULT_SECTIONS_SETTINGS as any)[k];
    if (typeof v !== typeof def || Array.isArray(v) !== Array.isArray(def)) continue;
    out[k] = k === 'signalWeights' ? { ...out.signalWeights, ...(v as object) } : v;
  }
  return out as SectionsSettings;
}

export interface ModeDefinition {
  name: string;
  icon: string;
  layout: Layout;
  settings?: Partial<SectionsSettings>;
  sources?: SourceInput[];
  /** The starter interest profile (markdown with the four headings). */
  profile?: string;
}

/**
 * Adds a mode from a definition alone: its row, its sources and its starter profile. Nothing in
 * any other mode changes. Returns the new mode's id.
 */
export async function createMode(db: Db, def: ModeDefinition, now: number): Promise<number> {
  const next = await db.get<{ id: number; ord: number }>('SELECT COALESCE(MAX(id), 0) + 1 id, COALESCE(MAX(sort_order), 0) + 1 ord FROM mode');
  const id = next!.id;
  await db.run(
    'INSERT INTO mode(id, name, icon, sort_order, layout, settings, created_at) VALUES(?,?,?,?,?,?,?)',
    [id, def.name, def.icon, next!.ord, JSON.stringify(def.layout), JSON.stringify({ ...(def.settings ?? {}), seeded: true }), now],
  );
  for (const s of def.sources ?? []) await insertSource(db, { ...s, modeId: id });
  if (def.profile != null) await addProfileVersion(db, id, def.profile, [], 'user', now);
  return id;
}

/**
 * First run of a sections-layout mode that ships with the app (the AI mode): its default sources,
 * its settings and its starter profile, once. Deleting every source later does not bring them back.
 */
export async function seedModes(db: Db, now: number): Promise<void> {
  const stored = await rawModeSettings(db, AI_MODE_ID);
  if (stored.seeded) return;
  await db.tx(async () => {
    const have = await db.get<{ n: number }>('SELECT COUNT(*) n FROM source WHERE mode_id = ?', [AI_MODE_ID]);
    if (!have?.n) for (const s of AI_DEFAULT_SOURCES) await insertSource(db, s);
  });
  if (!(await getProfile(db, AI_MODE_ID))) await addProfileVersion(db, AI_MODE_ID, AI_STARTER_PROFILE, [], 'starter', now);
  await saveModeSettings(db, AI_MODE_ID, { ...AI_SETTINGS, seeded: true, learningStartedAt: (stored.learningStartedAt as number) || now });
}

/** Unseen-card counts for the mode bar are computed by the feed modules; this is the mode list with layout. */
export function sectionDefs(m: Mode): SectionDef[] {
  return m.layout.type === 'sections' ? m.layout.sections : [];
}
