import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  forgetFeature, loadLearned, nudgeFeature, readingDiet,
  type DietLine, type LearnedGroup, type LearnedItem, type ReadingDiet,
} from '../../core/learned';
import { getDb } from '../../platform/db';
import { bumpData, showSnack } from '../../state/store';
import { Group, SectionTitle } from '../../ui/kit';
import { useTheme, type Theme } from '../../ui/theme';

/** A count with a bar scaled to the largest in its list, and last week's figure for comparison. */
function DietRows({ t, lines }: { t: Theme; lines: DietLine[] }) {
  const max = Math.max(1, ...lines.map((l) => Math.max(l.thisWeek, l.lastWeek)));
  return (
    <Group>
      {lines.map((l) => (
        <View key={l.label} style={[styles.dietRow, { borderBottomColor: t.border }]}>
          <Text style={[styles.dietLabel, { color: t.text }]} numberOfLines={1}>{l.label}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.bar, { backgroundColor: t.accent, width: `${(l.thisWeek / max) * 100}%` }]} />
          </View>
          <Text style={[styles.dietCount, { color: t.text }]}>{l.thisWeek}</Text>
          <Text style={[styles.dietPrev, { color: t.faint }]}>{l.lastWeek}</Text>
        </View>
      ))}
    </Group>
  );
}

/** How strongly something is liked or disliked, in words rather than a log ratio. */
function strength(effect: number): string {
  const e = Math.abs(effect);
  return e > 1.6 ? 'Strong' : e > 0.7 ? 'Clear' : 'Slight';
}

async function forgetNow(key: string): Promise<void> {
  await forgetFeature(await getDb(), key, Date.now());
}

async function nudgeNow(key: string, dir: 1 | -1): Promise<void> {
  await nudgeFeature(await getDb(), key, dir, Date.now());
}

export default function LearnedScreen() {
  const t = useTheme();
  const [groups, setGroups] = useState<LearnedGroup[] | null>(null);
  const [diet, setDiet] = useState<ReadingDiet | null>(null);

  const load = useCallback(async () => {
    const db = await getDb();
    const now = Date.now();
    const [g, d] = await Promise.all([loadLearned(db, now), readingDiet(db, now)]);
    setGroups(g);
    setDiet(d);
  }, []);
  useFocusEffect(useCallback(() => {
    load().catch(() => setGroups([]));
  }, [load]));

  // Each change re-ranks what is waiting in the feed, so the lists reload.
  const changed = async (message: string) => {
    await load();
    bumpData();
    showSnack(message);
  };
  const forget = async (it: LearnedItem) => {
    await forgetNow(it.key);
    await changed(`Forgotten: ${it.label}`);
  };
  const nudge = async (it: LearnedItem, dir: 1 | -1) => {
    await nudgeNow(it.key, dir);
    await changed(dir > 0 ? `More of ${it.label}` : `Less of ${it.label}`);
  };

  const action = (label: string, testID: string, onPress: () => void) => (
    <Pressable testID={testID} accessibilityRole="button" hitSlop={6} onPress={onPress} style={[styles.action, { borderColor: t.border }]}>
      <Text style={{ color: t.text, fontSize: 12.5, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
  const item = (it: LearnedItem) => (
    <View key={it.key} testID={`learned-${it.key}`} style={[styles.item, { borderBottomColor: t.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: t.text }]} numberOfLines={2}>{it.label}</Text>
        <Text style={{ color: it.effect > 0 ? t.green : t.red, fontSize: 12.5, marginTop: 2 }}>
          {`${strength(it.effect)} ${it.effect > 0 ? 'like' : 'dislike'}`}
        </Text>
      </View>
      {action('More', `learned-more-${it.key}`, () => nudge(it, 1))}
      {action('Less', `learned-less-${it.key}`, () => nudge(it, -1))}
      {action('Forget', `learned-forget-${it.key}`, () => forget(it))}
    </View>
  );

  return (
    <ScrollView testID="learned-screen" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 60 }}>
      <SectionTitle>What you read</SectionTitle>
      {diet && diet.thisWeek + diet.lastWeek > 0 ? (
        <View>
          <Text testID="diet-total" style={[styles.intro, { color: t.muted, marginTop: 0 }]}>
            {`${diet.thisWeek} articles read in the last seven days; ${diet.lastWeek} in the seven before. Each row shows this week, then last week.`}
          </Text>
          <SectionTitle>By section</SectionTitle>
          <DietRows t={t} lines={diet.sections} />
          <SectionTitle>By source</SectionTitle>
          <DietRows t={t} lines={diet.sources} />
          <SectionTitle>By the lean you gave each source</SectionTitle>
          <DietRows t={t} lines={diet.leans} />
        </View>
      ) : (
        <Text style={[styles.intro, { color: t.faint, marginTop: 0 }]}>Nothing read in the last two weeks yet.</Text>
      )}

      <SectionTitle>What the ranking has learned</SectionTitle>
      <Text style={[styles.intro, { color: t.muted, marginTop: 0 }]}>
        Built from what you open, finish, save, like and swipe away, fading over 30 days. More and Less count like the same
        choice on a card; Forget removes that one preference. The app also learns from the wording of what you read, which
        cannot be shown as a list: Reset learning in Settings clears that.
      </Text>
      {groups && !groups.length ? (
        <Text testID="learned-empty" style={[styles.intro, { color: t.faint }]}>Nothing learned yet. It fills as you read.</Text>
      ) : null}
      {(groups ?? []).map((g) => (
        <View key={g.kind}>
          <SectionTitle>{g.title}</SectionTitle>
          <Group>
            {g.liked.map(item)}
            {g.disliked.map(item)}
          </Group>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 13, lineHeight: 19, marginHorizontal: 20, marginTop: 8 },
  dietRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  dietLabel: { width: 118, fontSize: 14 },
  barTrack: { flex: 1, height: 8 },
  bar: { height: 8, borderRadius: 4, minWidth: 2 },
  dietCount: { width: 26, textAlign: 'right', fontSize: 14, fontWeight: '700' },
  dietPrev: { width: 26, textAlign: 'right', fontSize: 13 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  itemLabel: { fontSize: 15 },
  action: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
});
