import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errMsg } from '../core/util';
import { BudgetExceededError } from '../llm/openrouter';
import { NoTextError, SUMMARY_LEVELS, getSummary, savedLevels, summarise, type Summary, type SummaryLevel } from '../pipeline/summarise';
import { getDb } from '../platform/db';
import { llmDeps, reloadSettings } from '../platform/runner';
import { useTheme } from './theme';

const LEVELS: SummaryLevel[] = ['short', 'medium', 'long'];

/**
 * Summary of the article in the reader, at three lengths: Short (3 points), Medium (6 points) and
 * Long (2 paragraphs). Nothing is written until a length is tapped; each is written once, then
 * kept, and lengths already written are marked Saved.
 */
export function SummarySheet({ articleId, visible, onClose }: { articleId: number; visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // No length is chosen until one is tapped, so no tokens are spent on a summary not wanted.
  const [level, setLevel] = useState<SummaryLevel | null>(null);
  const [summaries, setSummaries] = useState<Partial<Record<SummaryLevel, Summary>>>({});
  const [errors, setErrors] = useState<Partial<Record<SummaryLevel, string>>>({});
  const [saved, setSaved] = useState<SummaryLevel[]>([]);
  const have = level != null && !!summaries[level];
  const failed = level != null && errors[level] != null;

  // Which lengths are already written (reading the store costs nothing).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getDb().then((db) => savedLevels(db, articleId)).then((lv) => {
      if (!cancelled) setSaved(lv);
    }, () => {});
    return () => {
      cancelled = true;
    };
  }, [visible, articleId]);

  // Fetches the summary at the chosen length (stored, or written now) when the sheet shows it.
  // "Neither a summary nor an error yet" is the loading state.
  useEffect(() => {
    if (!visible || level == null || have || failed) return;
    let cancelled = false;
    (async () => {
      const stored = await getSummary(await getDb(), articleId, level);
      return stored ?? summarise(await llmDeps(), articleId, level);
    })().then(
      (sum) => {
        if (cancelled) return;
        setSummaries((s) => ({ ...s, [level]: sum }));
        setSaved((x) => (x.includes(level) ? x : [...x, level]));
        reloadSettings().catch(() => {}); // the spend figure may have moved
      },
      (e) => {
        if (cancelled) return;
        const msg = e instanceof BudgetExceededError ? 'The monthly LLM budget is spent: summaries are paused until the 1st.'
          : e instanceof NoTextError ? e.message
            : errMsg(e);
        setErrors((x) => ({ ...x, [level]: msg }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, level, have, failed, articleId]);

  if (!visible) return null;
  const spec = level ? SUMMARY_LEVELS[level] : null;
  const current = level ? summaries[level] : undefined;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable testID="summary-backdrop" style={styles.backdrop} onPress={onClose} accessibilityLabel="Close summary" />
      <View testID="summary-sheet" style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.header}>
          <Text style={[styles.heading, { color: t.text }]}>Summary</Text>
          <Pressable testID="summary-close" hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
            <Ionicons name="close" size={22} color={t.muted} />
          </Pressable>
        </View>
        <View style={[styles.levels, { backgroundColor: t.strip }]} accessibilityRole="tablist">
          {LEVELS.map((lv) => {
            const on = lv === level;
            return (
              <Pressable
                key={lv}
                testID={`summary-${lv}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setLevel(lv)}
                style={[styles.level, on && { backgroundColor: t.card, borderColor: t.border }]}
              >
                <Text style={[styles.levelLabel, { color: on ? t.text : t.muted }]}>{SUMMARY_LEVELS[lv].label}</Text>
                <Text style={[styles.levelDetail, { color: t.faint }]}>
                  {SUMMARY_LEVELS[lv].detail}{saved.includes(lv) ? ' · saved' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 8 }}>
          {level == null ? (
            <Text testID="summary-choose" style={[styles.note, styles.choose, { color: t.muted }]}>
              Choose a length. It is written when you tap it, then kept, so opening it again is free.
            </Text>
          ) : current && spec ? (
            spec.form === 'bullets' ? (
              current.items.map((item, i) => (
                <View key={i} style={styles.bulletRow}>
                  <Text style={[styles.bullet, { color: t.accent }]}>•</Text>
                  <Text style={[styles.text, { color: t.text }]}>{item}</Text>
                </View>
              ))
            ) : (
              current.items.map((item, i) => (
                <Text key={i} style={[styles.text, styles.paragraph, { color: t.text }]}>{item}</Text>
              ))
            )
          ) : failed ? (
            <View style={styles.center}>
              <Text testID="summary-error" style={[styles.note, { color: t.muted }]}>{errors[level]}</Text>
              <Pressable testID="summary-retry" onPress={() => setErrors((x) => ({ ...x, [level]: undefined }))} style={[styles.retry, { borderColor: t.border }]}>
                <Text style={{ color: t.text, fontWeight: '600' }}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.center}>
              <ActivityIndicator color={t.accent} />
              <Text style={[styles.note, { color: t.muted }]}>Summarising…</Text>
            </View>
          )}
        </ScrollView>
        {current ? (
          <Text style={[styles.footer, { color: t.faint }]}>Written by AI from the article’s text. Check the article for anything that matters.</Text>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%',
    borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 14, paddingHorizontal: 18,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  heading: { fontSize: 18, fontWeight: '700' },
  levels: { flexDirection: 'row', borderRadius: 10, padding: 3, gap: 3, marginBottom: 14 },
  level: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  levelLabel: { fontSize: 14, fontWeight: '700' },
  levelDetail: { fontSize: 11, marginTop: 1 },
  body: { flexGrow: 0 },
  bulletRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  bullet: { fontSize: 16, lineHeight: 23, fontWeight: '800' },
  text: { flex: 1, fontSize: 16, lineHeight: 23, fontFamily: 'serif' },
  paragraph: { marginBottom: 12 },
  center: { alignItems: 'center', paddingVertical: 28, gap: 12 },
  choose: { paddingVertical: 18, paddingHorizontal: 8 },
  note: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  retry: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  footer: { fontSize: 11.5, lineHeight: 16, marginTop: 4 },
});
