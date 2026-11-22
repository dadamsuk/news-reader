import { DEFAULT_SOURCES, listSources, seedDefaultSources } from '../src/core/sources';
import { MIGRATIONS, migrate } from '../src/db/db';
import { openNodeDb } from './helpers/nodeDb';

describe('migrations', () => {
  test('2: the Guardian drops Guardian Australia; unseen Australia pieces go, seen or saved ones stay', async () => {
    const db = openNodeDb();
    // A database as it was before migration 2.
    await db.exec(MIGRATIONS[0]);
    await db.exec('PRAGMA user_version = 1');
    const src = await db.run(
      `INSERT INTO source(name, adapter, endpoint, role, lean, reader_mode, paywalled, include_sections, exclude_sections, refresh_minutes, enabled)
       VALUES('Guardian', 'guardian_content_api', 'https://content.guardianapis.com/search', 'primary', 'left', 'extract', 0, '[]', '[]', 30, 1)`,
    );
    const add = async (title: string, tags: string[]) =>
      (await db.run(
        'INSERT INTO article(source_id, canonical_url, url, title, published_at, tags, fetched_at) VALUES(?,?,?,?,?,?,?)',
        [src.lastInsertRowId, `https://x/${title}`, `https://x/${title}`, title, 1, JSON.stringify(tags), 1],
      )).lastInsertRowId;
    await add('aus unseen', ['australia-news', 'Queensland']);
    const seen = await add('aus seen', ['australia-news']);
    const saved = await add('aus saved', ['australia-news']);
    await add('uk', ['uk-news']);
    await db.run("INSERT INTO impression(article_id, first_seen_at, session_id, surface) VALUES(?, 1, 's', 'feed')", [seen]);
    await db.run('INSERT INTO read_later(article_id, saved_at) VALUES(?, 1)', [saved]);

    await migrate(db);

    expect((await db.get<{ endpoint: string }>('SELECT endpoint FROM source'))!.endpoint)
      .toBe('https://content.guardianapis.com/search?production-office=-aus');
    expect((await db.all<{ title: string }>('SELECT title FROM article ORDER BY id')).map((r) => r.title))
      .toEqual(['aus seen', 'aus saved', 'uk']);
    expect((await db.get<{ user_version: number }>('PRAGMA user_version'))!.user_version).toBe(MIGRATIONS.length);
  });

  test('2: an endpoint the user has edited is left alone', async () => {
    const db = openNodeDb();
    await db.exec(MIGRATIONS[0]);
    await db.exec('PRAGMA user_version = 1');
    await db.run(
      `INSERT INTO source(name, adapter, endpoint, role, lean, reader_mode, paywalled, include_sections, exclude_sections, refresh_minutes, enabled)
       VALUES('Guardian', 'guardian_content_api', 'https://content.guardianapis.com/search?section=politics', 'primary', 'left', 'extract', 0, '[]', '[]', 30, 1)`,
    );
    await migrate(db);
    expect((await db.get<{ endpoint: string }>('SELECT endpoint FROM source'))!.endpoint)
      .toBe('https://content.guardianapis.com/search?section=politics');
  });

  test('4: adds the NYT and WSJ to an existing install, once, and leaves a fresh install to the defaults', async () => {
    const existing = openNodeDb();
    for (let i = 0; i < 3; i++) await existing.exec(MIGRATIONS[i]);
    await existing.exec('PRAGMA user_version = 3');
    await existing.run(
      `INSERT INTO source(name, adapter, endpoint, role, lean, reader_mode, paywalled, include_sections, exclude_sections, refresh_minutes, enabled)
       VALUES('Guardian', 'guardian_content_api', 'https://content.guardianapis.com/search', 'primary', 'left', 'extract', 0, '[]', '[]', 30, 1)`,
    );
    await migrate(existing);
    await migrate(existing); // a second run adds nothing
    const added = (await listSources(existing)).filter((x) => x.name !== 'Guardian');
    const nyt = DEFAULT_SOURCES.find((x) => x.name === 'The New York Times')!;
    const wsj = DEFAULT_SOURCES.find((x) => x.name === 'The Wall Street Journal')!;
    expect(added.map((x) => [x.name, x.endpoint, x.role, x.lean, x.readerMode, x.paywalled])).toEqual([
      [nyt.name, nyt.endpoint, 'perspective', 'left', 'browser', true],
      [wsj.name, wsj.endpoint, 'perspective', 'centre', 'browser', true],
    ]);

    const fresh = openNodeDb();
    await migrate(fresh);
    await seedDefaultSources(fresh);
    const names = (await listSources(fresh)).map((x) => x.name);
    expect(names).toHaveLength(DEFAULT_SOURCES.length); // every default, each once
    expect(names).toEqual(expect.arrayContaining(['Guardian', 'The New York Times', 'The Wall Street Journal', 'BBC News']));
  });
});
