import { bucketCounts, extractTerms, loadPulse, storyKind, type PulseHeadline } from '../src/core/pulse';
import { addRule } from '../src/core/topics';
import { HOUR, T0, feedUrl, setup } from './helpers/world';

const now = T0;
let nextId = 1;
const h = (title: string, hoursAgo: number, sourceId = 1): PulseHeadline => ({ id: nextId++, sourceId, title, publishedAt: now - hoursAgo * HOUR });

describe('Pulse keywords', () => {
  test('two-word names stand in for their words, plurals join, filler words are dropped', () => {
    const terms = extractTerms([
      h('Rachel Reeves defends budget as business groups react', 1, 1),
      h('Why Rachel Reeves says the budget will not raise income tax', 2, 2),
      h('Reeves Budget Leaves Pensioners Worse Off, Analysts Say', 3, 3),
      h('Tariffs on steel to rise, ministers warn', 1, 1),
      h('Steel tariff deal collapses', 5, 2),
      h('Gaza: ceasefire talks resume in Cairo', 0.5, 1),
      h('Ceasefire hopes rise as Gaza talks resume', 1.5, 3),
      h('Strictly star leaves show', 30, 2), // outside nothing (window is a day), but alone: under the minimum
    ], now, 24 * HOUR);
    const byKey = new Map(terms.map((t) => [t.key, t]));
    expect(byKey.get('rachel reeves')?.label).toBe('Rachel Reeves');
    // The surname alone is the same person: the Title Case "Reeves Budget..." headline joins the name.
    expect(byKey.get('rachel reeves')?.count).toBe(3);
    expect(byKey.has('reeves')).toBe(false);
    expect(byKey.get('budget')?.count).toBe(3);
    expect(byKey.get('budget')?.label).toBe('budget');
    expect(byKey.get('tariff')?.count).toBe(2);
    expect(byKey.get('steel')?.outlets).toBe(2);
    // Punctuation breaks a name: "Gaza: ceasefire" is not one.
    expect(byKey.has('gaza ceasefire')).toBe(false);
    expect(byKey.get('gaza')?.count).toBe(2);
    for (const stop of ['says', 'why', 'the', 'will', 'warn', 'say']) expect(byKey.has(stop)).toBe(false);
  });

  test('a name built on a word another name already took is not made from nothing', () => {
    const terms = extractTerms([
      h('Nvidia boss Jensen Huang returns to Taiwan', 1, 1),
      h('Jensen Huang returns with record results', 2, 2),
      h('Huang returns: what it means', 3, 3),
      h('Jensen Huang interview', 4, 4),
    ], now, 24 * HOUR);
    const keys = terms.map((t) => t.key);
    expect(keys).toContain('jensen huang');
    expect(terms.find((t) => t.key === 'jensen huang')!.count).toBe(4);
    expect(keys).not.toContain('huang return');
    expect(keys).not.toContain('huang');
  });

  test('size follows how many headlines and outlets; heat follows how recent', () => {
    const terms = extractTerms([
      h('Floods hit Valencia again', 0.2, 1), h('Valencia floods: thousands evacuated', 0.5, 2), h('Valencia mourns', 1, 3),
      h('Election recount ordered', 20, 1), h('Election recount begins', 22, 1),
    ], now, 24 * HOUR);
    const v = terms.find((t) => t.key === 'valencia')!;
    const e = terms.find((t) => t.key === 'election recount')!;
    expect(v.weight).toBeGreaterThan(e.weight);
    expect(v.heat).toBeGreaterThan(0.8);
    expect(e.heat).toBeLessThan(0.2);
    expect(v.rising).toBe(true);
    expect(e.rising).toBe(false);
    expect(terms[0].key).toBe('valencia');
    expect(v.articleIds).toHaveLength(3);
  });

  test('acronyms keep their capitals; the same headline twice from one outlet counts once', () => {
    const terms = extractTerms([
      h('NHS waiting lists grow', 1, 1), h('NHS waiting lists grow', 1.1, 1), h('Strikes at NHS trusts', 2, 2),
      h('US and EU agree terms', 1, 1), h('EU leaders meet', 2, 3),
    ], now, 24 * HOUR);
    const nhs = terms.find((t) => t.key === 'nhs')!;
    expect(nhs.label).toBe('NHS');
    expect(nhs.count).toBe(2);
    expect(terms.find((t) => t.key === 'eu')?.label).toBe('EU');
  });

  test('hidden words are left out, and form no names; a hidden name goes as a whole', () => {
    const heads = [
      h('UK economy shrinks', 1, 1), h('UK economy: what next', 2, 2), h('The UK votes', 3, 3),
      h('USA and UK sign pact', 1, 1), h('USA trade talks', 2, 2),
      h('Keir Starmer visits Leeds', 1, 1), h('Keir Starmer under pressure', 2, 2),
    ];
    const keys = (hidden: string[]) => extractTerms(heads, now, 24 * HOUR, 40, hidden).map((t) => t.key);
    expect(keys([])).toEqual(expect.arrayContaining(['uk', 'usa', 'uk economy', 'keir starmer']));
    const hiddenSome = keys(['UK', 'U.S.A.', 'keir starmer']);
    expect(hiddenSome).toContain('economy');
    for (const k of ['uk', 'usa', 'uk economy', 'keir starmer']) expect(hiddenSome).not.toContain(k);
  });

  test('each word takes the kind of story most of its headlines are', () => {
    expect(storyKind('Politics')).toBe('politics');
    expect(storyKind('US politics')).toBe('politics');
    expect(storyKind('World news')).toBe('world');
    expect(storyKind('Football')).toBe('sport');
    expect(storyKind('Television & radio')).toBe('culture');
    expect(storyKind('Environment')).toBe('science');
    expect(storyKind('Money')).toBe('business');
    expect(storyKind('UK news', ['Opinion'])).toBe('other');
    expect(storyKind(null, ['Business', 'Retail'])).toBe('business');
    const terms = extractTerms([
      { ...h('Budget leaves pensioners worse off', 1, 1), section: 'Politics' },
      { ...h('Budget: markets rally', 2, 2), section: 'Business' },
      { ...h('Budget reaction', 3, 3), section: 'Politics' },
      { ...h('Budget explained', 3, 4) }, // no section: no vote
    ], now, 24 * HOUR);
    expect(terms.find((t) => t.key === 'budget')?.kind).toBe('politics');
  });

  test('headline counts per hour, oldest first', () => {
    const counts = bucketCounts([h('a', 0.1), h('b', 0.9), h('c', 5.5), h('d', 30)], now, 6 * HOUR, HOUR);
    expect(counts).toEqual([1, 0, 0, 0, 0, 2]);
  });

  test('from the database: every enabled source, muted topics left out', async () => {
    const s = await setup();
    s.world.addGuardian([
      { title: 'Heathrow expansion approved', topic: 1, hoursAgo: 1 },
      { title: 'Strictly final: who won', topic: 2, hoursAgo: 1 },
    ]);
    s.world.addFeed(feedUrl('BBC News'), [
      { title: 'Heathrow expansion: what happens next', topic: 1, hoursAgo: 2 },
      { title: 'Strictly final draws record audience', topic: 2, hoursAgo: 2 },
    ]);
    await s.run();
    await addRule(s.db, 'mute', 'strictly', null, s.world.now);
    const p = await loadPulse(s.db, s.world.now, 24 * HOUR);
    expect(p.terms.map((t) => t.label)).toEqual(['Heathrow expansion']);
    expect(p.headlines).toBe(2);
    expect(p.outlets).toBe(2);
    expect(p.buckets).toHaveLength(24);
  });
});
