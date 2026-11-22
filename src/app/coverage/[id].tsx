import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { loadCoverage, type Coverage, type CoverageRow } from '../../core/coverage';
import { followStory, storyOfArticle } from '../../core/stories';
import { ageLabel, errMsg } from '../../core/util';
import { BudgetExceededError } from '../../llm/openrouter';
import { compareCoverage } from '../../pipeline/extras';
import { getDb } from '../../platform/db';
import { openArticle } from '../../platform/open';
import { llmDeps, reloadSettings } from '../../platform/runner';
import { bumpData, getState, showSnack } from '../../state/store';
import { Button, Empty } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

/**
 * Full coverage: every outlet's piece on one story, side by side, with an optional note from the
 * model on where they agree and where they differ.
 */
export default function CoverageScreen() {
  const t = useTheme();
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const id = Number(idParam);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [missing, setMissing] = useState(false);
  const [storyId, setStoryId] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const db = await getDb();
    const c = await loadCoverage(db, id);
    if (!c) {
      setMissing(true);
      return;
    }
    setCov(c);
    setStoryId(await storyOfArticle(db, id));
    setNow(Date.now());
  }, [id]);

  // Also on coming back to the screen, so a story followed or unfollowed elsewhere shows correctly.
  useFocusEffect(useCallback(() => {
    load().catch(() => setMissing(true));
  }, [load]));

  const open = useCallback((row: CoverageRow) => {
    openArticle(row.article.id, 'coverage').catch(() => showSnack('Could not open the article'));
  }, []);

  const compare = async () => {
    setComparing(true);
    try {
      await compareCoverage(await llmDeps(), id);
      await load();
      reloadSettings().catch(() => {}); // the spend figure moved
    } catch (e) {
      showSnack(e instanceof BudgetExceededError ? 'The monthly LLM budget is spent: comparisons are paused until the 1st.' : errMsg(e));
    } finally {
      setComparing(false);
    }
  };

  const follow = async () => {
    try {
      const db = await getDb();
      if (storyId != null) {
        router.push({ pathname: '/story/[id]', params: { id: String(storyId) } });
        return;
      }
      setStoryId(await followStory(db, id, getState().settings.followThreshold, Date.now()));
      bumpData();
      showSnack('Following this story');
    } catch (e) {
      showSnack(errMsg(e));
    }
  };

  if (missing) return <Empty title="That article is no longer stored" />;
  if (!cov) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const several = cov.outletCount > 1;
  const stale = !!cov.note && cov.outletCount > cov.note.outlets;

  return (
    <ScrollView testID="coverage-screen" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: t.text }]}>{cov.title}</Text>
        <Text testID="coverage-count" style={[styles.meta, { color: t.faint }]}>
          {several ? `${cov.outletCount} outlets, ${cov.rows.length} articles` : 'No other outlet has covered this story yet'}
        </Text>
      </View>

      {cov.note ? (
        <View testID="coverage-note" style={[styles.note, { backgroundColor: t.card, borderColor: t.border }]}>
          <Text style={[styles.noteLabel, { color: t.accent }]}>WHERE THEY AGREE</Text>
          <Text style={[styles.noteText, { color: t.text }]}>{cov.note.agree}</Text>
          <Text style={[styles.noteLabel, { color: t.accent, marginTop: 12 }]}>WHERE THEY DIFFER</Text>
          <Text style={[styles.noteText, { color: t.text }]}>{cov.note.differ}</Text>
          <Text style={[styles.noteFoot, { color: t.faint }]}>
            {`Written by the model from ${cov.note.outlets} outlets' headlines and summaries, ${ageLabel(cov.note.at, now)} ago.`}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {several && (!cov.note || stale) ? (
          <Button
            testID="coverage-compare"
            small
            kind="secondary"
            busy={comparing}
            title={stale ? 'Compare again (more outlets)' : 'Compare the coverage'}
            onPress={compare}
          />
        ) : null}
        <Button
          testID="coverage-follow"
          small
          kind="secondary"
          title={storyId != null ? 'Following: open story' : 'Follow this story'}
          onPress={follow}
        />
      </View>

      {cov.rows.map((r) => (
        <View key={r.article.id} style={styles.rowWrap}>
          <Pressable
            testID={`coverage-${r.article.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${r.sourceName}: ${r.article.title}`}
            onPress={() => open(r)}
            android_ripple={{ color: t.border }}
            style={[styles.row, { backgroundColor: t.card, borderColor: r.isThis ? t.accent : t.border }]}
          >
            <View style={styles.rowMeta}>
              <Text style={[styles.source, { color: t.accent }]}>{r.sourceName.toUpperCase()}</Text>
              <Text style={[styles.age, { color: t.faint }]}>{ageLabel(r.article.publishedAt, now)}</Text>
              <View style={{ flex: 1 }} />
              {r.paywalled ? <Ionicons name="open-outline" size={15} color={t.faint} /> : null}
            </View>
            <Text style={[styles.headline, { color: t.text }]}>{r.article.title}</Text>
            {r.article.summary ? <Text style={[styles.summary, { color: t.muted }]} numberOfLines={3}>{r.article.summary}</Text> : null}
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 4 },
  title: { fontSize: 21, lineHeight: 27, fontWeight: '700', fontFamily: 'serif' },
  meta: { fontSize: 13, marginTop: 8 },
  note: { marginHorizontal: 12, marginTop: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  noteLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7, marginBottom: 5 },
  noteText: { fontSize: 15, lineHeight: 22 },
  noteFoot: { fontSize: 12, lineHeight: 17, marginTop: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 12, paddingVertical: 14 },
  rowWrap: { paddingHorizontal: 12, paddingBottom: 10 },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 13 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  source: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  age: { fontSize: 12, marginLeft: 8 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '700', fontFamily: 'serif' },
  summary: { fontSize: 14, lineHeight: 20, marginTop: 5 },
});
