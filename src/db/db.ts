export type Param = string | number | null | Uint8Array;

/** Minimal async SQLite surface. Implemented by expo-sqlite on the phone and better-sqlite3 in Jest. */
export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: Param[]): Promise<{ changes: number; lastInsertRowId: number }>;
  all<T = any>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = any>(sql: string, params?: Param[]): Promise<T | null>;
  /** Runs fn inside a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
}

export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE source (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    adapter TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    api_key_ref TEXT,
    role TEXT NOT NULL,
    lean TEXT NOT NULL,
    reader_mode TEXT NOT NULL,
    paywalled INTEGER NOT NULL DEFAULT 0,
    include_sections TEXT NOT NULL DEFAULT '[]',
    exclude_sections TEXT NOT NULL DEFAULT '[]',
    refresh_minutes INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_ok_at INTEGER,
    last_error TEXT,
    last_fetch_at INTEGER,
    last_new_at INTEGER
  );
  CREATE TABLE article (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    external_id TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    published_at INTEGER NOT NULL,
    section TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    tone TEXT,
    byline TEXT,
    word_count INTEGER,
    embedding BLOB,
    cluster_id INTEGER,
    body_html TEXT,
    body_source TEXT,
    body_tried_at INTEGER,
    adapter_body TEXT,
    offline_images TEXT,
    fetched_at INTEGER NOT NULL,
    ready_at INTEGER,
    score_a REAL NOT NULL DEFAULT 0,
    score_s REAL NOT NULL DEFAULT 0,
    score_i REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX article_source_pub ON article(source_id, published_at);
  CREATE INDEX article_pub ON article(published_at);
  CREATE INDEX article_cluster ON article(cluster_id);
  CREATE TABLE cluster (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    last_article_at INTEGER NOT NULL,
    centroid BLOB,
    size INTEGER NOT NULL DEFAULT 0,
    has_primary INTEGER NOT NULL DEFAULT 0,
    outlet_count INTEGER NOT NULL DEFAULT 0,
    right_outlet_count INTEGER NOT NULL DEFAULT 0,
    digest_status TEXT,
    digest_summary TEXT,
    digest_checked TEXT,
    digest_at INTEGER
  );
  CREATE INDEX cluster_created ON cluster(created_at);
  CREATE TABLE impression (
    article_id INTEGER PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    scored INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX impression_seen ON impression(first_seen_at);
  CREATE TABLE interaction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    dwell_seconds REAL,
    max_scroll_pct REAL
  );
  CREATE INDEX interaction_article ON interaction(article_id, kind);
  CREATE TABLE second_source (
    primary_article_id INTEGER PRIMARY KEY,
    other_article_id INTEGER,
    angle_note TEXT,
    similarity REAL,
    method TEXT,
    checked_at INTEGER NOT NULL
  );
  CREATE TABLE match_pair (
    primary_article_id INTEGER NOT NULL,
    other_article_id INTEGER NOT NULL,
    similarity REAL NOT NULL,
    same_event INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (primary_article_id, other_article_id)
  );
  CREATE TABLE read_later (
    article_id INTEGER PRIMARY KEY,
    saved_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE TABLE feature_stat (
    feature_key TEXT PRIMARY KEY,
    positive_weight REAL NOT NULL DEFAULT 0,
    negative_weight REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE centroid (
    key TEXT PRIMARY KEY,
    vector BLOB NOT NULL,
    weight REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL
  );
  CREATE INDEX llm_usage_at ON llm_usage(at);
  CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE refresh_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    trigger TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    new_articles INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_id INTEGER,
    summary TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX decision_kind_at ON decision_log(kind, at);
  `,
  // 2: the Guardian without Guardian Australia (production office "aus"). Pieces from it already
  // fetched but never seen, saved or acted on are dropped; anything in History stays.
  `
  UPDATE source SET endpoint = 'https://content.guardianapis.com/search?production-office=-aus'
   WHERE adapter = 'guardian_content_api' AND endpoint = 'https://content.guardianapis.com/search';
  CREATE TEMP TABLE drop_aus AS
    SELECT a.id FROM article a JOIN source s ON s.id = a.source_id AND s.adapter = 'guardian_content_api'
     WHERE a.tags LIKE '%"australia-news"%'
       AND a.id NOT IN (SELECT article_id FROM impression)
       AND a.id NOT IN (SELECT article_id FROM read_later)
       AND a.id NOT IN (SELECT article_id FROM interaction);
  DELETE FROM second_source WHERE primary_article_id IN (SELECT id FROM drop_aus) OR other_article_id IN (SELECT id FROM drop_aus);
  DELETE FROM match_pair WHERE primary_article_id IN (SELECT id FROM drop_aus) OR other_article_id IN (SELECT id FROM drop_aus);
  DELETE FROM article WHERE id IN (SELECT id FROM drop_aus);
  DROP TABLE drop_aus;
  `,
  // 3: followed stories, mute and watch lists, catch-up briefings, coverage comparisons.
  `
  CREATE TABLE story (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    centroid BLOB NOT NULL,
    followed_at INTEGER NOT NULL,
    last_checked_at INTEGER NOT NULL,
    update_summary TEXT,
    update_n INTEGER NOT NULL DEFAULT 0,
    update_at INTEGER
  );
  CREATE TABLE story_article (
    story_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, article_id)
  );
  CREATE INDEX story_article_article ON story_article(article_id);
  CREATE TABLE topic_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    term TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE TABLE briefing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    since_at INTEGER NOT NULL,
    items TEXT NOT NULL,
    dismissed_at INTEGER
  );
  CREATE TABLE coverage_note (
    key TEXT PRIMARY KEY,
    agree TEXT NOT NULL,
    differ TEXT NOT NULL,
    outlets INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  `,
  // 4: US perspective sources, the New York Times and the Wall Street Journal. Only on an existing
  // install: a fresh one gets them from the defaults (adding them here first would stop the
  // defaults being seeded at all). Skipped if a source of that name is already there.
  `
  INSERT INTO source(name, adapter, endpoint, api_key_ref, role, lean, reader_mode, paywalled,
                     include_sections, exclude_sections, refresh_minutes, enabled)
  SELECT 'The New York Times', 'rss',
         'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' || char(10) || 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml',
         NULL, 'perspective', 'left', 'browser', 1, '[]', '[]', 30, 1
   WHERE EXISTS (SELECT 1 FROM source) AND NOT EXISTS (SELECT 1 FROM source WHERE name = 'The New York Times');
  INSERT INTO source(name, adapter, endpoint, api_key_ref, role, lean, reader_mode, paywalled,
                     include_sections, exclude_sections, refresh_minutes, enabled)
  SELECT 'The Wall Street Journal', 'rss',
         'https://feeds.content.dowjones.io/public/rss/RSSWorldNews' || char(10) || 'https://feeds.content.dowjones.io/public/rss/RSSUSnews',
         NULL, 'perspective', 'centre', 'browser', 1, '[]', '[]', 30, 1
   WHERE EXISTS (SELECT 1 FROM source) AND NOT EXISTS (SELECT 1 FROM source WHERE name = 'The Wall Street Journal');
  `,
  // 5: article summaries written on request, one per article and length.
  `
  CREATE TABLE article_summary (
    article_id INTEGER NOT NULL,
    level TEXT NOT NULL,
    items TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (article_id, level)
  );
  `,
];

export async function migrate(db: Db): Promise<void> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    await db.tx(async () => {
      await db.exec(sql);
      await db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
}

/**
 * Serialised transactions over a single connection: one BEGIN..COMMIT at a time, rolled back on
 * error. Transactions must not be nested.
 */
export function makeTx(exec: (sql: string) => Promise<void>): Db['tx'] {
  let queue: Promise<unknown> = Promise.resolve();
  return function tx<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      await exec('BEGIN IMMEDIATE');
      try {
        const out = await fn();
        await exec('COMMIT');
        return out;
      } catch (e) {
        try {
          await exec('ROLLBACK');
        } catch {}
        throw e;
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  };
}

export function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}
