import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ListRow as Row } from '../../core/feed';
import { loadStory, markStoryChecked, unfollowStory, type StoryDetail } from '../../core/stories';
import { ageLabel } from '../../core/util';
import { getDb } from '../../platform/db';
import { openArticle } from '../../platform/open';
import { bumpData, showSnack } from '../../state/store';
import { ListRow } from '../../ui/ListRow';
import { Button, Empty, SectionTitle } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

/** One followed story: what is new since it was last opened, then everything gathered before. */
export default function StoryScreen() {
  const t = useTheme();
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const id = Number(idParam);
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Loaded once: what is "new" is fixed as it was on opening, and opening marks it all as looked at.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = await getDb();
      const st = await loadStory(db, id);
      if (cancelled) return;
      if (!st) {
        setMissing(true);
        return;
      }
      setStory(st);
      setNow(Date.now());
      await markStoryChecked(db, id, Date.now());
      bumpData();
    })().catch(() => setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onPress = useCallback((row: Row) => {
    openArticle(row.article.id, 'coverage').catch(() => showSnack('Could not open the article'));
  }, []);

  const unfollow = async () => {
    await unfollowStory(await getDb(), id);
    bumpData();
    showSnack('No longer following this story');
    router.back();
  };

  if (missing) return <Empty title="This story is no longer followed" />;
  if (!story) return <View style={{ flex: 1, backgroundColor: t.bg }} />;

  const rows = (list: Row[], prefix: string) =>
    list.map((r) => <ListRow key={r.article.id} row={r} now={now} onPress={onPress} whenLabel="published" testID={`${prefix}-${r.article.id}`} />);

  return (
    <ScrollView testID="story-screen" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: t.text }]}>{story.title}</Text>
        <Text style={[styles.meta, { color: t.faint }]}>
          {`Following for ${ageLabel(story.followedAt, now)} · ${story.fresh.length + story.earlier.length} articles`}
        </Text>
      </View>
      {story.updateSummary ? (
        <View testID="story-update" style={[styles.update, { backgroundColor: t.card, borderColor: t.accent }]}>
          <Text style={[styles.updateLabel, { color: t.accent }]}>WHAT HAS CHANGED</Text>
          <Text style={[styles.updateText, { color: t.text }]}>{story.updateSummary}</Text>
        </View>
      ) : null}
      {story.fresh.length ? (
        <View>
          <SectionTitle>{`New since you last looked (${story.fresh.length})`}</SectionTitle>
          {rows(story.fresh, 'story-new')}
        </View>
      ) : (
        <Text style={[styles.quiet, { color: t.muted }]}>Nothing new since you last looked.</Text>
      )}
      {story.earlier.length ? (
        <View>
          <SectionTitle>Earlier</SectionTitle>
          {rows(story.earlier, 'story-earlier')}
        </View>
      ) : null}
      <View style={{ margin: 16, marginTop: 24 }}>
        <Button testID="story-unfollow" title="Stop following" kind="secondary" onPress={unfollow} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 6 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontFamily: 'serif' },
  meta: { fontSize: 13, marginTop: 8 },
  update: { marginHorizontal: 12, marginTop: 12, borderRadius: 12, borderWidth: 1, padding: 14 },
  updateLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7, marginBottom: 6 },
  updateText: { fontSize: 16, lineHeight: 23, fontFamily: 'serif' },
  quiet: { fontSize: 14, marginHorizontal: 18, marginTop: 18 },
});
