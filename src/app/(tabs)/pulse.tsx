import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  STORY_KINDS, loadPulse, loadPulseHeadlines, pulseKey, type Pulse, type PulseRow, type PulseTerm, type StoryKind,
} from '../../core/pulse';
import { HOUR } from '../../core/types';
import { ageLabel } from '../../core/util';
import { getDb } from '../../platform/db';
import { openArticle } from '../../platform/open';
import { runRefresh, updateSettings } from '../../platform/runner';
import { getState, showSnack, useStore } from '../../state/store';
import { mix } from '../../ui/ArticleCard';
import { useTheme, type Theme } from '../../ui/theme';

const WINDOWS = [
  { label: '6 hours', ms: 6 * HOUR },
  { label: '24 hours', ms: 24 * HOUR },
  { label: '3 days', ms: 72 * HOUR },
];
const MIN_FONT = 14;
const MAX_FONT = 42;

/**
 * Freshness colour: faint grey for coverage that has gone quiet, the accent red for coverage that
 * is all from the last hour or two. One hue, light to strong, so it reads as "how hot", not a category.
 * The gamma spreads the middle of the range, where most words sit.
 */
const heatColour = (t: Theme, heat: number) => mix(t.faint, t.accent, Math.pow(Math.max(0, Math.min(1, heat)), 0.6));

/**
 * Hue: what kind of story a word appears in. Six hues plus grey, stepped separately for each theme so
 * every one reads as text on the card (at least 3.6:1 light, 4:1 dark) and no two are confusable with
 * normal colour vision (OKLab ΔE >= 15 on every pair, checked with the dataviz validator). Six hues
 * cannot all be told apart with red-green colour blindness, so the kind is never colour alone: each
 * word's sheet and spoken label name it, and the legend lists them.
 */
const KIND_COLOURS: Record<'light' | 'dark', Record<Exclude<StoryKind, 'other'>, string>> = {
  light: { politics: '#BF2B40', world: '#5D77FE', business: '#C1701C', science: '#1B6C1E', culture: '#824C84', sport: '#10958F' },
  dark: { politics: '#E2424E', world: '#5275F5', business: '#B18835', science: '#13A314', culture: '#B56FBA', sport: '#009AA5' },
};
const kindColour = (t: Theme, kind: StoryKind) => (kind === 'other' ? t.muted : KIND_COLOURS[t.dark ? 'dark' : 'light'][kind]);
const kindLabel = (kind: StoryKind) => STORY_KINDS.find((k) => k.kind === kind)?.label ?? 'Other';

/**
 * Intensity: how fresh the coverage is. A word at full strength is all from the last hour or two;
 * quieter ones fade towards the card, never below 40% so they stay readable.
 */
const FADE_FLOOR = 0.4;
const strength = (heat: number) => FADE_FLOOR + (1 - FADE_FLOOR) * Math.pow(Math.max(0, Math.min(1, heat)), 0.6);
const wordColour = (t: Theme, term: PulseTerm) => mix(t.card, kindColour(t, term.kind), strength(term.heat));

/** Biggest words in the middle: the list is dealt alternately to either side of the first. */
function centreOut<T>(items: T[]): T[] {
  const left: T[] = [];
  const right: T[] = [];
  items.forEach((it, i) => (i % 2 ? left : right).push(it));
  return [...left.reverse(), ...right];
}

function windowLabel(ms: number) {
  return WINDOWS.find((w) => w.ms === ms)?.label ?? `${Math.round(ms / HOUR)} hours`;
}

