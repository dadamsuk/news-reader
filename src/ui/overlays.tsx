import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { whyThis, type WhyLine } from '../core/ranking';
import type { FeedCard, LessReason } from '../core/types';
import { getDb } from '../platform/db';
import { getState, hideSnack, useStore } from '../state/store';
import { useTheme } from './theme';

/** Bottom snackbar with an optional action (Undo). Rendered once at the root. */
export function Snackbar({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const snack = useStore((s) => s.snack);
  const insets = useSafeAreaInsets();
  if (!snack) return null;
  return (
    <View pointerEvents="box-none" style={[styles.snackWrap, { bottom: insets.bottom + 76 + bottomOffset }]}>
      <View testID="snackbar" style={styles.snack}>
        <Text style={styles.snackText} numberOfLines={2}>{snack.text}</Text>
        {snack.actionLabel ? (
          <Pressable
            testID="snackbar-action"
            hitSlop={10}
            accessibilityRole="button"
            onPress={() => {
              const fn = snack.onAction;
              hideSnack();
              fn?.();
            }}
          >
            <Text style={styles.snackAction}>{snack.actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export interface MenuActions {
  onMore: (card: FeedCard) => void;
  onLess: (card: FeedCard) => void;
  /** Every outlet's piece on this story, side by side. */
  onCoverage: (card: FeedCard) => void;
  /** Follow the story (or open it, when it is already followed). */
  onFollow: (card: FeedCard) => void;
  /** Mute or watch one of this article's topics. */
  onTopics: (card: FeedCard) => void;
}

/** Long-press menu: coverage, follow, more or less like this, mute or watch, why, share. */
export function CardMenu({ card, onClose, actions }: { card: FeedCard | null; onClose: () => void; actions: MenuActions }) {
  if (!card) return null;
  // Keyed by article, so "Why am I seeing this" starts closed for each card.
  return <CardMenuSheet key={card.article.id} card={card} onClose={onClose} actions={actions} />;
}

function CardMenuSheet({ card, onClose, actions }: { card: FeedCard; onClose: () => void; actions: MenuActions }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [why, setWhy] = useState<WhyLine[] | null>(null);
  const [loadingWhy, setLoadingWhy] = useState(false);

  const item = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void, testID: string) => (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} android_ripple={{ color: t.border }} style={styles.menuItem}>
      <Ionicons name={icon} size={20} color={t.text} />
      <Text style={[styles.menuLabel, { color: t.text }]}>{label}</Text>
    </Pressable>
  );
  const showWhy = async () => {
    setLoadingWhy(true);
    try {
      const db = await getDb();
      setWhy(await whyThis(db, card.article.id, getState().settings, Date.now()));
    } finally {
      setLoadingWhy(false);
    }
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable testID="menu-backdrop" style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu" />
      <View testID="card-menu" style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 10 }]}>
        <Text style={[styles.sheetTitle, { color: t.muted }]} numberOfLines={2}>{card.article.title}</Text>
        {item(
          'albums-outline',
          card.outletCount > 1 ? `Full coverage: ${card.outletCount} outlets` : 'Full coverage',
          () => { actions.onCoverage(card); onClose(); },
          'menu-coverage',
        )}
        {item(
          card.following ? 'notifications' : 'notifications-outline',
          card.following ? 'Following this story' : 'Follow this story',
          () => { actions.onFollow(card); onClose(); },
          'menu-follow',
        )}
        {item('thumbs-up-outline', 'More like this', () => { actions.onMore(card); onClose(); }, 'menu-more')}
        {item('thumbs-down-outline', 'Less like this', () => { actions.onLess(card); onClose(); }, 'menu-less')}
        {item('volume-mute-outline', 'Mute or watch a topic…', () => { actions.onTopics(card); onClose(); }, 'menu-topics')}
        {item('help-circle-outline', 'Why am I seeing this', showWhy, 'menu-why')}
        {loadingWhy ? <ActivityIndicator style={{ marginVertical: 8 }} color={t.muted} /> : null}
        {why ? (
          <View testID="why-box" style={[styles.why, { backgroundColor: t.strip }]}>
            {why.length === 0 ? <Text style={{ color: t.muted }}>No strong reason yet: it is simply recent.</Text> : null}
            {why.map((w, i) => (
              <Text key={i} style={[styles.whyLine, { color: t.text }]}>
                {'•  '}{w.text}
              </Text>
            ))}
          </View>
        ) : null}
        {item('share-outline', 'Share link', () => { Share.share({ message: card.article.url, url: card.article.url }).catch(() => {}); onClose(); }, 'menu-share')}
      </View>
    </Modal>
  );
}

/** Keywords that make an article's topic, without the tag that only repeats its section. */
export function topicLabels(card: FeedCard): string[] {
  const sec = (card.article.section ?? '').toLowerCase().trim();
  const secSlug = sec.replace(/\s+/g, '-');
  return card.article.tags.filter((t) => {
    const k = t.toLowerCase().trim();
    return k && k !== sec && k !== secSlug;
  });
}

/**
 * Swipe left: "Show me less like this, because…". Each reason puts the whole negative on one part
 * of the article. Source is offered only when there is more than one primary source, since For you
 * shows nothing else.
 */
export function LessBecauseSheet({ card, onClose, onPick }: {
  card: FeedCard | null; onClose: () => void; onPick: (card: FeedCard, reason: LessReason) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [primaries, setPrimaries] = useState(1);
  useEffect(() => {
    if (!card) return;
    getDb()
      .then((db) => db.get<{ n: number }>("SELECT COUNT(*) n FROM source WHERE role = 'primary' AND enabled = 1"))
      .then((r) => setPrimaries(r?.n ?? 1))
      .catch(() => {});
  }, [card]);
  if (!card) return null;
  const topics = topicLabels(card).slice(0, 3);
  const option = (reason: LessReason, icon: keyof typeof Ionicons.glyphMap, label: string, detail: string) => (
    <Pressable
      testID={`less-${reason}`}
      accessibilityRole="button"
      onPress={() => { onPick(card, reason); onClose(); }}
      android_ripple={{ color: t.border }}
      style={styles.menuItem}
    >
      <Ionicons name={icon} size={20} color={t.text} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.menuLabel, { color: t.text }]}>{label}</Text>
        <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{detail}</Text>
      </View>
    </Pressable>
  );
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable testID="less-backdrop" style={styles.backdrop} onPress={onClose} accessibilityLabel="Cancel" />
      <View testID="less-sheet" style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 10 }]}>
        <Text style={[styles.sheetHeading, { color: t.text }]}>Show me less like this, because:</Text>
        <Text style={[styles.sheetTitle, { color: t.muted }]} numberOfLines={2}>{card.article.title}</Text>
        {primaries > 1 ? option('source', 'newspaper-outline', 'Less from this source', card.sourceName) : null}
        {card.article.section ? option('section', 'folder-outline', 'Less from this category', card.article.section) : null}
        {option('topic', 'pricetag-outline', 'Less on this topic', topics.length ? topics.join(', ') : 'What this story is about')}
        <Pressable testID="less-cancel" accessibilityRole="button" onPress={onClose} android_ripple={{ color: t.border }} style={styles.menuItem}>
          <Ionicons name="close" size={20} color={t.muted} />
          <Text style={[styles.menuLabel, { color: t.muted }]}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** Tapping Feed again: pick one category to show, or all of them. */
