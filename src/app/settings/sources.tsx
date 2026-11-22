import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { router, useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { exportSources, importSources, listSources, sourceHealth } from '../../core/sources';
import type { Source } from '../../core/types';
import { ageLabel, errMsg } from '../../core/util';
import { getDb } from '../../platform/db';
import { secrets } from '../../platform/secrets';
import { bumpData, showSnack } from '../../state/store';
import { Button, Dot, Group, Row, SectionTitle } from '../../ui/kit';
import { healthColor, useTheme } from '../../ui/theme';

function healthText(s: Source, now: number): string {
  if (!s.enabled) return 'Off';
  if (s.lastError) return `Failed: ${s.lastError}`;
  if (!s.lastOkAt) return 'Not fetched yet';
  const h = sourceHealth(s, now);
  return h === 'amber' ? 'No new items in 24 hours' : `Fetched ${ageLabel(s.lastOkAt, now)} ago`;
}

export default function SourcesScreen() {
  const t = useTheme();
  const [sources, setSources] = useState<Source[]>([]);
  const [paste, setPaste] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    getDb().then(listSources).then((list) => {
      setSources(list);
      setNow(Date.now());
    }).catch(() => {});
  }, []);
  useFocusEffect(load);

  const doImport = async (json: string) => {
    try {
      const n = await importSources(await getDb(), secrets, json);
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
      const json = JSON.stringify(await exportSources(await getDb()), null, 2);
      if (!share) {
        setExported(json);
        return;
      }
      const file = new File(Paths.cache, 'news-reader-sources.json');
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
              subtitle={`${s.lean} · ${s.adapter === 'guardian_content_api' ? 'Guardian API' : s.adapter === 'rss' ? 'RSS' : 'Google News'} · ${healthText(s, now)}`}
              onPress={() => router.push({ pathname: '/settings/source/[id]', params: { id: String(s.id) } })}
            />
          ))}
        </Group>
      </View>
    ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView testID="sources-screen" contentContainerStyle={{ paddingBottom: 60 }}>
        {group('Primary: the For you feed', sources.filter((s) => s.role === 'primary'))}
        {group('Perspective: second sources, Right and More', sources.filter((s) => s.role === 'perspective'))}
        <View style={styles.actions}>
          <Button testID="source-add" title="Add source" onPress={() => router.push({ pathname: '/settings/source/[id]', params: { id: 'new' } })} />
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
