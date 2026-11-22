/**
 * A small fake internet for pipeline tests: RSS feeds, a Guardian-style API, article pages and an
 * OpenRouter-compatible endpoint with deterministic embeddings, all behind one fetch function.
 */
import { insertSource, type Secrets } from '../../src/core/sources';
import type { FetchFn, SourceInput } from '../../src/core/types';
import { OPENROUTER_KEY_REF, refresh, type RefreshDeps } from '../../src/pipeline/refresh';
import { freshDb, memorySecrets } from './nodeDb';

export const DIMS = 64;
export const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
export const HOUR = 3600_000;

export type ChatPurpose = 'match' | 'digest' | 'story' | 'briefing' | 'compare';

export interface Story {
  title: string;
  /** Stories on the same topic get near-identical embeddings. */
  topic: number;
  /** Cosine similarity to the topic's axis (default 0.97). */
  sim?: number;
  summary?: string;
  section?: string;
  hoursAgo?: number;
  url?: string;
  tone?: string;
  tags?: string[];
  image?: string;
  wordCount?: number;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function makeVector(topic: number, sim: number, salt: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[topic % 32] = sim;
  // The remainder goes on an axis unique to the article, so two articles on a topic have cosine sim1*sim2.
  v[32 + (salt % 32)] = Math.sqrt(Math.max(0, 1 - sim * sim));
  return v;
}

export class World {
  now = T0;
  feeds = new Map<string, Story[]>();
  guardian: Story[] = [];
  pages = new Map<string, string>();
  broken = new Set<string>();
  vectors = new Map<string, number[]>();
  chatCalls: { purpose: ChatPurpose; user: string }[] = [];
  embedCalls = 0;
  /** Override to script the model. Return a string to send as the reply. */
  onChat: (purpose: ChatPurpose, user: string) => string = (purpose, user) => {
    if (purpose === 'match') return JSON.stringify({ match_id: 'c1', same_event: true, angle_note: 'Leads on the cost to taxpayers; quotes the opposition.' });
    if (purpose === 'story') return JSON.stringify({ summary: 'The new coverage reports a further development in the story.' });
    if (purpose === 'compare') return JSON.stringify({ agree: 'All report the same announcement.', differ: 'One leads on cost; another on the reaction.' });
    if (purpose === 'briefing') {
      const ids = Array.from(user.matchAll(/^STORY (s\d+)$/gm)).map((m) => m[1]);
      return JSON.stringify({ items: ids.map((id) => ({ id, sentence: `Outlets report story ${id}.` })) });
    }
    return JSON.stringify({ covered_by_primary: false, summary: 'Several outlets report a story the primary source has not run.' });
  };
  chatCost = 0.002;
  private salt = 0;

  private register(base: string, s: Story): Story {
    const withUrl = { ...s, url: s.url ?? `${base}/${slug(s.title)}` };
    const text = withUrl.summary ? `${withUrl.title}\n${withUrl.summary}` : withUrl.title;
    this.vectors.set(text, makeVector(s.topic, s.sim ?? 0.97, this.salt++));
    return withUrl;
  }

  addFeed(url: string, stories: Story[]): void {
    const base = url.replace(/\/[^/]*$/, '');
    const list = this.feeds.get(url) ?? [];
    list.push(...stories.map((s) => this.register(base, s)));
    this.feeds.set(url, list);
  }

  addGuardian(stories: Story[]): void {
    this.guardian.push(...stories.map((s) => this.register('https://www.theguardian.test/news', s)));
  }

  private rss(stories: Story[]): string {
    const items = stories.map((s) => `
      <item>
        <title><![CDATA[${s.title}]]></title>
        <link>${s.url}?utm_source=rss&amp;utm_medium=feed</link>
        <description><![CDATA[${s.summary ?? ''}]]></description>
        <pubDate>${new Date(this.now - (s.hoursAgo ?? 1) * HOUR).toUTCString()}</pubDate>
        ${s.section ? `<category>${s.section}</category>` : ''}
        ${s.image ? `<media:thumbnail url="${s.image}" width="240" height="135"/>` : ''}
      </item>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Feed</title>${items}</channel></rss>`;
  }

  private guardianJson(url: string) {
    const from = /from-date=([^&]+)/.exec(url);
    const since = from ? Date.parse(decodeURIComponent(from[1])) : 0;
    const results = this.guardian
      .filter((s) => this.now - (s.hoursAgo ?? 1) * HOUR >= since)
      .map((s) => ({
        id: s.url!.replace('https://www.theguardian.test/', ''),
        type: s.tone === 'live' ? 'liveblog' : 'article',
        sectionId: slug(s.section ?? 'news'),
        sectionName: s.section ?? 'News',
        webPublicationDate: new Date(this.now - (s.hoursAgo ?? 1) * HOUR).toISOString(),
        webTitle: s.title,
        webUrl: s.url,
        fields: { headline: s.title, trailText: s.summary ?? '', byline: 'Staff Writer', wordcount: String(s.wordCount ?? 800), thumbnail: s.image ?? 'https://media.test/thumb.jpg' },
        tags: [
          { id: `tone/${s.tone ?? 'news'}`, type: 'tone', webTitle: s.tone ?? 'News' },
          ...(s.tags ?? []).map((t) => ({ id: `kw/${slug(t)}`, type: 'keyword', webTitle: t })),
        ],
      }));
    return { response: { status: 'ok', total: results.length, pages: 1, currentPage: 1, results } };
  }

  fetch: FetchFn = async (url, init = {}) => {
    const reply = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    });
    const bare = url.split('?')[0];
    if (this.broken.has(bare) || this.broken.has(url)) return reply(503, 'Service unavailable');

