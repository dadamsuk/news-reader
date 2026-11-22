import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { recordReading, saveForLater, unsave } from '../../core/feed';
import { safeJson } from '../../core/util';
import { getDb } from '../../platform/db';
import { articleDirUri, writeReaderPage } from '../../platform/files';
import { openArticle, openInBrowser } from '../../platform/open';
import { bodyDeps } from '../../platform/runner';
import { ensureBody } from '../../reader/body';
import { buildReaderHtml } from '../../reader/html';
import { bumpData, getState, showSnack, useStore } from '../../state/store';
import { SummarySheet } from '../../ui/SummarySheet';
import { useTheme } from '../../ui/theme';

interface Loaded {
  id: number;
  title: string;
  url: string;
  sourceName: string;
  saved: boolean;
  second: { articleId: number; sourceName: string } | null;
  pageUri: string | null;
  /** Where the text came from: extract, api or live. */
  bodySource: string | null;
  failed: boolean;
}

export default function ReaderScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const id = Number(idParam);
  const textSize = useStore((s) => s.settings.textSize);
  const [state, setState] = useState<Loaded | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const web = useRef<any>(null);
  const maxScroll = useRef(0);
  // Time on page counts only while the app is in the foreground.
  const activeMs = useRef(0);
  const resumedAt = useRef(0);
  const themeRef = useRef({ dark: t.dark, textSize });
  const skipRecord = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = await getDb();
      const row = await db.get<any>(
        `SELECT a.id, a.title, a.url, a.byline, a.section, a.published_at, a.image_url, a.tone, s.name source_name,
                (SELECT 1 FROM read_later rl WHERE rl.article_id = a.id AND rl.done_at IS NULL) saved
         FROM article a JOIN source s ON s.id = a.source_id WHERE a.id = ?`,
        [id],
      );
      if (!row) {
        showSnack('That article is no longer stored');
        router.back();
        return;
      }
      const sec = await db.get<any>(
        `SELECT o.id, os.name FROM second_source ss JOIN article o ON o.id = ss.other_article_id
         JOIN source os ON os.id = o.source_id WHERE ss.primary_article_id = ?`,
        [id],
      );
      const base: Loaded = {
        id, title: row.title, url: row.url, sourceName: row.source_name, saved: !!row.saved,
        second: sec ? { articleId: sec.id, sourceName: sec.name } : null, pageUri: null, bodySource: null, failed: false,
      };
      if (!cancelled) setState(base);

      const res = await ensureBody(await bodyDeps(), id, { withImages: !!row.saved }).catch(() => ({ status: 'failed' as const }));
      if (cancelled) return;
      if (res.status !== 'ok') {
        // Last resort in the fallback chain: the in-app browser, which then does its own timing.
        skipRecord.current = true;
        setState({ ...base, failed: true });
        openInBrowser(row.url, id).catch(() => {});
        return;
      }
      const body = await db.get<any>('SELECT body_html, body_source, offline_images, byline FROM article WHERE id = ?', [id]);
      const html = buildReaderHtml({
        title: row.title,
        byline: row.byline,
        sourceName: row.source_name,
        section: row.section,
        publishedAt: row.published_at,
        leadImage: row.image_url,
        bodyHtml: body?.body_html ?? '',
        textSize: getState().settings.textSize,
        dark: themeRef.current.dark,
        imageMap: safeJson<Record<string, string>>(body?.offline_images, {}),
        live: body?.body_source === 'live',
      });
      const pageUri = writeReaderPage(id, html);
      if (!cancelled) setState({ ...base, pageUri, bodySource: body?.body_source ?? null });
    })().catch(() => {
      if (!cancelled) setState((s) => (s ? { ...s, failed: true } : s));
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Follow system dark mode and the text size setting without reloading the page.
  useEffect(() => {
    themeRef.current = { dark: t.dark, textSize };
    web.current?.injectJavaScript(`window.__setTheme && window.__setTheme(${t.dark ? 'true' : 'false'}, ${Math.round(textSize)}); true;`);
  }, [t.dark, textSize]);

  // Time on page and scroll depth, recorded when the reader closes.
  useEffect(() => {
    resumedAt.current = Date.now();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') resumedAt.current = Date.now();
      else {
        activeMs.current += Date.now() - resumedAt.current;
        resumedAt.current = Date.now();
      }
    });
    return () => {
      sub.remove();
      if (skipRecord.current) return;
      const dwell = (activeMs.current + (AppState.currentState === 'active' ? Date.now() - resumedAt.current : 0)) / 1000;
      getDb()
        .then((db) => recordReading(db, id, dwell, maxScroll.current, Date.now()))
        .then((res) => {
          if (res.done) showSnack('Finished: moved to History');
          bumpData();
        })
        .catch(() => {});
    };
  }, [id]);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    const msg = safeJson<any>(e.nativeEvent.data, null);
    if (!msg) return;
    if (msg.type === 'scroll' && typeof msg.pct === 'number') maxScroll.current = Math.max(maxScroll.current, msg.pct);
    else if (msg.type === 'link' && typeof msg.url === 'string' && /^https?:/i.test(msg.url)) openInBrowser(msg.url).catch(() => {});
  }, []);

  const toggleSave = useCallback(async () => {
    if (!state) return;
    const db = await getDb();
    if (state.saved) {
      await unsave(db, id, Date.now());
      setState({ ...state, saved: false });
      showSnack('Removed from Read later');
    } else {
      await saveForLater(db, id, getState().sessionId, Date.now());
      setState({ ...state, saved: true });
      showSnack('Saved to Read later');
      bodyDeps().then((d) => ensureBody(d, id, { withImages: true })).catch(() => {});
    }
    bumpData();
  }, [id, state]);

  const bar = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void, testID: string, active = false, disabled = false) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.barItem, disabled && { opacity: 0.35 }]}
      android_ripple={{ color: t.border, borderless: true }}
    >
      <Ionicons name={icon} size={22} color={active ? t.accent : t.text} />
      <Text style={[styles.barLabel, { color: active ? t.accent : t.muted }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.dark ? '#121212' : '#ffffff' }}>
      <Stack.Screen options={{ title: state?.sourceName ?? '', headerStyle: { backgroundColor: t.card } }} />
      {state?.pageUri ? (
        <View testID={`reader-body-${state.bodySource ?? 'unknown'}`} style={{ flex: 1 }} collapsable={false}>
        <WebView
          ref={web}
          testID="reader-webview"
          source={{ uri: state.pageUri }}
          originWhitelist={['*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowingReadAccessToURL={articleDirUri(id)}
          javaScriptEnabled
          domStorageEnabled={false}
          setSupportMultipleWindows={false}
          onMessage={onMessage}
          // Only the stored page itself may load in the reader; every link goes to the browser.
          onShouldStartLoadWithRequest={(req: { url: string }) => {
            if (req.url.startsWith('file://') || req.url === 'about:blank') return true;
            if (/^https?:/i.test(req.url)) openInBrowser(req.url).catch(() => {});
            return false;
          }}
          style={{ flex: 1, backgroundColor: t.dark ? '#121212' : '#ffffff' }}
          containerStyle={{ backgroundColor: t.dark ? '#121212' : '#ffffff' }}
          overScrollMode="never"
          showsVerticalScrollIndicator
          textZoom={100}
        />
        </View>
      ) : state?.failed ? (
        <View testID="reader-failed" style={styles.center}>
          <Ionicons name="document-text-outline" size={36} color={t.faint} />
          <Text style={[styles.failTitle, { color: t.text }]}>{state.title}</Text>
          <Text style={[styles.failBody, { color: t.muted }]}>
            This article could not be prepared for the reader. You can still read it on the publisher&apos;s site.
          </Text>
          <Pressable testID="reader-open-browser" onPress={() => openInBrowser(state.url, id)} style={[styles.failBtn, { backgroundColor: t.accent }]}>
            <Text style={{ color: t.onAccent, fontWeight: '700' }}>Open in browser</Text>
          </Pressable>
        </View>
      ) : (
        <View testID="reader-loading" style={styles.center}>
          <ActivityIndicator color={t.accent} />
          {state ? <Text style={[styles.failTitle, { color: t.text }]}>{state.title}</Text> : null}
        </View>
      )}
      <View style={[styles.bar, { backgroundColor: t.card, borderTopColor: t.border, paddingBottom: insets.bottom + 4 }]}>
        {bar(state?.saved ? 'bookmark' : 'bookmark-outline', state?.saved ? 'Saved' : 'Save', toggleSave, 'reader-save', !!state?.saved)}
        {state?.second
          ? bar('git-compare-outline', state.second.sourceName, () => openArticle(state.second!.articleId, 'second_source').catch(() => {}), 'reader-second')
          : null}
        {/* Summaries are written from the stored text, so only once the reader has it. */}
        {bar('list-outline', 'Summary', () => setSummaryOpen(true), 'reader-summary', false, !state?.pageUri)}
        {bar('share-outline', 'Share', () => state && Share.share({ message: state.url, url: state.url }).catch(() => {}), 'reader-share')}
        {bar('open-outline', 'Original', () => state && openInBrowser(state.url).catch(() => {}), 'reader-original')}
      </View>
      <SummarySheet articleId={id} visible={summaryOpen} onClose={() => setSummaryOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
  failTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center', fontFamily: 'serif', lineHeight: 24 },
  failBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  failBtn: { borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12, marginTop: 6 },
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
  barItem: { flex: 1, alignItems: 'center', paddingVertical: 4, gap: 2 },
  barLabel: { fontSize: 11, maxWidth: 90 },
});
