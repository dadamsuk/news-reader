import type { Db } from '../db/db';
import { blobToVec, cosine, safeJson } from './util';

export interface DebugCluster {
  id: number;
  size: number;
  outletCount: number;
  rightOutletCount: number;
  hasPrimary: boolean;
  digestStatus: string | null;
  members: { title: string; source: string; similarity: number | null }[];
}

/** Recent multi-article clusters with each member's similarity to the centroid. */
export async function recentClusters(db: Db, limit = 25): Promise<DebugCluster[]> {
  const clusters = await db.all<any>(
    'SELECT * FROM cluster WHERE size >= 2 ORDER BY last_article_at DESC LIMIT ?',
    [limit],
  );
  const out: DebugCluster[] = [];
  for (const c of clusters) {
    const centroid = blobToVec(c.centroid);
    const members = await db.all<any>(
      `SELECT a.title, a.embedding, s.name FROM article a LEFT JOIN source s ON s.id = a.source_id
       WHERE a.cluster_id = ? ORDER BY a.published_at DESC LIMIT 12`,
      [c.id],
    );
    out.push({
      id: c.id,
      size: c.size,
      outletCount: c.outlet_count,
      rightOutletCount: c.right_outlet_count,
      hasPrimary: !!c.has_primary,
      digestStatus: c.digest_status ?? null,
      members: members.map((m) => {
        const v = blobToVec(m.embedding);
        return { title: m.title, source: m.name ?? '?', similarity: v && centroid ? cosine(v, centroid) : null };
      }),
    });
  }
  return out;
}

export interface DebugDecision {
  id: number;
  at: number;
  kind: string;
  summary: string;
  detail: unknown;
}

export async function recentDecisions(db: Db, kinds: string[], limit = 40): Promise<DebugDecision[]> {
  const rows = await db.all<any>(
    `SELECT * FROM decision_log WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`,
    [...kinds, limit],
  );
  return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, summary: r.summary, detail: safeJson<unknown>(r.detail, null) }));
}

export async function counts(db: Db): Promise<Record<string, number>> {
  const one = async (sql: string) => (await db.get<{ n: number }>(sql))?.n ?? 0;
  return {
    articles: await one('SELECT COUNT(*) n FROM article'),
    embedded: await one('SELECT COUNT(*) n FROM article WHERE embedding IS NOT NULL'),
    withBody: await one('SELECT COUNT(*) n FROM article WHERE body_html IS NOT NULL'),
    clusters: await one('SELECT COUNT(*) n FROM cluster'),
    seen: await one('SELECT COUNT(*) n FROM impression'),
    secondSources: await one('SELECT COUNT(*) n FROM second_source WHERE other_article_id IS NOT NULL'),
    llmCalls: await one("SELECT COUNT(*) n FROM llm_usage WHERE purpose != 'embedding'"),
  };
}
