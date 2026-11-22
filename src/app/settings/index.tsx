import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { resetLearning } from '../../core/ranking';
import type { Settings } from '../../core/settings';
import { validateOpenRouterKey } from '../../llm/openrouter';
import { OPENROUTER_KEY_REF } from '../../pipeline/refresh';
import { registerBackgroundRefresh } from '../../platform/background';
import { checkpointAndGetPath, getDb } from '../../platform/db';
import { appFetch } from '../../platform/fetch';
import { reloadSettings, updateSettings } from '../../platform/runner';
import { secrets } from '../../platform/secrets';
import { bumpData, showSnack, useStore } from '../../state/store';
import { Button, Field, Group, Row, SectionTitle, SwitchRow } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

/** A text field that saves a setting when editing ends, after checking it. */
function SettingField({
  label, value, onSave, numeric, hint, testID, min, max, allowEmpty,
}: {
  label: string; value: string | number; onSave: (v: string) => Promise<void> | void; numeric?: boolean; hint?: string;
  testID?: string; min?: number; max?: number; allowEmpty?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // The stored value changed underneath (saved, or restored): show it.
    setShown(value);
    setText(String(value));
  }
  const commit = async () => {
    const v = text.trim();
    if (v === String(value)) return;
    if (numeric) {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || (min != null && n < min) || (max != null && n > max)) {
        setError(`Enter a number${min != null ? ` from ${min}` : ''}${max != null ? ` to ${max}` : ''}.`);
        return;
      }
    } else if (!v && !allowEmpty) {
      setError('This cannot be empty.');
      return;
    }
    setError(null);
    await onSave(v);
  };
  return (
    <Field
      testID={testID}
      label={label}
      value={text}
      onChangeText={setText}
      onBlur={commit}
      onSubmitEditing={commit}
      keyboardType={numeric ? 'decimal-pad' : 'default'}
      returnKeyType="done"
      hint={hint}
      error={error}
    />
  );
}