export default function PulseScreen() {
  const t = useTheme();
  const dataVersion = useStore((s) => s.dataVersion);
  const [windowMs, setWindowMs] = useState(24 * HOUR);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pulling, setPulling] = useState(false);
  const [open, setOpen] = useState<PulseTerm | null>(null);
  const [editingHidden, setEditingHidden] = useState(false);
  const hidden = useStore((s) => s.settings.pulseHidden);

  const load = useCallback(async () => {
    const at = Date.now();
    const p = await loadPulse(await getDb(), at, windowMs, hidden);
    setPulse(p);
    setNow(at);
  }, [windowMs, hidden]);

  /** Hides a word or name from Pulse (it stays in the feeds). Undo puts it back. */
  const hide = useCallback(async (label: string) => {
    const before = getState().settings.pulseHidden;
    if (before.some((h) => pulseKey(h) === pulseKey(label))) return;
    await updateSettings({ pulseHidden: [...before, label] });
    showSnack(`Hidden from Pulse: ${label}`, 'UNDO', () => {
      const current = getState().settings.pulseHidden;
      updateSettings({ pulseHidden: current.filter((h) => pulseKey(h) !== pulseKey(label)) }).catch(() => {});
    });
  }, []);

  // On showing the tab, on a new window, and whenever a refresh brings in headlines while it shows.
  useFocusEffect(useCallback(() => {
    load().catch(() => {});
    // dataVersion is the reload trigger, not something the callback reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, dataVersion]));

  const onPull = useCallback(async () => {
    setPulling(true);
    try {
      await runRefresh('manual');
      await load();
    } finally {
      setPulling(false);
    }
  }, [load]);

  const layout = useMemo(() => {
    if (!pulse?.terms.length) return [];
    const ws = pulse.terms.map((x) => x.weight);
    const lo = Math.min(...ws);
    const hi = Math.max(...ws);
    // Area, not height, should follow the count: the font size goes with its square root.
    const size = (w: number) => (hi === lo ? (MIN_FONT + MAX_FONT) / 2 : MIN_FONT + (MAX_FONT - MIN_FONT) * Math.sqrt((w - lo) / (hi - lo)));
    return centreOut(pulse.terms.map((term) => ({ term, size: Math.round(size(term.weight)) })));
  }, [pulse]);

  const hottest = pulse?.terms.slice().sort((a, b) => b.heat - a.heat)[0];
  const biggest = pulse?.terms[0];

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        testID="pulse-screen"
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
      >
        <View style={styles.head}>
          <Text style={[styles.title, { color: t.text }]}>Pulse</Text>
          <Text style={[styles.sub, { color: t.muted }]}>
            {pulse
              ? `${pulse.headlines} headlines from ${pulse.outlets} ${pulse.outlets === 1 ? 'outlet' : 'outlets'}, last ${windowLabel(pulse.windowMs)}`
              : ' '}
          </Text>
        </View>

        <View style={styles.chips}>
          {WINDOWS.map((w) => {
            const on = w.ms === windowMs;
            return (
              <Pressable
                key={w.ms}
                testID={`pulse-window-${w.ms / HOUR}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setWindowMs(w.ms)}
                style={[styles.chip, { backgroundColor: on ? t.accent : t.card, borderColor: on ? t.accent : t.border }]}
              >
                <Text style={{ color: on ? t.onAccent : t.muted, fontSize: 13, fontWeight: '700' }}>{w.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {pulse && (biggest || hottest) ? (
          <View style={styles.headlines}>
            {biggest ? <Stat t={t} label="Most covered" term={biggest} now={now} onPress={setOpen} /> : null}
            {hottest && hottest !== biggest ? <Stat t={t} label="Hottest" term={hottest} now={now} onPress={setOpen} /> : null}
          </View>
        ) : null}

        <View style={[styles.cloud, { backgroundColor: t.card, borderColor: t.border }]}>
          {pulse && !layout.length ? (
            <Text style={{ color: t.muted, textAlign: 'center', padding: 24 }}>
              Not enough headlines in the last {windowLabel(windowMs)} to find recurring words. Pull down to refresh.
            </Text>
          ) : null}
          <View style={styles.words}>
            {layout.map(({ term, size }) => {
              const colour = wordColour(t, term);
              return (
                <Pressable
                  key={term.key}
                  testID={`pulse-term-${term.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${term.label}, ${kindLabel(term.kind)}: ${term.count} headlines from ${term.outlets} ${term.outlets === 1 ? 'outlet' : 'outlets'}, newest ${ageLabel(term.newestAt, now)} ago${term.rising ? ', rising' : ''}`}
                  onPress={() => setOpen(term)}
                  onLongPress={() => hide(term.label)}
                  delayLongPress={400}
                  hitSlop={4}
                  style={styles.word}
                >
                  <View style={styles.wordRow}>
                    <Text style={{ color: colour, fontSize: size, lineHeight: Math.round(size * 1.15), fontWeight: size > 26 ? '800' : '700', fontFamily: size > 26 ? 'serif' : undefined }}>
                      {term.label}
                    </Text>
                    {term.rising ? <Text style={{ fontSize: Math.max(10, Math.round(size * 0.4)), color: colour, marginLeft: 3, marginBottom: Math.round(size * 0.18) }}>▲</Text> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Legend t={t} kinds={new Set(layout.map((x) => x.term.kind))} />

        <Pressable
          testID="pulse-hidden"
          accessibilityRole="button"
          onPress={() => setEditingHidden(true)}
          style={styles.hiddenRow}
        >
          <Ionicons name="eye-off-outline" size={14} color={t.muted} />
          <Text style={{ color: t.muted, fontSize: 12, flex: 1 }} numberOfLines={2}>
            {hidden.length ? `Hidden: ${hidden.join(', ')}` : 'No words hidden'}
            {'  ·  Long-press a word to hide it'}
          </Text>
          <Text style={{ color: t.accent, fontSize: 12, fontWeight: '700' }}>Edit</Text>
        </Pressable>

        {pulse ? <Timeline t={t} pulse={pulse} /> : null}
      </ScrollView>
      <TermSheet term={open} now={now} onClose={() => setOpen(null)} onHide={(x) => { setOpen(null); hide(x.label); }} />
      <HiddenSheet visible={editingHidden} hidden={hidden} onClose={() => setEditingHidden(false)} />
    </View>
  );
}

function Stat({ t, label, term, now, onPress }: { t: Theme; label: string; term: PulseTerm; now: number; onPress: (x: PulseTerm) => void }) {
  return (
    <Pressable onPress={() => onPress(term)} accessibilityRole="button" style={[styles.stat, { backgroundColor: t.card, borderColor: t.border }]}>
      <Text style={[styles.statLabel, { color: t.muted }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.statTerm, { color: t.text }]} numberOfLines={1}>{term.label}</Text>
      <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={2}>
        {term.count} headlines, {term.outlets} {term.outlets === 1 ? 'outlet' : 'outlets'}{'\n'}newest {ageLabel(term.newestAt, now)} ago
      </Text>
    </Pressable>
  );
}

function Legend({ t, kinds }: { t: Theme; kinds: Set<StoryKind> }) {
  const steps = [0, 0.15, 0.35, 0.6, 1];
  // Only the kinds on screen, in their fixed order.
  const shown = STORY_KINDS.filter((k) => kinds.has(k.kind));
  return (
    <View style={styles.legend}>
      <View style={styles.legendKinds}>
        {shown.map((k) => (
          <View key={k.kind} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: kindColour(t, k.kind) }]} />
            <Text style={[styles.legendText, { color: t.muted }]}>{k.label}</Text>
          </View>
        ))}
      </View>
      <View style={styles.legendRow}>
        <Text style={[styles.legendText, { color: t.muted }]}>Older</Text>
        {steps.map((h) => (
          <View key={h} style={[styles.swatch, { backgroundColor: mix(t.card, t.text, strength(h)) }]} />
        ))}
        <Text style={[styles.legendText, { color: t.muted }]}>Fresh</Text>
        <Text style={[styles.legendText, { color: t.muted, marginLeft: 12 }]}>▲ rising</Text>
      </View>
      <Text style={[styles.legendText, { color: t.muted }]}>Bigger and nearer the middle: more headlines and outlets</Text>
    </View>
  );
}

/** Headlines per hour (or per three hours) across the window, each bar coloured by how recent it is. */
function Timeline({ t, pulse }: { t: Theme; pulse: Pulse }) {
  const max = Math.max(1, ...pulse.buckets);
  const n = pulse.buckets.length;
  const unit = pulse.bucketMs === HOUR ? 'hour' : '3 hours';
  const [picked, setPicked] = useState<number | null>(null);
  const label = (i: number) => {
    const ago = Math.round(((n - i) * pulse.bucketMs) / HOUR);
    return ago <= 1 && pulse.bucketMs === HOUR ? 'Last hour' : `${ago - Math.round(pulse.bucketMs / HOUR)}–${ago} hours ago`;
  };
  return (
    <View style={[styles.timeline, { backgroundColor: t.card, borderColor: t.border }]}>
      <Text style={[styles.timelineTitle, { color: t.text }]}>Headlines per {unit}</Text>
      <Text style={{ color: t.muted, fontSize: 12, marginBottom: 10, minHeight: 16 }}>
        {picked != null ? `${label(picked)}: ${pulse.buckets[picked]} headlines` : 'Touch a bar for its count'}
      </Text>
      <View style={styles.bars}>
        {pulse.buckets.map((c, i) => {
          // The newest bucket's colour is "fresh"; older ones fade as the cloud's words do.
          const heat = Math.pow(0.5, ((n - 1 - i) * pulse.bucketMs) / Math.max(HOUR, pulse.windowMs / 8));
          return (
            <Pressable
              key={i}
              onPressIn={() => setPicked(i)}
              accessibilityLabel={`${label(i)}: ${c} headlines`}
              style={styles.barSlot}
            >
              <View
                style={{
                  height: Math.max(c ? 3 : 1, Math.round((c / max) * 64)),
                  backgroundColor: picked === i ? t.text : c ? heatColour(t, heat) : t.border,
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                }}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.axis, { borderTopColor: t.border }]}>
        <Text style={[styles.axisText, { color: t.faint }]}>{windowLabel(pulse.windowMs)} ago</Text>
        <Text style={[styles.axisText, { color: t.faint }]}>now</Text>
      </View>
    </View>
  );
}

function TermSheet({ term, now, onClose, onHide }: {
  term: PulseTerm | null; now: number; onClose: () => void; onHide: (term: PulseTerm) => void;
}) {
  const t = useTheme();
  // Rows carry the term they were loaded for, so a sheet never shows another term's headlines.
  const [loaded, setLoaded] = useState<{ key: string; rows: PulseRow[] } | null>(null);
  useEffect(() => {
    if (!term) return;
    getDb()
      .then((db) => loadPulseHeadlines(db, term.articleIds))
      .then((rows) => setLoaded({ key: term.key, rows }))
      .catch(() => {});
  }, [term]);
  if (!term) return null;
  const rows = loaded?.key === term.key ? loaded.rows : [];
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={[styles.sheet, { backgroundColor: t.card }]} onPress={() => {}}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sheetTitle, { color: t.text }]}>{term.label}</Text>
              <View style={styles.legendItem}>
                <View style={[styles.dot, { backgroundColor: kindColour(t, term.kind) }]} />
                <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{kindLabel(term.kind)}</Text>
              </View>
              <Text style={{ color: t.muted, fontSize: 13 }}>
                {term.count} headlines from {term.outlets} {term.outlets === 1 ? 'outlet' : 'outlets'}
                {term.rising ? ' · rising' : ''}
              </Text>
            </View>
            <Pressable
              testID="pulse-hide-term"
              onPress={() => onHide(term)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Hide ${term.label} from Pulse`}
              style={[styles.hideButton, { borderColor: t.border }]}
            >
              <Ionicons name="eye-off-outline" size={15} color={t.muted} />
              <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>Hide</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={t.muted} />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 460 }}>
            {rows.map((r) => (
              <Pressable
                key={r.id}
                testID={`pulse-headline-${r.id}`}
                onPress={() => {
                  onClose();
                  openArticle(r.id, 'coverage').catch(() => showSnack('Could not open the article'));
                }}
                android_ripple={{ color: t.border }}
                style={[styles.row, { borderBottomColor: t.border }]}
              >
                <Text style={[styles.rowTitle, { color: t.text }]}>{r.title}</Text>
                <Text style={{ color: t.faint, fontSize: 12, marginTop: 3 }}>{r.sourceName} · {ageLabel(r.publishedAt, now)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** The words and names left out of Pulse: remove one, or add one by typing it. */
function HiddenSheet({ visible, hidden, onClose }: { visible: boolean; hidden: string[]; onClose: () => void }) {
  const t = useTheme();
  const [text, setText] = useState('');
  if (!visible) return null;
  const add = () => {
    const word = text.trim().replace(/\s+/g, ' ');
    setText('');
    if (!word || hidden.some((h) => pulseKey(h) === pulseKey(word))) return;
    updateSettings({ pulseHidden: [...hidden, word] }).catch(() => showSnack('Could not save that'));
  };
  const remove = (word: string) =>
    updateSettings({ pulseHidden: hidden.filter((h) => h !== word) }).catch(() => showSnack('Could not save that'));
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={[styles.sheet, { backgroundColor: t.card }]} onPress={() => {}}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sheetTitle, { color: t.text }]}>Hidden from Pulse</Text>
              <Text style={{ color: t.muted, fontSize: 13 }}>
                These words and names are left out of Pulse. The feeds are not affected.
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={t.muted} />
            </Pressable>
          </View>
          <View style={styles.hiddenChips}>
            {hidden.map((h) => (
              <Pressable
                key={h}
                testID={`pulse-unhide-${pulseKey(h)}`}
                onPress={() => remove(h)}
                accessibilityRole="button"
                accessibilityLabel={`Show ${h} in Pulse again`}
                style={[styles.hiddenChip, { borderColor: t.border, backgroundColor: t.strip }]}
              >
                <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{h}</Text>
                <Ionicons name="close" size={14} color={t.muted} />
              </Pressable>
            ))}
            {!hidden.length ? <Text style={{ color: t.faint, fontSize: 13 }}>Nothing hidden.</Text> : null}
          </View>
          <View style={styles.addRow}>
            <TextInput
              testID="pulse-hidden-input"
              value={text}
              onChangeText={setText}
              onSubmitEditing={add}
              placeholder="Add a word or name"
              placeholderTextColor={t.faint}
              returnKeyType="done"
              autoCapitalize="none"
              style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]}
            />
            <Pressable testID="pulse-hidden-add" onPress={add} style={[styles.addButton, { backgroundColor: t.accent }]} accessibilityRole="button">
              <Text style={{ color: t.onAccent, fontWeight: '700' }}>Hide</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  hiddenRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingTop: 10 },
  hideButton: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, marginRight: 14 },
  hiddenChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 18, paddingBottom: 14 },
  hiddenChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  addRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 18 },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15 },
  addButton: { borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  head: { paddingHorizontal: 18, paddingTop: 14 },
  title: { fontSize: 28, fontWeight: '800', fontFamily: 'serif' },
  sub: { fontSize: 13, marginTop: 2 },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  chip: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 6 },
  headlines: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingTop: 12 },
  stat: { flex: 1, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  statLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
  statTerm: { fontSize: 18, fontWeight: '800', marginVertical: 2 },
  cloud: { marginHorizontal: 12, marginTop: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 18, paddingHorizontal: 8, minHeight: 220, justifyContent: 'center' },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' },
  word: { paddingHorizontal: 6, paddingVertical: 2 },
  wordRow: { flexDirection: 'row', alignItems: 'flex-end' },
  legend: { paddingHorizontal: 18, paddingTop: 10, gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendKinds: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { fontSize: 12 },
  swatch: { width: 16, height: 10, borderRadius: 2 },
  timeline: { marginHorizontal: 12, marginTop: 16, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  timelineTitle: { fontSize: 15, fontWeight: '700' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: 68, gap: 2 },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  axis: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4 },
  axisText: { fontSize: 11 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 24 },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', padding: 18, paddingBottom: 10 },
  sheetTitle: { fontSize: 22, fontWeight: '800' },
  row: { paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
});
