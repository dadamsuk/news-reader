import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { testSource, type SourceTestResult } from '../../../core/sourceTest';
import {
  adapterNeedsKey, createSource, deleteSource, duplicateSource, getSource, sourceHealth, updateSource,
} from '../../../core/sources';
import { ADAPTERS, LEANS, READER_MODES, ROLES, type Source, type SourceInput } from '../../../core/types';
import { ageLabel, errMsg } from '../../../core/util';
import { getDb } from '../../../platform/db';
import { appFetch } from '../../../platform/fetch';
import { secrets } from '../../../platform/secrets';
import { bumpData, showSnack } from '../../../state/store';
import { Button, Choice, Dot, Field, Group, SwitchRow } from '../../../ui/kit';
import { healthColor, useTheme } from '../../../ui/theme';

const BLANK: SourceInput = {
  name: '', adapter: 'rss', endpoint: '', apiKeyRef: null, role: 'perspective', lean: 'centre', readerMode: 'extract',
  paywalled: false, includeSections: [], excludeSections: [], refreshMinutes: 30, enabled: true,
};

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** A form for every field of a source record, plus Test, Duplicate and Delete. */
export default function SourceScreen() {
  const t = useTheme();
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const isNew = idParam === 'new';
  const id = isNew ? null : Number(idParam);
  const [original, setOriginal] = useState<Source | null>(null);
  const [f, setF] = useState<SourceInput>(BLANK);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [apiKey, setApiKey] = useState('');
  const [keyStored, setKeyStored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<SourceTestResult | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (id == null) return;
    (async () => {
      const s = await getSource(await getDb(), id);
      if (!s) {
        router.back();
        return;
      }
      setOriginal(s);
      setF(s);
      setInclude(s.includeSections.join(', '));
      setExclude(s.excludeSections.join(', '));
      setMinutes(String(s.refreshMinutes));
      setKeyStored(!!(s.apiKeyRef && (await secrets.get(s.apiKeyRef))));
    })().catch(() => {});
  }, [id]);

  const current = (): SourceInput => ({
    ...f, includeSections: list(include), excludeSections: list(exclude), refreshMinutes: Number(minutes) || 0,
  });

  const save = async (): Promise<number | null> => {
    setBusy('save');
    setError(null);
    try {
      const db = await getDb();
      let savedId = id;
      if (id == null) savedId = await createSource(db, current());
      else await updateSource(db, id, current());
      const saved = await getSource(db, savedId!);
      if (apiKey.trim() && saved?.apiKeyRef) {
        await secrets.set(saved.apiKeyRef, apiKey.trim());
        setApiKey('');
        setKeyStored(true);
      }
      bumpData();
      return savedId;
    } catch (e) {
      setError(errMsg(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    const saved = await save();
    if (saved != null) {
      showSnack('Saved. Changes apply at the next refresh.');
      router.back();
    }
  };

  // Test uses the form as it stands, saved or not: fetch once, show the first five items or the error.
  const onTest = async () => {
    setBusy('test');
    setResult(null);
    try {
      const typed = apiKey.trim();
      const stored = original?.apiKeyRef ? await secrets.get(original.apiKeyRef) : null;
      setResult(await testSource(appFetch, { ...current() }, typed || stored, Date.now()));
      setNow(Date.now());
    } finally {
      setBusy(null);
    }
  };

  const onDuplicate = async () => {
    if (id == null) return;
    try {
      const copy = await duplicateSource(await getDb(), id);
      showSnack('Duplicated. The copy is switched off until you enable it.');
      router.replace({ pathname: '/settings/source/[id]', params: { id: String(copy) } });
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onDelete = () => {
    if (id == null) return;
    Alert.alert(`Delete ${f.name}?`, 'Its articles are removed too.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteSource(await getDb(), secrets, id);
            bumpData();
            router.back();
          } catch (e) {
            setError(errMsg(e));
          }
        },
      },
    ]);
  };

  const health = original ? sourceHealth(original, now) : 'grey';
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: isNew ? 'New source' : f.name || 'Source' }} />
      <ScrollView testID="source-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 80 }}>
        {original ? (
          <View style={styles.health}>
            <Dot color={healthColor(t, health)} size={11} />
            <Text testID="source-health" style={{ color: t.muted, fontSize: 13, flex: 1 }}>
              {original.lastError
                ? `Last fetch failed: ${original.lastError}`
                : original.lastOkAt ? `Last success ${ageLabel(original.lastOkAt, now)} ago${health === 'amber' ? ', but nothing new in 24 hours' : ''}` : 'Not fetched yet'}
            </Text>
          </View>
        ) : null}

        <Field testID="source-name" label="Name" value={f.name} onChangeText={(name) => setF({ ...f, name })} autoCapitalize="words" hint="Shown on cards and in the reader." />
        <Choice testID="source-adapter" label="Adapter" options={ADAPTERS} value={f.adapter} onChange={(adapter) => setF({ ...f, adapter })} />
        <Field
          testID="source-endpoint"
          label={f.adapter === 'google_news_search' ? 'Search query' : 'Endpoint'}
          value={f.endpoint}
          onChangeText={(endpoint) => setF({ ...f, endpoint })}
          multiline
          keyboardType={f.adapter === 'google_news_search' ? 'default' : 'url'}
          hint={
            f.adapter === 'google_news_search' ? 'A Google News search, for example site:thetimes.com'
              : f.adapter === 'rss' ? 'One feed URL per line.' : 'The Content API search URL. Query and section parameters may be added.'
          }
          style={{ minHeight: 64, textAlignVertical: 'top' }}
        />
        {adapterNeedsKey(f.adapter) ? (
          <Field
            testID="source-apikey"
            label="API key"
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
            placeholder={keyStored ? 'Key stored. Type to replace it.' : 'Required for this adapter'}
            hint="Held in the phone's secure storage, never in the database or an export."
          />
        ) : null}
        <Choice testID="source-role" label="Role" options={ROLES} value={f.role} onChange={(role) => setF({ ...f, role })} />
        <Choice testID="source-lean" label="Lean" options={LEANS} value={f.lean} onChange={(lean) => setF({ ...f, lean })} />
        <Choice testID="source-reader" label="Reader mode" options={READER_MODES} value={f.readerMode} onChange={(readerMode) => setF({ ...f, readerMode })} />
        <Group style={{ marginTop: 16 }}>
          <SwitchRow testID="source-paywalled" title="Paywalled" subtitle="Paywalled sources open in the in-app browser, never the reader's extractor" value={f.paywalled} onChange={(paywalled) => setF({ ...f, paywalled })} />
          <SwitchRow testID="source-enabled" title="Enabled" subtitle="Off sources are kept but not fetched" value={f.enabled} onChange={(enabled) => setF({ ...f, enabled })} />
        </Group>
        <Field testID="source-include" label="Include sections" value={include} onChangeText={setInclude} hint="Comma separated. Empty means everything. Matches section, category or URL path." />
        <Field testID="source-exclude" label="Exclude sections" value={exclude} onChangeText={setExclude} hint="Comma separated." />
        <Field testID="source-minutes" label="Refresh minutes" value={minutes} onChangeText={setMinutes} keyboardType="number-pad" hint="Minimum gap between fetches of this source." />

        {error ? <Text testID="source-error" style={[styles.error, { color: t.red }]}>{error}</Text> : null}

        <View style={styles.actions}>
          <Button testID="source-save" title="Save" onPress={onSave} busy={busy === 'save'} />
          <Button testID="source-test" title="Test" kind="secondary" onPress={onTest} busy={busy === 'test'} />
          {!isNew ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button testID="source-duplicate" style={{ flex: 1 }} title="Duplicate" kind="secondary" onPress={onDuplicate} />
              <Button testID="source-delete" style={{ flex: 1 }} title="Delete" kind="danger" onPress={onDelete} />
            </View>
          ) : null}
        </View>

        {result ? (
          <View testID="source-test-result" style={[styles.result, { backgroundColor: t.card, borderColor: result.error ? t.red : t.border }]}>
            <Text style={{ color: result.error ? t.red : t.green, fontWeight: '700', marginBottom: 6 }}>
              {result.error ? `Error: ${result.error}` : `Working: ${result.total} items. First five:`}
            </Text>
            {result.items.map((it, i) => (
              <Text key={i} style={{ color: t.text, fontSize: 13, lineHeight: 19, marginBottom: 4 }}>
                {i + 1}. {it.title}
                <Text style={{ color: t.faint }}>{it.publishedAt ? `  ${ageLabel(it.publishedAt, now)}` : ''}{it.section ? `  ${it.section}` : ''}</Text>
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  health: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 14 },
  actions: { marginHorizontal: 16, marginTop: 22, gap: 10 },
  error: { marginHorizontal: 16, marginTop: 14, fontSize: 14 },
  result: { margin: 16, borderRadius: 10, borderWidth: 1, padding: 12 },
});
