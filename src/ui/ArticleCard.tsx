import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import React, { memo, useCallback, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { FeedCard } from '../core/types';
import { ageLabel } from '../core/util';
import { useTheme, type Theme } from './theme';

export interface CardHandlers {
  onOpen: (card: FeedCard) => void;
  onSave: (card: FeedCard) => void;
  onDismiss: (card: FeedCard) => void;
  onMenu: (card: FeedCard) => void;
  onOpenSecond: (card: FeedCard) => void;
}

const TONE_LABEL: Record<string, string> = { comment: 'Comment', analysis: 'Analysis', live: 'Live' };

function SwipeAction({ t, kind }: { t: Theme; kind: 'save' | 'dismiss' }) {
  const save = kind === 'save';
  return (
    <View style={[styles.action, { backgroundColor: save ? t.save : t.dismiss, alignItems: save ? 'flex-start' : 'flex-end' }]}>
      <View style={styles.actionInner}>
        <Ionicons name={save ? 'bookmark' : 'close-circle'} size={22} color="#fff" />
        <Text style={styles.actionText}>{save ? 'Read later' : 'Not interested'}</Text>
      </View>
    </View>
  );
}

function ArticleCardBase({ card, now, handlers }: { card: FeedCard; now: number; handlers: CardHandlers }) {
  const t = useTheme();
  const ref = useRef<SwipeableMethods>(null);
  const a = card.article;
  const tone = a.tone ? TONE_LABEL[a.tone] : null;

  const onSwipe = useCallback(
    (direction: 'left' | 'right') => {
      if (direction === 'right') {
        // Swipe right saves; the card stays in place.
        ref.current?.close();
        handlers.onSave(card);
      } else {
        handlers.onDismiss(card);
      }
    },
    [card, handlers],
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
        renderLeftActions={() => <SwipeAction t={t} kind="save" />}
        renderRightActions={() => <SwipeAction t={t} kind="dismiss" />}
        onSwipeableOpen={onSwipe as any}
        containerStyle={styles.swipeContainer}
      >
        <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
          <Pressable
            testID={`card-${a.id}`}
            accessibilityRole="button"
            accessibilityLabel={a.title}
            onPress={() => handlers.onOpen(card)}
            onLongPress={() => handlers.onMenu(card)}
            delayLongPress={350}
            android_ripple={{ color: t.border }}
            style={styles.main}
          >
            <View style={styles.metaRow}>
              <Text style={[styles.meta, { color: t.accent }]} numberOfLines={1}>
                {(a.section ?? card.sourceName).toUpperCase()}
              </Text>
              {tone ? (
                <View style={[styles.tone, { borderColor: t.accent }]}>
                  <Text style={[styles.toneText, { color: t.accent }]}>{tone}</Text>
                </View>
              ) : null}
              <Text style={[styles.age, { color: t.faint }]}>{ageLabel(a.publishedAt, now)}</Text>
              <View style={{ flex: 1 }} />
              <Pressable
                testID={`save-${a.id}`}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={card.saved ? 'Remove from Read later' : 'Read later'}
                onPress={() => handlers.onSave(card)}
              >
                <Ionicons name={card.saved ? 'bookmark' : 'bookmark-outline'} size={20} color={card.saved ? t.accent : t.faint} />
              </Pressable>
            </View>
            <View style={styles.bodyRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.title, { color: t.text }]} numberOfLines={4}>{a.title}</Text>
                {a.summary ? <Text style={[styles.summary, { color: t.muted }]} numberOfLines={2}>{a.summary}</Text> : null}
              </View>
              {a.imageUrl ? (
                <Image
                  source={{ uri: a.imageUrl }}
                  style={[styles.thumb, { backgroundColor: t.strip }]}
                  contentFit="cover"
                  cachePolicy="disk"
                  recyclingKey={String(a.id)}
                  transition={120}
                />
              ) : null}
            </View>
          </Pressable>
          {card.second ? (
            <Pressable
              testID={`second-${a.id}`}
              accessibilityRole="button"
              onPress={() => handlers.onOpenSecond(card)}
              android_ripple={{ color: t.border }}
              style={[styles.strip, { backgroundColor: t.strip, borderTopColor: t.border }]}
            >
              <Ionicons name="git-compare-outline" size={15} color={t.muted} style={{ marginTop: 2 }} />
              <Text style={[styles.stripText, { color: t.muted }]} numberOfLines={4}>
                <Text style={[styles.stripSource, { color: t.text }]}>{card.second.sourceName}</Text>
                {card.second.angleNote ? `  ${card.second.angleNote}` : '  Also covering this story'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ReanimatedSwipeable>
    </View>
  );
}

export const ArticleCard = memo(
  ArticleCardBase,
  (p, n) =>
    p.card === n.card && p.handlers === n.handlers && ageLabel(p.card.article.publishedAt, p.now) === ageLabel(n.card.article.publishedAt, n.now),
);

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 12 },
  swipeContainer: { borderRadius: 14, overflow: 'hidden' },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  main: { padding: 14 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  meta: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7, maxWidth: '55%' },
  tone: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, marginLeft: 8 },
  toneText: { fontSize: 10, fontWeight: '700' },
  age: { fontSize: 12, marginLeft: 8 },
  bodyRow: { flexDirection: 'row', gap: 12 },
  title: { fontSize: 18, lineHeight: 23, fontWeight: '700', fontFamily: 'serif' },
  summary: { fontSize: 14, lineHeight: 20, marginTop: 6 },
  thumb: { width: 92, height: 92, borderRadius: 8 },
  strip: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  stripText: { flex: 1, fontSize: 13, lineHeight: 18 },
  stripSource: { fontWeight: '700' },
  action: { width: '100%', justifyContent: 'center', paddingHorizontal: 22 },
  actionInner: { alignItems: 'center', gap: 4 },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
