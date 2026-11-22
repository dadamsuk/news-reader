import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DigestItem, DigestOutlet } from '../core/types';
import { ageLabel } from '../core/util';
import { useTheme } from './theme';

function DigestCardBase({
  item, now, onOpenOutlet, onCoverage,
}: { item: DigestItem; now: number; onOpenOutlet: (o: DigestOutlet) => void; onCoverage?: (item: DigestItem) => void }) {
  const t = useTheme();
  return (
    <View style={styles.wrap}>
      <View testID={`digest-${item.clusterId}`} style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
        <View style={styles.top}>
          <View style={{ flex: 1 }}>
            <View style={styles.metaRow}>
              <Text testID={`digest-count-${item.clusterId}`} style={[styles.count, { color: t.accent }]}>
                {item.outletCount} OUTLETS
              </Text>
              <Text style={[styles.age, { color: t.faint }]}>{ageLabel(item.latestAt, now)}</Text>
            </View>
            <Text style={[styles.summary, { color: t.text }]}>{item.summary}</Text>
          </View>
          {item.imageUrl ? (
            <Image source={{ uri: item.imageUrl }} style={[styles.thumb, { backgroundColor: t.strip }]} contentFit="cover" cachePolicy="disk" transition={120} />
          ) : null}
        </View>
        <View style={[styles.outlets, { borderTopColor: t.border }]}>
          {item.outlets.map((o) => (
            <Pressable
              key={o.articleId}
              testID={`outlet-${o.articleId}`}
              accessibilityRole="link"
              onPress={() => onOpenOutlet(o)}
              android_ripple={{ color: t.border }}
              style={[styles.outlet, { borderBottomColor: t.border }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.outletName, { color: t.text }]}>{o.sourceName}</Text>
                <Text style={[styles.outletTitle, { color: t.muted }]} numberOfLines={2}>{o.title}</Text>
              </View>
              <Ionicons name="open-outline" size={16} color={t.faint} />
            </Pressable>
          ))}
          {onCoverage ? (
            <Pressable
              testID={`digest-coverage-${item.clusterId}`}
              accessibilityRole="button"
              onPress={() => onCoverage(item)}
              android_ripple={{ color: t.border }}
              style={styles.outlet}
            >
              <Ionicons name="albums-outline" size={15} color={t.muted} />
              <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>Full coverage: compare or follow</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export const DigestCard = memo(DigestCardBase, (p, n) => p.item === n.item && p.onOpenOutlet === n.onOpenOutlet && p.onCoverage === n.onCoverage);

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 12 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  top: { flexDirection: 'row', gap: 12, padding: 14 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  count: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  age: { fontSize: 12, marginLeft: 8 },
  summary: { fontSize: 16, lineHeight: 22, fontWeight: '600', fontFamily: 'serif' },
  thumb: { width: 84, height: 84, borderRadius: 8 },
  outlets: { borderTopWidth: StyleSheet.hairlineWidth },
  outlet: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  outletName: { fontSize: 13, fontWeight: '700' },
  outletTitle: { fontSize: 13, lineHeight: 18, marginTop: 1 },
});
