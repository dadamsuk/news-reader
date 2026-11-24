import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { loadHistory, type ListRow as Row } from '../../core/feed';
import { getDb } from '../../platform/db';
import { openArticle } from '../../platform/open';
import { showSnack, useStore } from '../../state/store';
import { ListRow } from '../../ui/ListRow';
import { Empty } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

export default function HistoryScreen() {
  const t = useTheme();
  const dataVersion = useStore((s) => s.dataVersion);
  // History lists the current mode's items only.
  const modeId = useStore((s) => s.settings.currentModeId);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    // A short pause while typing keeps the search from running on every keystroke.
    const timer = setTimeout(() => {
      getDb()
        .then((db) => loadHistory(db, Date.now(), query, 300, modeId))
        .then((r) => {
          if (mine !== seq.current) return;
          setRows(r);
          setNow(Date.now());
        })
        .catch(() => setRows([]));
    }, query ? 180 : 0);
    return () => clearTimeout(timer);
  }, [query, dataVersion, modeId]);

  // Opening from History reads the article; it does not go back into the feed.
  const onPress = useCallback((row: Row) => {
    openArticle(row.article.id, 'feed').catch(() => showSnack('Could not open the article'));
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.searchWrap, { backgroundColor: t.card, borderColor: t.border }]}>
        <Ionicons name="search" size={18} color={t.faint} />
        <TextInput
          testID="history-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Search headlines"
          placeholderTextColor={t.faint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.search, { color: t.text }]}
        />
        {query ? (
          <Pressable testID="history-clear" hitSlop={10} onPress={() => setQuery('')} accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={t.faint} />
          </Pressable>
        ) : null}
      </View>
      <FlatList
        testID="history-list"
        data={rows ?? []}
        keyExtractor={(r) => String(r.article.id)}
        renderItem={({ item }) => <ListRow row={item} now={now} onPress={onPress} whenLabel="seen" testID={`history-${item.article.id}`} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 90, flexGrow: 1 }}
        initialNumToRender={10}
        windowSize={9}
        ListEmptyComponent={
          rows ? (
            <Empty
              title={query ? 'No headline matches' : 'Nothing seen yet'}
              body={query ? 'Only articles seen in the last 14 days are searched.' : 'Every story that has been on screen in the last 14 days is listed here.'}
            />
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 12, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  search: { flex: 1, fontSize: 15, paddingVertical: 10 },
});
