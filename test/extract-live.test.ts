/**
 * Live check of reader extraction: one or two current articles per free outlet.
 * Skipped unless LIVE=1 and LIVE_DB points at a database written by live.test.ts.
 */
import Database from 'better-sqlite3';
import { extractArticle } from '../src/reader/extract';
import { nodeFetch } from './helpers/nodeDb';

const on = process.env.LIVE === '1' && !!process.env.LIVE_DB;

(on ? test : test.skip)('extraction on live pages', async () => {
  const db = new Database(process.env.LIVE_DB!, { readonly: true });
  const lines: string[] = [];
  let ok = 0;
  let total = 0;
  for (const name of ['Guardian', 'BBC News', 'Daily Mail', 'Daily Express', 'The Sun', 'GB News']) {
    const rows = db.prepare("SELECT a.url, a.title FROM article a JOIN source s ON s.id=a.source_id WHERE s.name=? AND a.url NOT LIKE '%/live/%' AND a.url NOT LIKE '%/video%' ORDER BY (a.url LIKE '%alaska-bering%' OR a.url LIKE '%timmy-the-whale%') DESC, a.published_at DESC LIMIT 2").all(name) as any[];
    for (const r of rows) {
      total++;
      const t0 = Date.now();
      const html = await (await nodeFetch(r.url)).text();
      const t1 = Date.now();
      const ex = extractArticle(html, r.url);
      if (ex) ok++;
      lines.push(`\n## ${name} | page ${(html.length / 1024) | 0}KB fetch ${t1 - t0}ms extract ${Date.now() - t1}ms\n${r.title}\n` +
        (ex ? `text ${ex.textLength} chars, ${ex.images.length} images, byline ${ex.byline}\n${ex.html.slice(0, 380)}
  page figures: ${(html.match(/<figure/g) ?? []).length}\n  imgs: ${ex.images.slice(0, 3).join('\n        ')}` : 'EXTRACTION FAILED'));
    }
  }
  console.log(lines.join('\n'));
  expect(ok).toBeGreaterThanOrEqual(total - 2);
}, 180000);
