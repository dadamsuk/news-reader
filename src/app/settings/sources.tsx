import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { exportSources, importSources, listSources, sourceHealth } from '../../core/sources';
import { NEWS_MODE_ID, type Source } from '../../core/types';
import { ageLabel, errMsg } from '../../core/util';
import { getDb } from '../../platform/db';
import { secrets } from '../../platform/secrets';
import { bumpData, showSnack, useStore } from '../../state/store';
import { Button, Dot, Group, Row, SectionTitle } from '../../ui/kit';
import { healthColor, useTheme } from '../../ui/theme';

const ADAPTER_LABEL: Record<string, string> = {
  guardian_content_api: 'Guardian API', rss: 'RSS', google_news_search: 'Google News', hn_api: 'Hacker News', html_list: 'Web page',
};

function healthText(s: Source, now: number): string {
  if (!s.enabled) return 'Off';
  if (s.lastError) return `Failed: ${s.lastError}`;
  if (!s.lastOkAt) return 'Not fetched yet';
  const h = sourceHealth(s, now);
  return h === 'amber' ? 'No new items in 24 hours' : `Fetched ${ageLabel(s.lastOkAt, now)} ago`;
}

export default function SourcesScreen() {
  const t = useTheme();
  // The mode picked in Settings: each source belongs to exactly one mode.
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();
  const modeId = Number(modeParam) || NEWS_MODE_ID;
  const mode = useStore((s) => s.modes.find((m) => m.id === modeId));
  const sectionsLayout = mode?.layout.type === 'sections';
  const [sources, setSources] = useState<Source[]>([]);
  const [paste, setPaste] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    getDb().then((db) => listSources(db, modeId)).then((list) => {
      setSources(list);
      setNow(Date.now());
    }).catch(() => {});
  }, [modeId]);
  useFocusEffect(load);

  const doImport = async (json: string) => {
    try {
      const n = await importSources(await getDb(), secrets, json, modeId);
      setPaste(null);
      load();
      bumpData();
      showSnack(`${n} sources imported. Keys are not part of an export: check any that need one.`);
    } catch (e) {
      showSnack(`Import failed: ${errMsg(e)}`);
    }
  };

  const pickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      await doImport(await new File(res.assets[0].uri).text());
    } catch (e) {
      showSnack(`Import failed: ${errMsg(e)}`);
    }
  };

  // Keys are left out of the export by construction: it is built from the source records only.
  const doExport = async (share: boolean) => {
    try {
      const json = JSON.stringify(await exportSources(await getDb(), modeId), null, 2);
      if (!share) {
        setExported(json);
        return;
      }
      const file = new File(Paths.cache, `news-reader-sources-${(mode?.name ?? 'news').toLowerCase()}.json`);
      if (file.exists) file.delete();
      file.create();
      file.write(json);
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Export sources' });
    } catch (e) {
      showSnack(`Export failed: ${errMsg(e)}`);
    }
  };

  const group = (title: string, list: Source[]) =>
    list.length ? (
      <View key={title}>
        <SectionTitle>{title}</SectionTitle>
        <Group>
          {list.map((s) => (
            <Row
              key={s.id}
              testID={`source-${s.name.toLowerCase().replace(/\W+/g, '-')}`}
              icon={<View testID={`health-${sourceHealth(s, now)}-${s.id}`}><Dot color={healthColor(t, sourceHealth(s, now))} size={11} /></View>}
              title={s.name}
              subtitle={`${sectionsLayout ? `${s.priority} priority${s.isDigest ? ' · digest' : ''}` : s.lean} · ${ADAPTER_LABEL[s.adapter] ?? s.adapter} · ${healthText(s, now)}`}
              onPress={() => router.push({ pathname: '/settings/source/[id]', params: { id: String(s.id), mode: String(modeId) } })}
            />
          ))}
        </Group>
      </View>
    ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView testID="sources-screen" contentContainerStyle={{ paddingBottom: 60 }}>
        <Stack.Screen options={{ title: `Sources: ${mode?.name ?? 'News'}` }} />
        {sectionsLayout ? (
          <>
            {group('High priority: original sources', sources.filter((s) => s.priority === 'high'))}
            {group('Normal priority', sources.filter((s) => s.priority === 'normal'))}
            {group('Low priority: digests and aggregators', sources.filter((s) => s.priority === 'low'))}
          </>
        ) : (
          <>
            {group('Primary: the For you feed', sources.filter((s) => s.role === 'primary'))}
            {group('Perspective: second sources, Right and More', sources.filter((s) => s.role === 'perspective'))}
          </>
        )}
        <View style={styles.actions}>
          <Button testID="source-add" title="Add source" onPress={() => router.push({ pathname: '/settings/source/[id]', params: { id: 'new', mode: String(modeId) } })} />
          <View style={styles.pair}>
            <Button testID="sources-export" style={{ flex: 1 }} kind="secondary" title="Export JSON" onPress={() => doExport(true)} />
            <Button testID="sources-show-json" style={{ flex: 1 }} kind="secondary" title="Show JSON" onPress={() => doExport(false)} />
          </View>
          <View style={styles.pair}>
            <Button testID="sources-import-file" style={{ flex: 1 }} kind="secondary" title="Import file" onPress={pickFile} />
            <Button testID="sources-import-paste" style={{ flex: 1 }} kind="secondary" title="Paste JSON" onPress={() => setPaste('')} />
          </View>
          <Text style={{ color: t.faint, fontSize: 12, lineHeight: 17 }}>
            Importing replaces the list. Sources with the same name and type keep their articles and stored key. Exports never contain keys.
          </Text>
        </View>
      </ScrollView>

      <Modal visible={paste != null || exported != null} animationType="slide" onRequestClose={() => { setPaste(null); setExported(null); }}>
        <View style={{ flex: 1, backgroundColor: t.bg, padding: 16, paddingTop: 48 }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '700', marginBottom: 10 }}>{exported != null ? 'Sources as JSON' : 'Paste sources JSON'}</Text>
          <TextInput
            testID="sources-json"
            multiline
            editable={exported == null}
            value={exported ?? paste ?? ''}
            onChangeText={setPaste}
            autoCapitalize="none"
            autoCorrect={false}
            textAlignVertical="top"
            style={{ flex: 1, color: t.text, backgroundColor: t.card, borderColor: t.border, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 12, fontFamily: 'monospace' }}
          />
          <View style={[styles.pair, { marginTop: 12 }]}>
            <Button testID="sources-json-close" style={{ flex: 1 }} kind="secondary" title="Close" onPress={() => { setPaste(null); setExported(null); }} />
            {exported == null ? <Button testID="sources-json-import" style={{ flex: 1 }} title="Import" onPress={() => doImport(paste ?? '')} /> : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { margin: 16, marginTop: 24, gap: 10 },
  pair: { flexDirection: 'row', gap: 10 },
});