    if (url.includes('/embeddings')) {
      this.embedCalls++;
      const body = JSON.parse(init.body ?? '{}');
      const data = (body.input as string[]).map((text, index) => ({
        index,
        embedding: this.vectors.get(text) ?? makeVector(31, 0.5, 900 + (text.length % 30)),
      }));
      return reply(200, { data, usage: { prompt_tokens: 10 * data.length, total_tokens: 10 * data.length, cost: 0.00001 } });
    }
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(init.body ?? '{}');
      const system: string = body.messages[0].content;
      const purpose: ChatPurpose = system.includes('CANDIDATE') ? 'match'
        : system.includes('FOLLOWED STORY') ? 'story'
          : system.includes('NEWS BRIEFING') ? 'briefing'
            : system.includes('COMPARE COVERAGE') ? 'compare' : 'digest';
      const user: string = body.messages[1].content;
      this.chatCalls.push({ purpose, user });
      return reply(200, {
        choices: [{ message: { role: 'assistant', content: this.onChat(purpose, user) } }],
        usage: { prompt_tokens: 900, completion_tokens: 60, cost: this.chatCost },
      });
    }
    if (bare.startsWith('https://content.guardianapis.test/search')) {
      if (!/api-key=good-guardian-key/.test(url)) return reply(401, { message: 'Unauthorized' });
      return reply(200, this.guardianJson(url));
    }
    if (bare.startsWith('https://content.guardianapis.test/')) {
      const id = bare.replace('https://content.guardianapis.test/', '');
      const s = this.guardian.find((g) => g.url!.endsWith(id));
      if (!s) return reply(404, { message: 'not found' });
      const blocks = Array.from({ length: 25 }, (_, i) => ({
        id: `b${i}`, title: `Update ${25 - i}`, bodyHtml: `<p>Live update number ${25 - i} with enough words to count as text.</p>`,
        firstPublishedDate: new Date(this.now - i * 60000).toISOString(),
      }));
      return reply(200, {
        response: {
          status: 'ok',
          content: {
            id,
            fields: { body: `<p>API body for ${s.title}. ${'This is the body text from the content API. '.repeat(12)}</p>`, thumbnail: s.image ?? 'https://media.test/thumb.jpg' },
            blocks: { requestedBodyBlocks: { 'body:latest:20': blocks.slice(0, 20) } },
          },
        },
      });
    }
    const feed = this.feeds.get(bare);
    if (feed) return reply(200, this.rss(feed));
    const page = this.pages.get(bare);
    if (page != null) return reply(200, page);
    return reply(404, 'Not found');
  };
}

export const SRC = {
  guardian: {
    name: 'Guardian', adapter: 'guardian_content_api', endpoint: 'https://content.guardianapis.test/search',
    apiKeyRef: 'source_key_guardian', role: 'primary', lean: 'left', readerMode: 'extract', paywalled: false,
    includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
  } as SourceInput,
  rss(name: string, lean: SourceInput['lean'], extra: Partial<SourceInput> = {}): SourceInput {
    return {
      name, adapter: 'rss', endpoint: `https://${slug(name)}.test/rss.xml`, apiKeyRef: null, role: 'perspective', lean,
      readerMode: 'extract', paywalled: false, includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
      ...extra,
    };
  },
};

export function feedUrl(name: string) {
  return `https://${slug(name)}.test/rss.xml`;
}

/** A database with the Guardian as primary plus the given perspective sources, and a world to feed them. */
export async function setup(perspectives: SourceInput[] = [
  SRC.rss('BBC News', 'centre'),
  SRC.rss('The Telegraph', 'right', { readerMode: 'browser', paywalled: true }),
  SRC.rss('Daily Mail', 'right'),
  SRC.rss('Daily Express', 'right'),
]) {
  const db = await freshDb();
  const world = new World();
  const secrets = memorySecrets({ [OPENROUTER_KEY_REF]: 'sk-or-test-key-123456', source_key_guardian: 'good-guardian-key' });
  const ids: Record<string, number> = {};
  ids.Guardian = await insertSource(db, SRC.guardian);
  for (const p of perspectives) ids[p.name] = await insertSource(db, p);
  const deps: RefreshDeps = {
    db, fetch: world.fetch, secrets: secrets as Secrets, now: () => world.now, files: null, isWifi: async () => true,
  };
  const run = (trigger: Parameters<typeof refresh>[1] = 'manual') => refresh(deps, trigger);
  return { db, world, secrets, ids, deps, run };
}
