import Constants from 'expo-constants';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import {
  dismiss, lessLikeThis, loadDigest, loadFeed, moreLikeThis, saveForLater, undoDismiss, unsave,
} from '../../core/feed';
import type { DigestItem, DigestOutlet, FeedCard } from '../../core/types';
import { getDb } from '../../platform/db';
import { openArticle } from '../../platform/open';
import { bodyDeps, launchedIntoFeed, runRefresh, startSession } from '../../platform/runner';
import { ensureBody } from '../../reader/body';
import { APP_START, getState, setState, showSnack, useStore } from '../../state/store';
import { ArticleCard, type CardHandlers } from '../../ui/ArticleCard';
import { DigestCard } from '../../ui/DigestCard';
import { Button, Empty } from '../../ui/kit';
import { BudgetBanner, CardMenu } from '../../ui/overlays';
import { VIEWABILITY, auditReset, auditScroll, auditSetHeight, auditSetOrder, useSeenTracker, type SeenEntry } from '../../ui/seen';
import { useTheme } from '../../ui/theme';

const AUDIT = !!Constants.expoConfig?.extra?.e2e;
const LIST_PADDING_TOP = 12;

type Tab = 'foryou' | 'right';

export default function FeedScreen() {
  const t = useTheme();
  const sessionId = useStore((s) => s.sessionId);
  const sessionVersion = useStore((s) => s.sessionVersion);
  const dataVersion = useStore((s) => s.dataVersion);
  const refreshing = useStore((s) => s.refreshing);
  const [tab, setTab] = useState<Tab>('foryou');
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [digest, setDigest] = useState<DigestItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [menuCard, setMenuCard] = useState<FeedCard | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const feedRef = useRef<FlatList<FeedCard>>(null);
  const digestRef = useRef<FlatList<DigestItem>>(null);
  const loadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    const db = await getDb();
    const s = getState();
    const at = Date.now();
    const [f, d] = await Promise.all([loadFeed(db, s.settings, s.sessionId, at), loadDigest(db, s.settings, s.sessionId, at)]);
    if (seq !== loadSeq.current) return; // a newer load is on its way
    setCards(f);
    setDigest(d);
    setNow(at);
    setLoaded(true);
    // Only a launch that went straight to the feed is a fair measure (not one that began at setup).
    if (getState().feedReadyMs == null) setState({ feedReadyMs: launchedIntoFeed() ? Date.now() - APP_START : -1 });
  }, []);

  useEffect(() => {
    reload().catch(() => setLoaded(true));
  }, [reload, sessionVersion, dataVersion]);

  // A new session starts at the top with only unseen articles.
  useEffect(() => {
    feedRef.current?.scrollToOffset({ offset: 0, animated: false });
    digestRef.current?.scrollToOffset({ offset: 0, animated: false });
    if (AUDIT) auditReset();
  }, [sessionVersion]);

  // ----- seen rule -----
  const feedEntries = useMemo<SeenEntry[]>(
    () => cards.map((c) => ({
      key: c.article.id,
      impressions: c.second
        ? [{ articleId: c.article.id, surface: 'feed' as const }, { articleId: c.second.articleId, surface: 'second_source' as const }]
        : [{ articleId: c.article.id, surface: 'feed' as const }],
    })),
    [cards],
  );
  const digestEntries = useMemo<SeenEntry[]>(
    () => digest.map((d) => ({ key: d.clusterId, impressions: d.outlets.map((o) => ({ articleId: o.articleId, surface: 'digest' as const })) })),
    [digest],
  );
  const feedSeen = useSeenTracker(feedEntries, tab === 'foryou', sessionId);
  const digestSeen = useSeenTracker(digestEntries, tab === 'right', sessionId);

  useEffect(() => {
    if (AUDIT) auditSetOrder(cards.map((c) => ({ id: c.article.id, title: c.article.title })), feedSeen.recorded.current);
  }, [cards, feedSeen.recorded, sessionVersion]);
  const viewportH = useRef(0);

  // ----- actions -----
  const patchCard = useCallback((id: number, patch: Partial<FeedCard>) => {
    setCards((prev) => prev.map((c) => (c.article.id === id ? { ...c, ...patch } : c)));
  }, []);

  const handlers = useMemo<CardHandlers>(() => ({
    onOpen: (card) => {
      openArticle(card.article.id, 'feed').catch(() => showSnack('Could not open the article'));
    },
    onOpenSecond: (card) => {
      if (card.second) openArticle(card.second.articleId, 'second_source').catch(() => showSnack('Could not open the article'));
    },
    onSave: async (card) => {
      const id = card.article.id;
      const db = await getDb();
      if (card.saved) {
        await unsave(db, id, Date.now());
        patchCard(id, { saved: false });
        showSnack('Removed from Read later');
        return;
      }
      await saveForLater(db, id, getState().sessionId, Date.now());
      patchCard(id, { saved: true });
      showSnack('Saved to Read later', 'UNDO', async () => {
        await unsave(db, id, Date.now());
        patchCard(id, { saved: false });
      });
      // Fetch the text and pictures now, so it reads offline (one article, any network).
      bodyDeps().then((d) => ensureBody(d, id, { withImages: true })).catch(() => {});
    },
    onDismiss: async (card) => {
      const id = card.article.id;
      const db = await getDb();
      setCards((prev) => prev.filter((c) => c.article.id !== id));
      await dismiss(db, id, getState().sessionId, Date.now());
      showSnack('Not interested', 'UNDO', async () => {
        await undoDismiss(db, id);
        reload().catch(() => {});
      });
    },
    onMenu: (card) => setMenuCard(card),
  }), [patchCard, reload]);

  const menuActions = useMemo(() => ({
    onMore: async (card: FeedCard) => {
      await moreLikeThis(await getDb(), card.article.id, Date.now());
      showSnack('You will see more like this');
    },
    onLess: async (card: FeedCard) => {
      const id = card.article.id;
      setCards((prev) => prev.filter((c) => c.article.id !== id));
      await lessLikeThis(await getDb(), id, getState().sessionId, Date.now());
      showSnack('You will see less like this');
    },
  }), []);

  const onOpenOutlet = useCallback((o: DigestOutlet) => {
    openArticle(o.articleId, 'digest').catch(() => showSnack('Could not open the article'));
  }, []);

  // Pull to refresh fetches the sources again and ends the session: seen cards go and the new
  // ranking starts from the top. The spinner stays until the new stories are ready, but not for
  // more than 25 seconds on a slow connection (they then arrive below what is on screen).
  const onPull = useCallback(async () => {
    setPulling(true);
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        runRefresh('manual', undefined, done).then(done, done);
      });
      await startSession(true);
      await reload();
    } finally {
      setPulling(false);
    }
  }, [reload]);

  const renderCard = useCallback(
    ({ item }: { item: FeedCard }) =>
      AUDIT ? (
        <View onLayout={(e) => auditSetHeight(item.article.id, e.nativeEvent.layout.height)}>
          <ArticleCard card={item} now={now} handlers={handlers} />
        </View>
      ) : (
        <ArticleCard card={item} now={now} handlers={handlers} />
      ),
    [handlers, now],
  );
  const renderDigest = useCallback(
    ({ item }: { item: DigestItem }) => <DigestCard item={item} now={now} onOpenOutlet={onOpenOutlet} />,
    [now, onOpenOutlet],
  );

  const refreshControl = (
    <RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />
  );
  const tabButton = (key: Tab, label: string, count: number) => {
    const on = tab === key;
    return (
      <Pressable
        testID={`feedtab-${key}`}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        onPress={() => setTab(key)}
        style={[styles.tab, { borderBottomColor: on ? t.accent : 'transparent' }]}
      >
        <Text style={[styles.tabText, { color: on ? t.text : t.faint }]}>{label}</Text>
        {key === 'right' && count > 0 ? (
          <View style={[styles.badge, { backgroundColor: on ? t.accent : t.border }]}>
            <Text style={{ color: on ? t.onAccent : t.muted, fontSize: 11, fontWeight: '700' }}>{count}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.tabs, { backgroundColor: t.card, borderBottomColor: t.border }]}>
        {tabButton('foryou', 'For you', cards.length)}
        {tabButton('right', 'Right press', digest.filter((d) => d.seenAt == null).length)}
      </View>
      <BudgetBanner />
      <View style={{ flex: 1, display: tab === 'foryou' ? 'flex' : 'none' }}>
        <FlatList
          ref={feedRef}
          testID="feed-list"
          data={cards}
          keyExtractor={(c) => String(c.article.id)}
          renderItem={renderCard}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          viewabilityConfig={VIEWABILITY}
          onViewableItemsChanged={feedSeen.onViewableItemsChanged}
          onLayout={(e) => {
            viewportH.current = e.nativeEvent.layout.height;
            if (AUDIT) auditScroll(0, viewportH.current, LIST_PADDING_TOP);
          }}
          onScroll={AUDIT ? (e) => auditScroll(e.nativeEvent.contentOffset.y, viewportH.current, LIST_PADDING_TOP) : undefined}
          scrollEventThrottle={AUDIT ? 16 : undefined}
          initialNumToRender={5}
          maxToRenderPerBatch={6}
          windowSize={9}
          removeClippedSubviews
          ListEmptyComponent={
            loaded ? (
              <Empty
                title={refreshing ? 'Fetching the news…' : 'You are all caught up'}
                body={refreshing ? 'The first refresh takes a little while.' : 'Every story here has been on screen. Pull down to check for new ones, or look in History.'}
                action={refreshing ? undefined : <Button title="Refresh" kind="secondary" onPress={onPull} testID="empty-refresh" />}
              />
            ) : undefined
          }
        />
      </View>
      <View style={{ flex: 1, display: tab === 'right' ? 'flex' : 'none' }}>
        <FlatList
          ref={digestRef}
          testID="digest-list"
          data={digest}
          keyExtractor={(d) => String(d.clusterId)}
          renderItem={renderDigest}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          viewabilityConfig={VIEWABILITY}
          onViewableItemsChanged={digestSeen.onViewableItemsChanged}
          initialNumToRender={4}
          windowSize={7}
          ListHeaderComponent={
            digest.length ? (
              <Text style={[styles.digestIntro, { color: t.muted }]}>
                Stories two or more right-leaning outlets are running that your primary sources have not covered.
              </Text>
            ) : undefined
          }
          ListEmptyComponent={
            loaded ? (
              <Empty
                title="Nothing here right now"
                body="This lists stories that at least two right-leaning outlets ran in the last 36 hours and no primary source has covered."
              />
            ) : undefined
          }
        />
      </View>
      <CardMenu card={menuCard} onClose={() => setMenuCard(null)} actions={menuActions} />
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: 3 },
  tabText: { fontSize: 15, fontWeight: '700' },
  badge: { borderRadius: 9, minWidth: 18, paddingHorizontal: 5, paddingVertical: 1, alignItems: 'center' },
  listContent: { paddingTop: LIST_PADDING_TOP, paddingBottom: 90, flexGrow: 1 },
  digestIntro: { fontSize: 13, lineHeight: 18, paddingHorizontal: 18, paddingBottom: 12 },
});
