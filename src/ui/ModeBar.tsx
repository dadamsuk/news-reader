import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { switchMode } from '../platform/runner';
import { showSnack, useStore } from '../state/store';
import { useTheme } from './theme';

/**
 * A thin row of mode chips above the feed tabs, each with its unseen count. Tapping one switches
 * mode; Feed, Read later and History then show that mode. There is still no title bar.
 */
export function ModeBar() {
  const t = useTheme();
  const modes = useStore((s) => s.modes);
  const current = useStore((s) => s.settings.currentModeId);
  const counts = useStore((s) => s.modeCounts);
  if (modes.length < 2) return null;
  return (
    <View style={[styles.bar, { backgroundColor: t.card }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.inner}>
        {modes.map((m) => {
          const on = m.id === current;
          const n = counts[m.id] ?? 0;
          return (
            <Pressable
              key={m.id}
              testID={`mode-${m.name.toLowerCase().replace(/\W+/g, '-')}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${m.name}${n ? `, ${n} unseen` : ''}`}
              onPress={() => switchMode(m.id).catch(() => showSnack('Could not switch mode'))}
              style={[styles.chip, on ? { backgroundColor: t.accent, borderColor: t.accent } : { borderColor: t.border }]}
            >
              <Ionicons name={m.icon as keyof typeof Ionicons.glyphMap} size={14} color={on ? t.onAccent : t.muted} />
              <Text style={[styles.label, { color: on ? t.onAccent : t.text }]}>{m.name}</Text>
              {n > 0 ? (
                <Text testID={`mode-count-${m.id}`} style={[styles.count, { color: on ? t.onAccent : t.faint }]}>{n > 999 ? '999+' : n}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** The mode picker at the top of Settings, Sources and Learning: which mode's settings to show. */
export function ModePicker({ value, onChange }: { value: number; onChange: (modeId: number) => void }) {
  const t = useTheme();
  const modes = useStore((s) => s.modes);
  return (
    <View style={[styles.inner, { paddingTop: 14, flexWrap: 'wrap' }]}>
      {modes.map((m) => {
        const on = m.id === value;
        return (
          <Pressable
            key={m.id}
            testID={`pick-mode-${m.name.toLowerCase().replace(/\W+/g, '-')}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(m.id)}
            style={[styles.chip, on ? { backgroundColor: t.accent, borderColor: t.accent } : { borderColor: t.border }]}
          >
            <Ionicons name={m.icon as keyof typeof Ionicons.glyphMap} size={14} color={on ? t.onAccent : t.muted} />
            <Text style={[styles.label, { color: on ? t.onAccent : t.text }]}>{m.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingTop: 6, paddingBottom: 2 },
  inner: { flexDirection: 'row', gap: 8, paddingHorizontal: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  label: { fontSize: 13, fontWeight: '700' },
  count: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
