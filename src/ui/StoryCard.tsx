import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StoryView } from '../core/types';
import { ageLabel } from '../core/util';
import { useTheme } from './theme';

/** A followed story in the Following tab: what is new since it was last opened. */
function StoryCardBase({ story, now, onOpen }: { story: StoryView; now: number; onOpen: (s: StoryView) => void }) {
  const t = useTheme();
  const fresh = story.newCount > 0;
  const status = fresh
    ? `${story.newCount} NEW${story.newOutlets > 1 ? ` · ${story.newOutlets} OUTLETS` : ''}`
    : 'NOTHING NEW';
  return (
    <View style={styles.wrap}>
      <Pressable
        testID={`story-${story.id}`}
        accessibilityRole="button"
        accessibilityLabel={story.title}
        onPress={() => onOpen(story)}
        android_ripple={{ color: t.border }}
        style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}
      >
        <View style={styles.top}>
          <View style={{ flex: 1 }}>
            <View style={styles.metaRow}>
              <Ionicons name={fresh ? 'notifications' : 'notifications-outline'} size={13} color={fresh ? t.accent : t.faint} />
              <Text testID={`story-status-${story.id}`} style={[styles.status, { color: fresh ? t.accent : t.faint }]}>{status}</Text>
              {story.latestAt ? <Text style={[styles.age, { color: t.faint }]}>{ageLabel(story.latestAt, now)}</Text> : null}
            </View>
            <Text style={[styles.title, { color: t.text }]} numberOfLines={3}>{story.title}</Text>
          </View>
          {story.imageUrl ? (
            <Image source={{ uri: story.imageUrl }} style={[styles.thumb, { backgroundColor: t.strip }]} contentFit="cover" cachePolicy="disk" transition={120} />
          ) : null}
        </View>
        {fresh ? (
          <View style={[styles.strip, { backgroundColor: t.strip, borderTopColor: t.border }]}>
            <Text style={[styles.stripText, { color: t.muted }]} numberOfLines={4}>
              {story.updateSummary ?? `Latest: ${story.latestTitle ?? ''}`}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

export const StoryCard = memo(
  StoryCardBase,
  (p, n) => p.story === n.story && p.onOpen === n.onOpen && ageLabel(p.story.latestAt ?? 0, p.now) === ageLabel(n.story.latestAt ?? 0, n.now),
);

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 12 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  top: { flexDirection: 'row', gap: 12, padding: 14 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  status: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  age: { fontSize: 12, marginLeft: 2 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '700', fontFamily: 'serif' },
  thumb: { width: 76, height: 76, borderRadius: 8 },
  strip: { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  stripText: { fontSize: 13.5, lineHeight: 19 },
});
