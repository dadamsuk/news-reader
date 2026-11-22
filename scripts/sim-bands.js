// Prints sample cross-outlet headline pairs per cosine-similarity band, to tune thresholds on real data.
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
const rows = db.prepare('SELECT a.id, a.title, a.embedding, s.name FROM article a JOIN source s ON s.id=a.source_id WHERE embedding IS NOT NULL').all();
const vecs = rows.map(r => new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)));
const bands = {};
for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
  if (rows[i].name === rows[j].name) continue;
  let s = 0; const a = vecs[i], b = vecs[j]; for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  if (s < 0.5) continue;
  const band = (Math.floor(s * 20) / 20).toFixed(2);
  (bands[band] = bands[band] || []).push([s, i, j]);
}
for (const band of Object.keys(bands).sort()) {
  const list = bands[band];
  console.log(`\n=== ${band} (${list.length} pairs)`);
  const step = Math.max(1, Math.floor(list.length / 9));
  for (let k = 0; k < list.length && k < step * 9; k += step) {
    const [s, i, j] = list[k];
    console.log(`${s.toFixed(3)} | ${rows[i].name}: ${rows[i].title.slice(0, 95)}\n      | ${rows[j].name}: ${rows[j].title.slice(0, 95)}`);
  }
}