export default function SettingsScreen() {
  const t = useTheme();
  const s = useStore((st) => st.settings);
  const spend = useStore((st) => st.monthSpend);
  const over = useStore((st) => st.overBudget);
  const [keySet, setKeySet] = useState<boolean | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    reloadSettings().catch(() => {});
    secrets.get(OPENROUTER_KEY_REF).then((k) => setKeySet(!!k));
  }, []);

  const save = (patch: Partial<Settings>) => updateSettings(patch).catch(() => showSnack('Could not save that setting'));

  const saveKey = async () => {
    const k = newKey.trim();
    if (!k) return;
    setBusy(true);
    try {
      const err = await validateOpenRouterKey(appFetch, s.openrouterBaseUrl, k);
      setKeyError(err);
      if (err) return;
      await secrets.set(OPENROUTER_KEY_REF, k);
      setKeySet(true);
      setEditingKey(false);
      setNewKey('');
      showSnack('OpenRouter key saved');
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = () => {
    Alert.alert('Reset learning?', 'Ranking goes back to its cold-start behaviour. Read later, History and sources are not touched.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          await resetLearning(await getDb(), Date.now());
          await reloadSettings();
          bumpData();
          showSnack('Learning reset');
        },
      },
    ]);
  };

  // Shares the SQLite file. API keys are never in it: they live in secure storage.
  const exportDb = async () => {
    try {
      const path = await checkpointAndGetPath();
      const src = new File(path.startsWith('file://') ? path : `file://${path}`);
      const dest = new File(Paths.cache, 'news-reader-export.db');
      if (dest.exists) dest.delete();
      src.copy(dest);
      await Sharing.shareAsync(dest.uri, { mimeType: 'application/x-sqlite3', dialogTitle: 'Export database' });
    } catch (e) {
      showSnack(`Export failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView testID="settings-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 60 }}>
        <SectionTitle>OpenRouter</SectionTitle>
        <Group>
          <Row
            testID="settings-openrouter-key"
            title="API key"
            subtitle={keySet == null ? '' : keySet ? 'Stored in secure storage' : 'Not set: stories cannot be matched'}
            right={<Button small kind="secondary" title={keySet ? 'Replace' : 'Add'} onPress={() => setEditingKey((e) => !e)} testID="settings-key-edit" />}
          />
        </Group>
        {editingKey ? (
          <View>
            <Field testID="settings-key-input" label="New OpenRouter key" value={newKey} onChangeText={setNewKey} secureTextEntry placeholder="sk-or-…" error={keyError} />
            <View style={{ marginHorizontal: 16, marginTop: 10 }}>
              <Button testID="settings-key-save" title="Test and save" onPress={saveKey} busy={busy} />
            </View>
          </View>
        ) : null}
        <SettingField testID="settings-embedding-model" label="Embedding model ID" value={s.embeddingModel} onSave={(v) => save({ embeddingModel: v })} />
        <SettingField testID="settings-chat-model" label="Matching and summary model ID" value={s.chatModel} onSave={(v) => save({ chatModel: v })} hint="A newer or cheaper model can be swapped in here." />

        <SectionTitle>Budget</SectionTitle>
        <Group>
          <Row
            testID="settings-spend"
            title={`Spent this month: $${spend.toFixed(spend < 1 ? 3 : 2)}`}
            subtitle={over ? 'Budget reached: angle notes and summaries are paused until the 1st.' : `Of a $${s.monthlyBudgetUsd} monthly budget`}
          />
        </Group>
        <SettingField testID="settings-budget" label="Monthly budget (USD)" value={s.monthlyBudgetUsd} numeric min={0} max={1000} onSave={(v) => save({ monthlyBudgetUsd: Number(v) })} />

        <SectionTitle>Sources</SectionTitle>
        <Group>
          <Row testID="settings-sources" title="Sources" subtitle="Outlets, roles, leans, feeds and keys" onPress={() => router.push('/settings/sources')} />
        </Group>
        <SettingField
          testID="settings-preference"
          label="Second-source preference"
          value={s.secondSourcePreference.join(', ')}
          onSave={(v) => save({ secondSourcePreference: v.split(',').map((x) => x.trim()).filter(Boolean) })}
          allowEmpty
          hint="Source names in order, separated by commas. Leave empty to prefer the lean furthest from the primary."
        />

        <SectionTitle>Refresh and reading</SectionTitle>
        <SettingField
          testID="settings-refresh"
          label="Background refresh interval (minutes)"
          value={s.refreshMinutes}
          numeric
          min={15}
          max={720}
          onSave={async (v) => {
            await save({ refreshMinutes: Number(v) });
            registerBackgroundRefresh(Number(v)).catch(() => {});
          }}
          hint="A request to the system, which decides the actual timing. The app also refreshes whenever it is opened."
        />
        <Group style={{ marginTop: 14 }}>
          <SwitchRow
            testID="settings-wifi"
            title="Prefetch on Wi-Fi only"
            subtitle="Article text and pictures for the top of the feed and Read later"
            value={s.wifiOnlyPrefetch}
            onChange={(v) => save({ wifiOnlyPrefetch: v })}
          />
          <Row
            title="Reader text size"
            subtitle={`${s.textSize} px`}
            right={
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button small kind="secondary" title="A−" testID="settings-text-smaller" onPress={() => save({ textSize: Math.max(14, s.textSize - 1) })} />
                <Button small kind="secondary" title="A+" testID="settings-text-larger" onPress={() => save({ textSize: Math.min(28, s.textSize + 1) })} />
              </View>
            }
          />
        </Group>

        <SectionTitle>Learning</SectionTitle>
        <Group>
          <Row testID="settings-ranking" title="Ranking weights and thresholds" onPress={() => router.push('/settings/ranking')} />
          <Row testID="settings-reset-learning" title="Reset learning" danger onPress={confirmReset} />
        </Group>

        <SectionTitle>Data</SectionTitle>
        <Group>
          <Row testID="settings-export-db" title="Export database" subtitle="Shares the SQLite file. It contains no API keys." onPress={exportDb} />
          <Row testID="settings-debug" title="Debug" subtitle="Refresh runs, clusters, match decisions" onPress={() => router.push('/settings/debug')} />
        </Group>
        <Pressable onPress={() => router.push('/setup')} style={{ margin: 20 }}>
          <Text style={{ color: t.faint, fontSize: 13 }}>Run key setup again</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