export function CategorySheet({ visible, categories, total, selected, onPick, onClose, unfiltered, threshold, onUnfiltered }: {
  visible: boolean; categories: { name: string; count: number }[]; total: number; selected: string | null;
  onPick: (category: string | null) => void; onClose: () => void;
  /** The Unfiltered switch, shown above the categories. */
  unfiltered: boolean; threshold: number; onUnfiltered: (v: boolean) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (!visible) return null;
  const option = (name: string | null, label: string, count: number, testID: string) => {
    const on = selected === name;
    return (
      <Pressable
        key={testID}
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => { onPick(name); onClose(); }}
        android_ripple={{ color: t.border }}
        style={styles.menuItem}
      >
        <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? t.accent : t.faint} />
        <Text style={[styles.menuLabel, { flex: 1, color: t.text, fontWeight: on ? '700' : '400' }]} numberOfLines={1}>{label}</Text>
        <Text style={{ color: t.faint, fontSize: 14 }}>{count}</Text>
      </Pressable>
    );
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable testID="category-backdrop" style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View testID="category-sheet" style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 10, maxHeight: '75%' }]}>
        <View style={styles.filterRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.menuLabel, { color: t.text, fontWeight: '700' }]}>Unfiltered</Text>
            <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18 }}>
              {unfiltered
                ? 'Every story, in time or news order; what the app has learned changes nothing.'
                : threshold > 0
                  ? `Best match first; stories under a ${threshold}% match are left out.`
                  : 'Best match first; nothing is left out.'}
            </Text>
          </View>
          <Switch
            testID="feed-unfiltered"
            value={unfiltered}
            onValueChange={onUnfiltered}
            trackColor={{ true: t.accent, false: t.border }}
            thumbColor="#ffffff"
          />
        </View>
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginBottom: 10 }} />
        <Text style={[styles.sheetHeading, { color: t.text, paddingBottom: 8 }]}>Show a category</Text>
        <ScrollView>
          {option(null, 'All categories', total, 'category-all')}
          {categories.map((c, i) => option(c.name, c.name, c.count, `category-${i}`))}
        </ScrollView>
      </View>
    </Modal>
  );
}

export function BudgetBanner() {
  const t = useTheme();
  const over = useStore((s) => s.overBudget);
  const sections = useStore((s) => s.modes.find((m) => m.id === s.settings.currentModeId)?.layout.type === 'sections');
  if (!over) return null;
  return (
    <View testID="budget-banner" style={[styles.banner, { backgroundColor: t.banner }]}>
      <Ionicons name="alert-circle-outline" size={16} color={t.bannerText} />
      <Text style={[styles.bannerText, { color: t.bannerText }]}>
        {sections
          ? 'Monthly LLM budget reached. New stories show their source headline until the 1st, when they are summarised.'
          : 'Monthly LLM budget reached. Angle notes and Right summaries are paused until the 1st.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  snackWrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center' },
  snack: {
    flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#2B2B30', borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 13, minWidth: '100%', elevation: 6,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  snackText: { color: '#fff', fontSize: 14, flex: 1 },
  snackAction: { color: '#FFB4AB', fontSize: 14, fontWeight: '800', letterSpacing: 0.4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 14 },
  sheetTitle: { fontSize: 13, paddingHorizontal: 20, paddingBottom: 10, lineHeight: 18 },
  sheetHeading: { fontSize: 17, fontWeight: '700', paddingHorizontal: 20, paddingBottom: 4 },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 14 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 15 },
  menuLabel: { fontSize: 16 },
  why: { marginHorizontal: 16, marginBottom: 6, borderRadius: 10, padding: 12, gap: 6 },
  whyLine: { fontSize: 14, lineHeight: 20 },
  banner: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 9 },
  bannerText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
});
