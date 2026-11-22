import type { Settings } from '../core/settings';
import type { FetchFn } from '../core/types';
import { errMsg, monthStart, normalize, safeJson } from '../core/util';
import type { Db } from '../db/db';

export interface LlmDeps {
  db: Db;
  fetch: FetchFn;
  settings: Settings;
  apiKey: string | null;
  now: () => number;
}

export class BudgetExceededError extends Error {
  constructor() {
    super('Monthly LLM budget reached');
  }
}

export async function monthSpend(db: Db, now: number): Promise<number> {
  const row = await db.get<{ total: number | null }>('SELECT SUM(cost_usd) total FROM llm_usage WHERE at >= ?', [monthStart(now)]);
  return row?.total ?? 0;
}

/** True when chat (Haiku) calls must stop until the 1st of next month. */
export async function overBudget(db: Db, settings: Settings, now: number): Promise<boolean> {
  return (await monthSpend(db, now)) >= settings.monthlyBudgetUsd;
}

async function recordUsage(
  d: LlmDeps, model: string, purpose: string, usage: any, priceIn: number, priceOut: number,
): Promise<void> {
  const input = Number(usage?.prompt_tokens ?? usage?.total_tokens ?? 0) || 0;
  const output = Number(usage?.completion_tokens ?? 0) || 0;
  const reported = typeof usage?.cost === 'number' && usage.cost > 0 ? usage.cost : null;
  const cost = reported ?? (input * priceIn + output * priceOut) / 1_000_000;
  await d.db.run(
    'INSERT INTO llm_usage(at, model, purpose, input_tokens, output_tokens, cost_usd) VALUES(?,?,?,?,?,?)',
    [d.now(), model, purpose, input, output, cost],
  );
}

async function post(d: LlmDeps, path: string, body: unknown, timeoutMs: number): Promise<any> {
  if (!d.apiKey) throw new Error('No OpenRouter key set');
  const res = await d.fetch(d.settings.openrouterBaseUrl.replace(/\/+$/, '') + path, {
    method: 'POST',
    timeoutMs,
    headers: {
      Authorization: `Bearer ${d.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'News Reader',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message ?? '';
    } catch {}
    throw new Error(errMsg(`OpenRouter HTTP ${res.status}${detail ? `: ${detail}` : ''}`, [d.apiKey]));
  }
  const json = await res.json();
  if (json?.error) throw new Error(errMsg(`OpenRouter: ${json.error.message ?? 'error'}`, [d.apiKey]));
  return json;
}

const EMBED_BATCH = 96;

/** Embeds texts in batches. Returns L2-normalised vectors in input order. */
export async function embedTexts(d: LlmDeps, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  const dims = d.settings.embeddingDimensions;
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH).map((t) => t.slice(0, 2000) || ' ');
    const body: any = { model: d.settings.embeddingModel, input: batch };
    if (dims > 0) body.dimensions = dims;
    const json = await post(d, '/embeddings', body, 60000);
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    if (data.length !== batch.length) throw new Error('Embedding response has the wrong number of vectors');
    const sorted = data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const row of sorted) {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) throw new Error('Embedding response is malformed');
      let v = Float32Array.from(row.embedding as number[]);
      if (dims > 0 && v.length > dims) v = v.slice(0, dims);
      out.push(normalize(v));
    }
    await recordUsage(d, d.settings.embeddingModel, 'embedding', json.usage, d.settings.priceEmbedIn, 0);
  }
  return out;
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and stray prose). */
export function extractJson(text: string): unknown {
  const t = String(text ?? '').trim();
  const direct = safeJson<unknown>(t, undefined);
  if (direct !== undefined && direct !== null && typeof direct === 'object') return direct;
  const start = t.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return safeJson<unknown>(t.slice(start, i + 1), undefined);
    }
  }
  return undefined;
}

export interface ChatJsonResult<T> {
  value: T | null;
  raw: string;
  error?: string;
}

/**
 * One chat call at temperature 0 that must answer with JSON matching `validate`.
 * Retries once on invalid JSON, then gives up (value null). Throws BudgetExceededError at the cap.
 */
export async function chatJson<T>(
  d: LlmDeps,
  opts: { purpose: string; system: string; user: string; validate: (v: unknown) => T | null; maxTokens?: number },
): Promise<ChatJsonResult<T>> {
  let raw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await overBudget(d.db, d.settings, d.now())) throw new BudgetExceededError();
    const messages = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ];
    if (attempt === 1) {
      messages.push({ role: 'assistant', content: raw.slice(0, 1000) || '(empty)' });
      messages.push({ role: 'user', content: 'That was not valid. Reply with only the JSON object in the required shape, nothing else.' });
    }
    const json = await post(d, '/chat/completions', {
      model: d.settings.chatModel,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 300,
      messages,
      usage: { include: true },
    }, 45000);
    await recordUsage(d, d.settings.chatModel, opts.purpose, json.usage, d.settings.priceChatIn, d.settings.priceChatOut);
    const content = json?.choices?.[0]?.message?.content;
    raw = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : '';
    const value = opts.validate(extractJson(raw));
    if (value !== null) return { value, raw };
  }
  return { value: null, raw, error: 'invalid JSON after one retry' };
}

/** Cheap authenticated call used to validate a key at setup. */
export async function validateOpenRouterKey(fetchFn: FetchFn, baseUrl: string, key: string): Promise<string | null> {
  try {
    const res = await fetchFn(baseUrl.replace(/\/+$/, '') + '/key', {
      timeoutMs: 15000,
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return null;
    if (res.status === 401 || res.status === 403) return 'OpenRouter rejected this key.';
    return `OpenRouter answered HTTP ${res.status}.`;
  } catch (e) {
    return `Could not reach OpenRouter: ${errMsg(e, [key])}`;
  }
}
