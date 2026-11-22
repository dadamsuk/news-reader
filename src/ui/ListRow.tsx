import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import React, { memo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { ListRow as Row } from '../core/feed';
import { ageLabel } from '../core/util';
import { useTheme } from './theme';

/** Compact article row for Read later and History. Swiping (when enabled) marks it done. */
function ListRowBase({
  row, now, onPress, onSwipe, swipeLabel, whenLabel, testID,
}: {
  row: Row; now: number; onPress: (row: Row) => void; onSwipe?: (row: Row) => void; swipeLabel?: string;
  whenLabel: string; testID: string;
}) {
  const t = useTheme();
  const ref = useRef<SwipeableMethods>(null);
  const a = row.article;
  const content = (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={a.title}
      onPress={() => onPress(row)}
      android_ripple={{ color: t.border }}
      style={[styles.row, { backgroundColor: t.card, borderColor: t.border }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.meta, { color: t.accent }]} numberOfLines={1}>
          {row.sourceName.toUpperCase()}
          <Text style={{ color: t.faint, fontWeight: '500' }}>{`  ·  ${whenLabel} ${ageLabel(row.at, now)}`}</Text>
        </Text>
        <Text style={[styles.title, { color: t.text }]} numberOfLines={3}>{a.title}</Text>
        {row.offline ? (
          <View style={styles.offline}>
            <Ionicons name="cloud-done-outline" size={13} color={t.faint} />
            <Text style={{ color: t.faint, fontSize: 11 }}>Available offline</Text>
          </View>
        ) : null}
      </View>
      {a.imageUrl ? (
        <Image source={{ uri: a.imageUrl }} style={[styles.thumb, { backgroundColor: t.strip }]} contentFit="cover" cachePolicy="disk" recyclingKey={String(a.id)} />
      ) : null}
    </Pressable>
  );
  if (!onSwipe) return <View style={styles.wrap}>{content}</View>;
  const action = (align: 'flex-start' | 'flex-end') => (
    <View style={[styles.action, { backgroundColor: t.save, alignItems: align }]}>
      <Ionicons name="checkmark-done" size={22} color="#fff" />
      <Text style={styles.actionText}>{swipeLabel}</Text>
    </View>
  );
  return (
    <View style={styles.wrap}>
      <ReanimatedSwipeable
        ref={ref}
        friction={1}
        leftThreshold={72}
        rightThreshold={72}
        overshootLeft={false}
        overshootRight={false}
        renderLeftActions={() => action('flex-start')}
        renderRightActions={() => action('flex-end')}
        onSwipeableOpen={() => onSwipe(row)}
        containerStyle={styles.swipe}
      >
        {content}
      </ReanimatedSwipeable>
    </View>
  );
}

export const ListRow = memo(ListRowBase);

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 10 },
  swipe: { borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  meta: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, marginBottom: 5 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '700', fontFamily: 'serif' },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  thumb: { width: 68, height: 68, borderRadius: 8 },
  action: { width: '100%', justifyContent: 'center', paddingHorizontal: 22, gap: 3 },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
