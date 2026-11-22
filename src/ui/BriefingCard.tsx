import Ionicons from '@expo/vector-icons/Ionicons';
import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { awayLabel } from '../core/briefing';
import type { Briefing, BriefingItem } from '../core/types';
import { useTheme } from './theme';

/** The catch-up card at the top of For you: the biggest stories from the time away. */
function BriefingCardBase({
  briefing, onOpen, onDismiss,
}: { briefing: Briefing; onOpen: (item: BriefingItem) => void; onDismiss: (b: Briefing) => void }) {
  const t = useTheme();
  return (
    <View style={styles.wrap}>
      <View testID="briefing" style={[styles.card, { backgroundColor: t.card, borderColor: t.accent }]}>
        <View style={styles.head}>
          <Ionicons name="cafe-outline" size={16} color={t.accent} />
          <Text style={[styles.heading, { color: t.accent }]}>WHILE YOU WERE AWAY</Text>
          <Text style={[styles.away, { color: t.faint }]}>{awayLabel(briefing.sinceAt, briefing.createdAt)}</Text>
          <View style={{ flex: 1 }} />
          <Pressable testID="briefing-dismiss" hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss the briefing" onPress={() => onDismiss(briefing)}>
            <Ionicons name="close" size={20} color={t.faint} />
          </Pressable>
        </View>
        {briefing.items.map((it, i) => (
          <Pressable
            key={it.clusterId}
            testID={`briefing-item-${i}`}
            accessibilityRole="button"
            onPress={() => onOpen(it)}
            android_ripple={{ color: t.border }}
            style={[styles.item, { borderTopColor: t.border }]}
          >
            <Text style={[styles.num, { color: t.faint }]}>{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sentence, { color: t.text }]}>{it.sentence ?? it.headline}</Text>
              <Text style={[styles.outlets, { color: t.faint }]}>{it.outletCount} outlets</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={t.faint} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export const BriefingCard = memo(BriefingCardBase);

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 12 },
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 11 },
  heading: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  away: { fontSize: 12 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth },
  num: { fontSize: 15, fontWeight: '800', width: 14, textAlign: 'center' },
  sentence: { fontSize: 15, lineHeight: 21, fontFamily: 'serif', fontWeight: '600' },
  outlets: { fontSize: 12, marginTop: 3 },
});
