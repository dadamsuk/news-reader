import { loadSettings } from '../src/core/settings';
import type { LlmDeps } from '../src/llm/openrouter';
import {
  NoTextError, SUMMARY_LEVELS, getSummary, savedLevels, summarise, summaryFromText, validateSummary,
} from '../src/pipeline/summarise';
import { setup } from './helpers/world';

const BODY = `<p>${'The council approved the new budget after a long debate about funding for schools and roads. '.repeat(20)}</p>`;

async function world() {
  const s = await setup([]);
  s.world.addGuardian([{ title: 'Council passes budget', topic: 1 }]);
  await s.run();
  const { id } = (await s.db.get<{ id: number }>("SELECT id FROM article WHERE title = 'Council passes budget'"))!;
  await s.db.run('UPDATE article SET body_html = ? WHERE id = ?', [BODY, id]);
  s.world.chatCalls.length = 0;
  const llm = async (): Promise<LlmDeps> => ({
    db: s.db, fetch: s.world.fetch, settings: await loadSettings(s.db), apiKey: 'sk-or-test-key-123456', now: () => s.world.now,
  });
  return { ...s, id, llm };
}

describe('article summaries', () => {
  test('validation: enough items (extras dropped), marks stripped, long items accepted', () => {
    const short = validateSummary(SUMMARY_LEVELS.short);
    expect(short({ items: ['- One.', '• Two.', '3. Three.'] })).toEqual({ items: ['One.', 'Two.', 'Three.'] });
    expect(short({ items: ['One.', 'Two.', 'Three.', 'Four.'] })).toEqual({ items: ['One.', 'Two.', 'Three.'] });
    expect(short({ items: ['One.', 'Two.'] })).toBeNull();
    expect(short({ items: ['One.', 'Two.', ''] })).toBeNull();
    expect(short({ items: ['One.', 'Two.', 'word '.repeat(60)] })).not.toBeNull();
    expect(validateSummary(SUMMARY_LEVELS.long)({ items: ['Para one.', 'Para two.'] })).toEqual({ items: ['Para one.', 'Para two.'] });
  });

  test('a reply that is not valid JSON is read as text', () => {
    // An unescaped quotation mark from the article breaks the JSON.
    const broken = '{"items": ["The PM said "no" to the plan.", "Second.", "Third."]}';
    expect(validateSummary(SUMMARY_LEVELS.short)(undefined)).toBeNull();
    expect(summaryFromText(broken, SUMMARY_LEVELS.short)).toBeNull();
    // Cut off at the length cap: the finished items are kept, the unfinished one is not.
    const cut = '{"items": ["£2bn NHS cut", "Vote Tuesday", "40 Labour rebels", "Unions';
    expect(summaryFromText(cut, SUMMARY_LEVELS.short)).toEqual(['£2bn NHS cut', 'Vote Tuesday', '40 Labour rebels']);
    expect(summaryFromText(cut, SUMMARY_LEVELS.medium)).toBeNull(); // 3 of 6 is not a summary
    const lines = (...l: string[]) => l.join('\n');
    expect(summaryFromText(lines('Here you go:', '- The PM said "no".', '- Second point.', '* Third point.'), SUMMARY_LEVELS.short))
      .toEqual(['The PM said "no".', 'Second point.', 'Third point.']);
    expect(summaryFromText(lines('1. One.', '2) Two.', '3. Three.', '4. Four.'), SUMMARY_LEVELS.short)).toEqual(['One.', 'Two.', 'Three.']);
    const para = (n: number) => `Paragraph ${n} ${'with enough words to be a real paragraph of text '.repeat(3)}`.trim();
    expect(summaryFromText(lines(para(1), '', para(2)), SUMMARY_LEVELS.long)).toEqual([para(1), para(2)]);
  });

  test('3 points, 6 points or 2 paragraphs; each written once from the article text, then kept', async () => {
    const s = await world();
    s.world.onChat = (_purpose: string, user: string) => {
      const n = /exactly (\d+) (bullet points|paragraphs)/.exec(user)!;
      return JSON.stringify({ items: Array.from({ length: Number(n[1]) }, (_, i) => `${n[2]} ${i + 1}.`) });
    };
    const short = await summarise(await s.llm(), s.id, 'short');
    expect(short.items).toEqual(['bullet points 1.', 'bullet points 2.', 'bullet points 3.']);
    expect(s.world.chatCalls).toHaveLength(1);
    expect(s.world.chatCalls[0].user).toContain('council approved the new budget');
    expect(s.world.chatCalls[0].user).toContain('Headline: Council passes budget');

    expect((await summarise(await s.llm(), s.id, 'medium')).items).toHaveLength(6);
    expect((await summarise(await s.llm(), s.id, 'long')).items).toEqual(['paragraphs 1.', 'paragraphs 2.']);
    expect(s.world.chatCalls).toHaveLength(3);

    // Asked again: from the store, no model call.
    expect((await summarise(await s.llm(), s.id, 'short')).items).toEqual(short.items);
    expect(await getSummary(s.db, s.id, 'medium')).not.toBeNull();
    expect(s.world.chatCalls).toHaveLength(3);
  });

  test('an article without stored text is not sent to the model', async () => {
    const s = await world();
    await s.db.run('UPDATE article SET body_html = NULL WHERE id = ?', [s.id]);
    await expect(summarise(await s.llm(), s.id, 'short')).rejects.toBeInstanceOf(NoTextError);
    expect(s.world.chatCalls).toHaveLength(0);
  });

  test('an unusable answer is retried once, then reported and logged for Debug; nothing is stored', async () => {
    const s = await world();
    s.world.onChat = () => JSON.stringify({ items: ['Only one point.'] });
    await expect(summarise(await s.llm(), s.id, 'short')).rejects.toThrow(/could not use/);
    expect(s.world.chatCalls).toHaveLength(2);
    expect(await getSummary(s.db, s.id, 'short')).toBeNull();
    const log = await s.db.get<{ summary: string; detail: string }>("SELECT summary, detail FROM decision_log WHERE kind = 'summary'");
    expect(log!.summary).toMatch(/Unusable short summary: Council passes budget/);
    expect(JSON.parse(log!.detail).raw).toContain('Only one point.');
  });

  test('a broken-JSON reply with readable points still gives a summary, in one call', async () => {
    const s = await world();
    s.world.onChat = () => ['- First "quoted" point.', '- Second point.', '- Third point.'].join('\n');
    const sum = await summarise(await s.llm(), s.id, 'short');
    expect(sum.items).toEqual(['First "quoted" point.', 'Second point.', 'Third point.']);
    expect(await savedLevels(s.db, s.id)).toEqual(['short']);
  });

  test('summaries go when their article is deleted by retention', async () => {
    const s = await world();
    s.world.onChat = () => JSON.stringify({ items: ['A.', 'B.', 'C.'] });
    await summarise(await s.llm(), s.id, 'short');
    s.world.now += 30 * 24 * 3600_000;
    await s.run();
    expect(await s.db.get('SELECT 1 x FROM article WHERE id = ?', [s.id])).toBeFalsy();
    expect(await getSummary(s.db, s.id, 'short')).toBeNull();
  });
});
