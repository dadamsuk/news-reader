import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { whyThis, type WhyLine } from '../core/ranking';
import type { FeedCard } from '../core/types';
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
}

/** Long-press menu: More like this, Less like this, Why am I seeing this, Share link. */
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
        {item('thumbs-up-outline', 'More like this', () => { actions.onMore(card); onClose(); }, 'menu-more')}
        {item('thumbs-down-outline', 'Less like this', () => { actions.onLess(card); onClose(); }, 'menu-less')}
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

export function BudgetBanner() {
  const t = useTheme();
  const over = useStore((s) => s.overBudget);
  if (!over) return null;
  return (
    <View testID="budget-banner" style={[styles.banner, { backgroundColor: t.banner }]}>
      <Ionicons name="alert-circle-outline" size={16} color={t.bannerText} />
      <Text style={[styles.bannerText, { color: t.bannerText }]}>
        Monthly LLM budget reached. Angle notes and Right press summaries are paused until the 1st.
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
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 15 },
  menuLabel: { fontSize: 16 },
  why: { marginHorizontal: 16, marginBottom: 6, borderRadius: 10, padding: 12, gap: 6 },
  whyLine: { fontSize: 14, lineHeight: 20 },
  banner: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 9 },
  bannerText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
});
