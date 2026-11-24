import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  dismiss, hideArticle, lessBecause, lessLikeThis, markInterested, moreLikeThis, recordOpenMore, saveForLater,
  undoDismiss, undoLess, undoLessBecause, unhideArticle, unmarkInterested, unsave,
} from '../core/feed';
import { loadSections, whySection, type MoreSource, type SectionCard, type SectionsView } from '../core/sections';
import type { LessReason } from '../core/types';
import { ageLabel } from '../core/util';
import { getDb } from '../platform/db';
import { openArticle, openInBrowser } from '../platform/open';
import { bodyDeps, runRefresh, startSession } from '../platform/runner';
import { ensureBody } from '../reader/body';
import { getState, showSnack, useStore } from '../state/store';
import { Button, Empty } from './kit';
import { BudgetBanner } from './overlays';
import { VIEWABILITY, useSeenTracker, type SeenEntry } from './seen';
import { SwipeRow } from './SwipeRow';
import { useTheme, type Theme } from './theme';

type Row =
  | { kind: 'heading'; key: string; title: string; note?: string }
  | { kind: 'card'; key: string; card: SectionCard }
  | { kind: 'showMore'; key: string; left: number };

interface Handlers {
  onOpen: (c: SectionCard) => void;
  onSave: (c: SectionCard) => void;
  onInterested: (c: SectionCard) => void;
  onDismiss: (c: SectionCard) => void;
  onHide: (c: SectionCard) => void;
  onLessBecause: (c: SectionCard) => void;
  onMenu: (c: SectionCard) => void;
  onOpenMore: (c: SectionCard, m: MoreSource) => void;
}

function SwipeAction({ t, kind }: { t: Theme; kind: 'hide' | 'less' }) {
  const hide = kind === 'hide';
  return (
    <View style={[styles.action, { backgroundColor: t.dismiss, alignItems: hide ? 'flex-start' : 'flex-end' }]}>
      <View style={{ alignItems: 'center', gap: 4 }}>
        <Ionicons name={hide ? 'eye-off' : 'close-circle'} size={22} color="#fff" />
        <Text style={styles.actionText}>{hide ? 'Hide' : 'Less like this…'}</Text>
      </View>
    </View>
  );
}

/**
 * A card in a sections-layout mode: the rewritten headline, a one-line summary, "why it matters to
 * you" (main section only), then source, "+N more", read time and age. Same actions as News cards.
 */
