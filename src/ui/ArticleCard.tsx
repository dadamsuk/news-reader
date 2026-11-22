import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import React, { memo, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FeedCard } from '../core/types';
import { ageLabel } from '../core/util';
import { SwipeRow } from './SwipeRow';
import { useTheme, type Theme } from './theme';

export interface CardHandlers {
  onOpen: (card: FeedCard) => void;
  onSave: (card: FeedCard) => void;
  /** Thumbs-up: interested, but not reading or saving it. Tapping again takes it back. */
  onInterested: (card: FeedCard) => void;
  /** Thumbs-down: a general "not interested". The card goes. */
  onDismiss: (card: FeedCard) => void;
  /** Swipe left: "Show me less like this, because…" (asks for the reason). */
  onLessBecause: (card: FeedCard) => void;
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
        <Text style={styles.actionText}>{save ? 'Read later' : 'Less like this…'}</Text>
      </View>
    </View>
  );
}

function ArticleCardBase({ card, now, handlers, note }: { card: FeedCard; now: number; handlers: CardHandlers; note?: string }) {
  const t = useTheme();
  const a = card.article;
  const tone = a.tone ? TONE_LABEL[a.tone] : null;

  // Swipe right saves (the card springs back and stays); swipe left asks what to see less of.
  const onSwipeRight = useCallback(() => handlers.onSave(card), [card, handlers]);
  const onSwipeLeft = useCallback(() => handlers.onLessBecause(card), [card, handlers]);

  return (
    <View style={styles.wrap}>
      <SwipeRow
        onSwipeRight={onSwipeRight}
        onSwipeLeft={onSwipeLeft}
        renderRightSwipe={() => <SwipeAction t={t} kind="save" />}
        renderLeftSwipe={() => <SwipeAction t={t} kind="dismiss" />}
        style={styles.swipeContainer}
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
              <View
                testID={`fit-${a.id}`}
                accessible
                accessibilityLabel={card.goodFit ? 'A good fit for you' : 'Shown because it is recent'}
                style={[
                  styles.fitDot,
                  card.goodFit ? { backgroundColor: t.accent, borderColor: t.accent } : { borderColor: t.faint },
                ]}
              />
              <Text style={[styles.meta, { color: t.accent }]} numberOfLines={1}>
                {(a.section ?? card.sourceName).toUpperCase()}
              </Text>
              {tone ? (
                <View style={[styles.tone, { borderColor: t.accent }]}>
                  <Text style={[styles.toneText, { color: t.accent }]}>{tone}</Text>
                </View>
              ) : null}
              <Text style={[styles.age, { color: t.faint }]}>{ageLabel(a.publishedAt, now)}</Text>
              {card.following ? (
                <Ionicons
                  testID={`following-${a.id}`}
                  name="notifications"
                  size={13}
                  color={t.accent}
                  style={{ marginLeft: 8 }}
                  accessibilityLabel="Part of a story you follow"
                />
              ) : null}
              <View style={{ flex: 1 }} />
              <Pressable
                testID={`interested-${a.id}`}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={card.interested ? 'Take back: interested' : 'Interested'}
                accessibilityState={{ selected: card.interested }}
                onPress={() => handlers.onInterested(card)}
                style={styles.metaButton}
              >
                <Ionicons name={card.interested ? 'thumbs-up' : 'thumbs-up-outline'} size={19} color={card.interested ? t.accent : t.faint} />
              </Pressable>
              <Pressable
                testID={`dismiss-${a.id}`}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Not interested"
                onPress={() => handlers.onDismiss(card)}
                style={styles.metaButton}
              >
                <Ionicons name="thumbs-down-outline" size={19} color={t.faint} />
              </Pressable>
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
          {card.watch ? (
            <View testID={`watch-${a.id}`} style={[styles.strip, { backgroundColor: t.strip, borderTopColor: t.border }]}>
              <Ionicons name="eye-outline" size={15} color={t.muted} style={{ marginTop: 2 }} />
              <Text style={[styles.stripText, { color: t.muted }]} numberOfLines={1}>
                Watching <Text style={[styles.stripSource, { color: t.text }]}>{card.watch}</Text>
                {`  ·  ${card.sourceName}`}
              </Text>
            </View>
          ) : null}
          {note ? (
            <View testID={`note-${a.id}`} style={[styles.strip, { backgroundColor: t.strip, borderTopColor: t.border }]}>
              <Ionicons name="eye-off-outline" size={15} color={t.muted} style={{ marginTop: 2 }} />
              <Text style={[styles.stripText, { color: t.muted }]}>{note}</Text>
            </View>
          ) : null}
        </View>
      </SwipeRow>
    </View>
  );
}

export const ArticleCard = memo(
  ArticleCardBase,
  (p, n) =>
    p.card === n.card && p.handlers === n.handlers && p.note === n.note && ageLabel(p.card.article.publishedAt, p.now) === ageLabel(n.card.article.publishedAt, n.now),
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
  metaButton: { marginRight: 18 },
  // Filled: here because it fits. Hollow: here because it is recent (or an exploration pick).
  fitDot: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.2, marginRight: 7, opacity: 0.85 },
  bodyRow: { flexDirection: 'row', gap: 12 },
  title: { fontSize: 18, lineHeight: 23, fontWeight: '700', fontFamily: 'serif' },
  summary: { fontSize: 14, lineHeight: 20, marginTop: 6 },
  thumb: { width: 92, height: 92, borderRadius: 8 },
  strip: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  stripText: { flex: 1, fontSize: 13, lineHeight: 18 },
  stripSource: { fontWeight: '700' },
  action: { flex: 1, justifyContent: 'center', paddingHorizontal: 22 },
  actionInner: { alignItems: 'center', gap: 4 },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
