import Constants from 'expo-constants';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { counts, recentClusters, recentDecisions, type DebugCluster, type DebugDecision } from '../../core/debug';
import type { RefreshRun } from '../../core/types';
import { ageLabel } from '../../core/util';
import { listRuns } from '../../pipeline/refresh';
import { backgroundStatus, triggerBackgroundForTesting } from '../../platform/background';
import { getDb } from '../../platform/db';
import { runRefresh } from '../../platform/runner';
import { showSnack, useStore } from '../../state/store';
import { Button, Group, Row, SectionTitle } from '../../ui/kit';
import { auditReport, type AuditReport } from '../../ui/seen';
import { useTheme } from '../../ui/theme';

const E2E = !!Constants.expoConfig?.extra?.e2e;

function time(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function DebugScreen() {
  const t = useTheme();
  const dataVersion = useStore((s) => s.dataVersion);
  const refreshing = useStore((s) => s.refreshing);
  const extractFailures = useStore((s) => s.settings.extractFailures);
  const feedReadyMs = useStore((s) => s.feedReadyMs);
  const [runs, setRuns] = useState<RefreshRun[]>([]);
  const [clusters, setClusters] = useState<DebugCluster[]>([]);
  const [decisions, setDecisions] = useState<DebugDecision[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [bg, setBg] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [audit, setAudit] = useState<AuditReport | null>(null);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    (async () => {
      const db = await getDb();
      const next = {
        runs: await listRuns(db, 20),
        clusters: await recentClusters(db),
        decisions: await recentDecisions(db, ['match', 'digest', 'extract']),
        stats: await counts(db),
        bg: await backgroundStatus(),
      };
      if (!alive) return;
      setRuns(next.runs);
      setClusters(next.clusters);
      setDecisions(next.decisions);
      setStats(next.stats);
      setBg(next.bg);
      setNow(Date.now());
      if (E2E) setAudit(auditReport());
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [dataVersion]);

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const mono = { fontFamily: 'monospace', fontSize: 11.5, lineHeight: 16, color: t.muted } as const;

  return (
    <ScrollView testID="debug-screen" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 60 }}>
      <SectionTitle>Status</SectionTitle>
      <Group>
        <Row
          testID="debug-counts"
          title={`${stats.articles ?? 0} articles, ${stats.clusters ?? 0} clusters`}
          subtitle={`${stats.embedded ?? 0} embedded · ${stats.withBody ?? 0} with text · ${stats.seen ?? 0} seen · ${stats.secondSources ?? 0} second sources · ${stats.llmCalls ?? 0} model calls`}
        />
        <Row testID="debug-extract-failures" title={`Extraction failures: ${extractFailures}`} subtitle="Pages where the reader could not pull out the article" />
        <Row testID="debug-background" title="Background refresh" subtitle={bg} />
        <Row
          testID="debug-launch"
          title={feedReadyMs == null ? 'Launch: feed not shown yet' : feedReadyMs < 0 ? 'Launch: began at setup (not timed)' : `Launch: cached feed ready in ${feedReadyMs} ms`}
          subtitle="From the app's code starting to the stored feed being loaded, this launch"
        />
        {audit ? (
          <Row
            testID="debug-seen-audit"
            title={audit.ok ? `Seen rule audit: OK (${audit.seen} seen, ${audit.peeked} under half)` : 'Seen rule audit: FAILED'}
            subtitle={audit.ok ? 'Checked against card geometry this session' : `Missed: ${audit.missed.join(' | ') || 'none'}. Wrongly marked: ${audit.wrong.join(' | ') || 'none'}`}
          />
        ) : null}
      </Group>
      <View style={styles.buttons}>
        <Button testID="debug-refresh" style={{ flex: 1 }} title="Refresh now" kind="secondary" busy={refreshing} onPress={() => runRefresh('manual').catch(() => {})} />
        <Button
          testID="debug-trigger-background"
          style={{ flex: 1 }}
          title="Run background task"
          kind="secondary"
          onPress={async () => showSnack((await triggerBackgroundForTesting()) ? 'Background task triggered' : 'Only available in development builds')}
        />
      </View>

      <SectionTitle>Last {runs.length} refresh runs</SectionTitle>
      <Group>
        {runs.map((r) => {
          const failed = r.steps.filter((s) => !s.ok).length;
          const total = r.finishedAt ? `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s` : 'unfinished';
          return (
            <View key={r.id}>
              <Row
                testID={`debug-run-${r.trigger}`}
                title={`${time(r.startedAt)}  ${r.trigger}`}
                subtitle={`${total} · ${r.newArticles} new${failed ? ` · ${failed} step${failed > 1 ? 's' : ''} failed` : ''}`}
                danger={failed > 0}
                onPress={() => toggle(`run${r.id}`)}
              />
              {open[`run${r.id}`] ? (
                <View style={[styles.detail, { backgroundColor: t.strip }]}>
                  {r.steps.map((s, i) => (
                    <Text key={i} style={[mono, !s.ok && { color: t.red }]}>
                      {s.ok ? '✓' : '✗'} {s.name}  {s.ms}ms{'\n'}   {s.ok ? s.info : s.error}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
        {!runs.length ? <Row title="No refresh has run yet" /> : null}
      </Group>

      <SectionTitle>Recent clusters</SectionTitle>
      <Group>
        {clusters.map((c) => (
          <View key={c.id}>
            <Row
              title={c.members[0]?.title ?? `Cluster ${c.id}`}
              subtitle={`${c.size} articles · ${c.outletCount} outlets · ${c.rightOutletCount} right${c.hasPrimary ? ' · primary' : ''}${c.digestStatus ? ` · digest: ${c.digestStatus}` : ''}`}
              onPress={() => toggle(`c${c.id}`)}
            />
            {open[`c${c.id}`] ? (
              <View style={[styles.detail, { backgroundColor: t.strip }]}>
                {c.members.map((m, i) => (
                  <Text key={i} style={mono}>
                    {m.similarity != null ? m.similarity.toFixed(3) : '  –  '}  {m.source}: {m.title}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ))}
        {!clusters.length ? <Row title="No multi-article clusters yet" /> : null}
      </Group>

      <SectionTitle>Recent match and digest decisions</SectionTitle>
      <Group>
        {decisions.map((d) => (
          <View key={d.id}>
            <Row title={d.summary} subtitle={`${d.kind} · ${ageLabel(d.at, now)} ago`} onPress={() => toggle(`d${d.id}`)} />
            {open[`d${d.id}`] ? (
              <Pressable style={[styles.detail, { backgroundColor: t.strip }]} onPress={() => toggle(`d${d.id}`)}>
                <Text style={mono} selectable>{JSON.stringify(d.detail, null, 2)}</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {!decisions.length ? <Row title="No decisions logged yet" /> : null}
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', gap: 10, marginHorizontal: 12, marginTop: 12 },
  detail: { paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
});