function SectionCardBase({ card, now, h, other }: { card: SectionCard; now: number; h: Handlers; other: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const a = card.article;
  const meta = [card.readMinutes ? `${card.readMinutes} min read` : null, ageLabel(a.publishedAt, now)].filter(Boolean).join(' · ');
  return (
    <View style={styles.wrap}>
      <SwipeRow
        onSwipeRight={() => h.onHide(card)}
        onSwipeLeft={() => h.onLessBecause(card)}
        rightSlidesAway
        renderRightSwipe={() => <SwipeAction t={t} kind="hide" />}
        renderLeftSwipe={() => <SwipeAction t={t} kind="less" />}
        style={styles.swipe}
      >
        <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
          <Pressable
            testID={`scard-${a.id}`}
            accessibilityRole="button"
            accessibilityLabel={a.title}
            onPress={() => h.onOpen(card)}
            onLongPress={() => h.onMenu(card)}
            delayLongPress={350}
            android_ripple={{ color: t.border }}
            style={styles.main}
          >
            {other && card.reason ? (
              <View testID={`reason-${a.id}`} style={[styles.reason, { borderColor: t.accent }]}>
                <Text style={[styles.reasonText, { color: t.accent }]}>{card.reason}</Text>
              </View>
            ) : null}
            <Text testID={`headline-${a.id}`} style={[styles.title, { color: t.text }]} numberOfLines={3}>{a.title}</Text>
            {a.summary ? <Text testID={`summary-${a.id}`} style={[styles.summary, { color: t.muted }]} numberOfLines={2}>{a.summary}</Text> : null}
            {!other && card.why ? (
              <Text testID={`why-${a.id}`} style={[styles.why, { color: t.text }]} numberOfLines={2}>
                <Text style={{ fontWeight: '700', color: t.accent }}>Why it matters: </Text>{card.why}
              </Text>
            ) : null}
            <View style={styles.metaRow}>
              <Text style={[styles.source, { color: t.accent }]} numberOfLines={1}>{card.sourceName}</Text>
              {card.more.length ? (
                <Pressable testID={`more-${a.id}`} hitSlop={8} accessibilityRole="button" onPress={() => setOpen((v) => !v)}>
                  <Text style={[styles.plus, { color: t.text, borderColor: t.border }]}>+{card.more.length} more</Text>
                </Pressable>
              ) : null}
              <Text style={[styles.age, { color: t.faint }]} numberOfLines={1}>{meta}</Text>
              <View style={{ flex: 1 }} />
              <Pressable testID={`interested-${a.id}`} hitSlop={10} accessibilityRole="button" accessibilityLabel={card.interested ? 'Take back: interested' : 'Interested'} onPress={() => h.onInterested(card)} style={styles.btn}>
                <Ionicons name={card.interested ? 'thumbs-up' : 'thumbs-up-outline'} size={19} color={card.interested ? t.accent : t.faint} />
              </Pressable>
              <Pressable testID={`dismiss-${a.id}`} hitSlop={10} accessibilityRole="button" accessibilityLabel="Not interested" onPress={() => h.onDismiss(card)} style={styles.btn}>
                <Ionicons name="thumbs-down-outline" size={19} color={t.faint} />
              </Pressable>
              <Pressable testID={`save-${a.id}`} hitSlop={12} accessibilityRole="button" accessibilityLabel={card.saved ? 'Remove from Read later' : 'Read later'} onPress={() => h.onSave(card)}>
                <Ionicons name={card.saved ? 'bookmark' : 'bookmark-outline'} size={20} color={card.saved ? t.accent : t.faint} />
              </Pressable>
            </View>
          </Pressable>
          {open ? (
            <View testID={`morelist-${a.id}`} style={[styles.moreList, { backgroundColor: t.strip, borderTopColor: t.border }]}>
              {card.more.map((m, i) => (
                <Pressable key={i} testID={`moresrc-${a.id}-${i}`} accessibilityRole="link" onPress={() => h.onOpenMore(card, m)} style={styles.moreRow}>
                  <Ionicons name="open-outline" size={14} color={t.muted} style={{ marginTop: 2 }} />
                  <Text style={{ flex: 1, color: t.muted, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
                    <Text style={{ color: t.text, fontWeight: '700' }}>{m.sourceName}</Text>{`  ${m.title}`}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </SwipeRow>
    </View>
  );
}

const SectionCardView = memo(SectionCardBase);

/** Long press: More like this, Less like this, Why am I seeing this, Share link. */
function SectionMenu({ card, modeId, onClose, onMore, onLess }: {
  card: SectionCard; modeId: number; onClose: () => void; onMore: (c: SectionCard) => void; onLess: (c: SectionCard) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [why, setWhy] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const item = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void, testID: string) => (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} android_ripple={{ color: t.border }} style={styles.menuItem}>
      <Ionicons name={icon} size={20} color={t.text} />
      <Text style={{ fontSize: 16, color: t.text }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable testID="menu-backdrop" style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu" />
      <View testID="card-menu" style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 10 }]}>
        <Text style={[styles.sheetTitle, { color: t.muted }]} numberOfLines={2}>{card.article.title}</Text>
        {item('thumbs-up-outline', 'More like this', () => { onMore(card); onClose(); }, 'menu-more')}
        {item('thumbs-down-outline', 'Less like this', () => { onLess(card); onClose(); }, 'menu-less')}
        {item('help-circle-outline', 'Why am I seeing this', async () => {
          setBusy(true);
          try {
            setWhy(await whySection(await getDb(), card, modeId));
          } finally {
            setBusy(false);
          }
        }, 'menu-why')}
        {busy ? <ActivityIndicator style={{ marginVertical: 8 }} color={t.muted} /> : null}
        {why ? (
          <View testID="why-box" style={[styles.whyBox, { backgroundColor: t.strip }]}>
            {why.map((w, i) => <Text key={i} style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{'•  '}{w}</Text>)}
          </View>
        ) : null}
        {item('share-outline', 'Share link', () => { Share.share({ message: card.article.url, url: card.article.url }).catch(() => {}); onClose(); }, 'menu-share')}
      </View>
    </Modal>
  );
}

/** Swipe left: "Show me less like this, because…" this source, or these topics. */
function LessSheet({ card, onClose, onPick }: { card: SectionCard; onClose: () => void; onPick: (c: SectionCard, r: LessReason) => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const option = (reason: LessReason, icon: keyof typeof Ionicons.glyphMap, label: string, detail: string) => (
    <Pressable testID={`less-${reason}`} accessibilityRole="button" onPress={() => { onPick(card, reason); onClose(); }} android_ripple={{ color: t.border }} style={styles.menuItem}>
      <Ionicons name={icon} size={20} color={t.text} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, color: t.text }}>{label}</Text>
        <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{detail}</Text>
      </View>
    </Pressable>
  );
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <Pressable testID="less-backdrop" style={styles.backdrop} onPress={onClose} accessibilityLabel="Cancel" />
      <View testID="less-sheet" style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 10 }]}>
        <Text style={{ fontSize: 17, fontWeight: '700', paddingHorizontal: 20, paddingBottom: 4, color: t.text }}>Show me less like this, because:</Text>
        <Text style={[styles.sheetTitle, { color: t.muted }]} numberOfLines={2}>{card.article.title}</Text>
        {option('source', 'newspaper-outline', 'Less from this source', card.sourceName)}
        {option('topic', 'pricetag-outline', 'Less on these topics', card.tags.length ? card.tags.slice(0, 4).join(', ') : 'What this story is about')}
        <Pressable testID="less-cancel" accessibilityRole="button" onPress={onClose} style={styles.menuItem}>
          <Ionicons name="close" size={20} color={t.muted} />
          <Text style={{ fontSize: 16, color: t.muted }}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/**
 * The feed of a sections-layout mode: one scroll of its sections in order (for the AI mode, "Stuff
 * you're interested in" then "In other news..."). Only unseen stories appear; cards seen this
 * session stay put until it ends. The main section shows its first 15, then 15 more per "Show
 * more"; cards not yet revealed are not drawn, so they cannot be seen.
 */
export function SectionsFeed({ modeId }: { modeId: number }) {
  const t = useTheme();
  const navigation = useNavigation();
  const sessionId = useStore((s) => s.sessionId);
  const sessionVersion = useStore((s) => s.sessionVersion);
  const dataVersion = useStore((s) => s.dataVersion);
  const refreshing = useStore((s) => s.refreshing);
  const [view, setView] = useState<SectionsView | null>(null);
  // Pages of the main section revealed; a new session starts again from one.
  const [revealed, setRevealed] = useState({ session: sessionVersion, pages: 1 });
  const pages = revealed.session === sessionVersion ? revealed.pages : 1;
  const [now, setNow] = useState(() => Date.now());
  const [pulling, setPulling] = useState(false);
  const [menu, setMenu] = useState<SectionCard | null>(null);
  const [less, setLess] = useState<SectionCard | null>(null);
  const listRef = useRef<FlatList<Row>>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const db = await getDb();
    const at = Date.now();
    const v = await loadSections(db, modeId, getState().sessionId, at);
    if (mine !== seq.current) return;
    setView(v);
    setNow(at);
  }, [modeId]);

  useEffect(() => {
    reload().catch(() => setView((v) => v ?? { sections: [], unseen: 0, settings: null as any }));
  }, [reload, sessionVersion, dataVersion]);

  // A new session starts at the top.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [sessionVersion]);

  // Tapping Feed again scrolls to the top.
  useEffect(
    () => (navigation as any).addListener('tabPress', () => {
      if (navigation.isFocused()) listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }),
    [navigation],
  );

  const pageSize = view?.settings?.pageSize ?? 15;
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const sec of view?.sections ?? []) {
      if (!sec.cards.length) continue; // a section with nothing to show is hidden, not padded
      out.push({ kind: 'heading', key: `h-${sec.def.type}`, title: sec.def.title });
      if (sec.def.type === 'ranked') {
        const shown = sec.cards.slice(0, pageSize * pages);
        shown.forEach((c) => out.push({ kind: 'card', key: `c-${c.clusterId}`, card: c }));
        if (sec.cards.length > shown.length) out.push({ kind: 'showMore', key: 'show-more', left: sec.cards.length - shown.length });
      } else {
        sec.cards.forEach((c) => out.push({ kind: 'card', key: `c-${c.clusterId}`, card: c }));
      }
    }
    return out;
  }, [view, pages, pageSize]);

  const entries = useMemo<SeenEntry[]>(
    () => rows.map((r, i) => (r.kind === 'card'
      ? { key: r.card.clusterId, impressions: [{ articleId: r.card.article.id, surface: 'feed' as const }] }
      : { key: -1 - i, impressions: [] })),
    [rows],
  );
  const seen = useSeenTracker(entries, true, sessionId);

  const removeCard = useCallback((c: SectionCard) => {
    setView((v) => v && { ...v, sections: v.sections.map((s) => ({ ...s, cards: s.cards.filter((x) => x.clusterId !== c.clusterId) })) });
  }, []);
  const patchCard = useCallback((c: SectionCard, patch: Partial<SectionCard>) => {
    setView((v) => v && { ...v, sections: v.sections.map((s) => ({ ...s, cards: s.cards.map((x) => (x.clusterId === c.clusterId ? { ...x, ...patch } : x)) })) });
  }, []);
  const undoThen = (fn: () => Promise<void>) => async () => {
    await fn();
    reload().catch(() => {});
  };

  const h = useMemo<Handlers>(() => ({
    onOpen: (c) => { openArticle(c.article.id, 'feed').catch(() => showSnack('Could not open the article')); },
    onSave: async (c) => {
      const db = await getDb();
      const id = c.article.id;
      if (c.saved) {
        await unsave(db, id, Date.now());
        patchCard(c, { saved: false });
        showSnack('Removed from Read later');
        return;
      }
      await saveForLater(db, id, getState().sessionId, Date.now());
      patchCard(c, { saved: true });
      showSnack('Saved to Read later', 'UNDO', async () => {
        await unsave(db, id, Date.now());
        patchCard(c, { saved: false });
      });
      bodyDeps().then((d) => ensureBody(d, id, { withImages: true })).catch(() => {});
    },
    onInterested: async (c) => {
      const db = await getDb();
      if (c.interested) {
        await unmarkInterested(db, c.article.id, Date.now());
        patchCard(c, { interested: false });
        showSnack('Taken back');
        return;
      }
      await markInterested(db, c.article.id, Date.now());
      patchCard(c, { interested: true });
      showSnack('Noted: interested', 'UNDO', async () => {
        await unmarkInterested(db, c.article.id, Date.now());
        patchCard(c, { interested: false });
      });
    },
    onDismiss: async (c) => {
      const db = await getDb();
      removeCard(c);
      await dismiss(db, c.article.id, getState().sessionId, Date.now());
      showSnack('Not interested', 'UNDO', undoThen(() => undoDismiss(db, c.article.id, Date.now())));
    },
    onHide: async (c) => {
      const db = await getDb();
      removeCard(c);
      await hideArticle(db, c.article.id, getState().sessionId, Date.now());
      showSnack('Hidden', 'UNDO', undoThen(() => unhideArticle(db, c.article.id)));
    },
    onLessBecause: (c) => setLess(c),
    onMenu: (c) => setMenu(c),
    onOpenMore: async (c, m) => {
      const db = await getDb();
      if (m.articleId != null) {
        await recordOpenMore(db, c.article.id, m.articleId, getState().sessionId, Date.now());
        openArticle(m.articleId, 'coverage').catch(() => showSnack('Could not open the article'));
      } else {
        await recordOpenMore(db, c.article.id, c.article.id, getState().sessionId, Date.now());
        openInBrowser(m.url).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [patchCard, removeCard, reload]);

  const onLessPick = useCallback(async (c: SectionCard, reason: LessReason) => {
    const db = await getDb();
    removeCard(c);
    await lessBecause(db, c.article.id, reason, getState().sessionId, Date.now());
    showSnack(reason === 'source' ? `Less from ${c.sourceName}` : `Less on ${c.tags.slice(0, 2).join(', ') || 'these topics'}`, 'UNDO',
      async () => {
        await undoLessBecause(db, c.article.id, reason, Date.now());
        reload().catch(() => {});
      });
  }, [reload, removeCard]);

  // Pull to refresh: fetch again, then a new session from the top once this mode's stories are ready.
  const onPull = useCallback(async () => {
    setPulling(true);
    try {
      await runRefresh('manual');
      await startSession(true);
      await reload();
    } finally {
      setPulling(false);
    }
  }, [reload]);

  const renderRow = useCallback(({ item }: { item: Row }) => {
    if (item.kind === 'heading') {
      return <Text testID={`section-${item.key.slice(2)}`} style={[styles.heading, { color: t.text }]}>{item.title}</Text>;
    }
    if (item.kind === 'showMore') {
      return (
        <View style={{ paddingHorizontal: 12, paddingBottom: 16 }}>
          <Button testID="show-more" kind="secondary" title={`Show more (${item.left})`} onPress={() => setRevealed({ session: sessionVersion, pages: pages + 1 })} />
        </View>
      );
    }
    return <SectionCardView card={item.card} now={now} h={h} other={item.card.placement === 'other'} />;
  }, [h, now, t, pages, sessionVersion]);

  const empty = view && !rows.length;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <BudgetBanner />
      <FlatList
        ref={listRef}
        testID="sections-list"
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 90, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
        viewabilityConfig={VIEWABILITY}
        onViewableItemsChanged={seen.onViewableItemsChanged}
        initialNumToRender={5}
        windowSize={9}
        ListEmptyComponent={
          empty ? (
            refreshing ? <ActivityIndicator style={{ marginTop: 40 }} color={t.muted} /> : (
              <Empty title="You are all caught up" body="Every story here has been on screen. Pull down to check for new ones, or look in History."
                action={<Button title="Refresh" kind="secondary" onPress={onPull} testID="empty-refresh" />} />
            )
          ) : undefined
        }
      />
      {menu ? (
        <SectionMenu card={menu} modeId={modeId} onClose={() => setMenu(null)}
          onMore={async (c) => { await moreLikeThis(await getDb(), c.article.id, Date.now()); showSnack('You will see more like this'); }}
          onLess={async (c) => {
            const db = await getDb();
            removeCard(c);
            await lessLikeThis(db, c.article.id, getState().sessionId, Date.now());
            showSnack('You will see less like this', 'UNDO', async () => { await undoLess(db, c.article.id, Date.now()); reload().catch(() => {}); });
          }}
        />
      ) : null}
      {less ? <LessSheet card={less} onClose={() => setLess(null)} onPick={onLessPick} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 12 },
  swipe: { borderRadius: 14, overflow: 'hidden' },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  main: { padding: 14, gap: 6 },
  title: { fontSize: 18, lineHeight: 23, fontWeight: '700', fontFamily: 'serif' },
  summary: { fontSize: 14, lineHeight: 20 },
  why: { fontSize: 13.5, lineHeight: 19 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  source: { fontSize: 12, fontWeight: '800', maxWidth: '38%' },
  plus: { fontSize: 12, fontWeight: '700', borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  age: { fontSize: 12, flexShrink: 1 },
  btn: { marginRight: 10 },
  reason: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  reasonText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  moreList: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 6 },
  moreRow: { flexDirection: 'row', gap: 8, paddingVertical: 7 },
  heading: { fontSize: 20, fontWeight: '800', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 10 },
  action: { flex: 1, justifyContent: 'center', paddingHorizontal: 22 },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 14 },
  sheetTitle: { fontSize: 13, paddingHorizontal: 20, paddingBottom: 10, lineHeight: 18 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 15 },
  whyBox: { marginHorizontal: 16, marginBottom: 6, borderRadius: 10, padding: 12, gap: 6 },
});
