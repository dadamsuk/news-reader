import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import { loadReadLater, markDone, undoDone, type ListRow as Row } from '../../core/feed';
import { getDb } from '../../platform/db';
import { openArticle } from '../../platform/open';
import { bumpData, showSnack, useStore } from '../../state/store';
import { ListRow } from '../../ui/ListRow';
import { Empty } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

export default function ReadLaterScreen() {
  const t = useTheme();
  const dataVersion = useStore((s) => s.dataVersion);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    getDb()
      .then((db) => loadReadLater(db))
      .then((r) => {
        setRows(r);
        setNow(Date.now());
      })
      .catch(() => setRows([]));
  }, [dataVersion]);

  const onPress = useCallback((row: Row) => {
    openArticle(row.article.id, 'feed').catch(() => showSnack('Could not open the article'));
  }, []);

  // Swiping marks an item done by hand; it moves to History.
  const onSwipe = useCallback(async (row: Row) => {
    const db = await getDb();
    setRows((prev) => (prev ?? []).filter((r) => r.article.id !== row.article.id));
    await markDone(db, row.article.id, Date.now());
    showSnack('Done: moved to History', 'UNDO', async () => {
      await undoDone(db, row.article.id);
      bumpData();
    });
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        testID="later-list"
        data={rows ?? []}
        keyExtractor={(r) => String(r.article.id)}
        renderItem={({ item }) => (
          <ListRow row={item} now={now} onPress={onPress} onSwipe={onSwipe} swipeLabel="Done" whenLabel="saved" testID={`later-${item.article.id}`} />
        )}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 90, flexGrow: 1 }}
        ListEmptyComponent={
          rows ? <Empty title="Nothing saved" body="Swipe a card to the right, or tap its bookmark, to keep it here. Saved articles are stored for offline reading." /> : undefined
        }
      />
    </View>
  );
}
