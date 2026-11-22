import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { validateSourceKey } from '../core/sourceTest';
import { adapterNeedsKey, listSources } from '../core/sources';
import type { Source } from '../core/types';
import { validateOpenRouterKey } from '../llm/openrouter';
import { OPENROUTER_KEY_REF } from '../pipeline/refresh';
import { getDb } from '../platform/db';
import { appFetch } from '../platform/fetch';
import { runRefresh, updateSettings } from '../platform/runner';
import { secrets } from '../platform/secrets';
import { useStore } from '../state/store';
import { Button, Field } from '../ui/kit';
import { useTheme } from '../ui/theme';

/** First run: ask for the OpenRouter key and a key for each enabled source that needs one, and test each. */
export default function SetupScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const baseUrlSetting = useStore((s) => s.settings.openrouterBaseUrl);
  const [openrouter, setOpenrouter] = useState('');
  const [keyed, setKeyed] = useState<Source[]>([]);
  const [sourceKeys, setSourceKeys] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [ok, setOk] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [baseUrl, setBaseUrl] = useState(baseUrlSetting);
  const [shownBase, setShownBase] = useState(baseUrlSetting);
  if (shownBase !== baseUrlSetting) {
    setShownBase(baseUrlSetting);
    setBaseUrl(baseUrlSetting);
  }

  useEffect(() => {
    (async () => {
      const db = await getDb();
      const sources = (await listSources(db)).filter((s) => s.enabled && adapterNeedsKey(s.adapter));
      setKeyed(sources);
      // Keys already stored (for example after a reinstall restore) are kept.
      if (await secrets.get(OPENROUTER_KEY_REF)) setOk((o) => ({ ...o, openrouter: true }));
    })().catch(() => {});
  }, []);

  const finish = async () => {
    await updateSettings({ setupDone: true, openrouterBaseUrl: baseUrl.trim() || baseUrlSetting });
    router.replace('/');
    runRefresh('setup').catch(() => {});
  };

  const check = async () => {
    setBusy(true);
    const errs: Record<string, string | null> = {};
    const good: Record<string, boolean> = { ...ok };
    try {
      const url = baseUrl.trim() || baseUrlSetting;
      const or = openrouter.trim();
      if (or) {
        const e = await validateOpenRouterKey(appFetch, url, or);
        errs.openrouter = e;
        good.openrouter = !e;
        if (!e) await secrets.set(OPENROUTER_KEY_REF, or);
      } else if (!good.openrouter) {
        errs.openrouter = 'Enter your OpenRouter key.';
      }
      for (const s of keyed) {
        const k = (sourceKeys[s.id] ?? '').trim();
        const stored = s.apiKeyRef ? await secrets.get(s.apiKeyRef) : null;
        if (!k && stored) {
          good[`s${s.id}`] = true;
          continue;
        }
        if (!k) {
          errs[`s${s.id}`] = `Enter the key for ${s.name}.`;
          good[`s${s.id}`] = false;
          continue;
        }
        const e = await validateSourceKey(appFetch, s, k, Date.now());
        errs[`s${s.id}`] = e;
        good[`s${s.id}`] = !e;
        if (!e && s.apiKeyRef) await secrets.set(s.apiKeyRef, k);
      }
      setErrors(errs);
      setOk(good);
      const allGood = good.openrouter && keyed.every((s) => good[`s${s.id}`]);
      if (allGood) await finish();
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        testID="setup-screen"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 28, paddingBottom: insets.bottom + 32 }}
      >
        <Text style={[styles.title, { color: t.text }]}>Set up your news reader</Text>
        <Text style={[styles.body, { color: t.muted }]}>
          Everything runs on this phone. Two keys are needed: one for OpenRouter, which matches stories across outlets,
          and one for each news source that asks for one. Keys are kept in the phone&apos;s secure storage and are tested before use.
        </Text>

        <Field
          testID="setup-openrouter"
          label="OpenRouter API key"
          value={openrouter}
          onChangeText={setOpenrouter}
          placeholder={ok.openrouter ? 'Key stored. Leave blank to keep it.' : 'sk-or-…'}
          secureTextEntry
          error={errors.openrouter}
          hint={ok.openrouter ? 'This key works.' : 'From openrouter.ai, under Keys.'}
        />
        {keyed.map((s) => (
          <Field
            key={s.id}
            testID={`setup-source-${s.name.toLowerCase().replace(/\W+/g, '-')}`}
            label={`${s.name} API key`}
            value={sourceKeys[s.id] ?? ''}
            onChangeText={(v) => setSourceKeys((prev) => ({ ...prev, [s.id]: v }))}
            placeholder={ok[`s${s.id}`] ? 'Key stored. Leave blank to keep it.' : 'API key'}
            secureTextEntry
            error={errors[`s${s.id}`]}
            hint={
              ok[`s${s.id}`] ? 'This key works.'
                : s.adapter === 'guardian_content_api' ? 'Free developer key from open-platform.theguardian.com.' : undefined
            }
          />
        ))}
        {keyed.some((s) => s.adapter === 'guardian_content_api') ? (
          <Pressable onPress={() => Linking.openURL('https://open-platform.theguardian.com/access/').catch(() => {})} style={styles.link}>
            <Text style={{ color: t.accent, fontSize: 13, fontWeight: '600' }}>Get a Guardian developer key</Text>
          </Pressable>
        ) : null}

        <Pressable testID="setup-advanced" onPress={() => setAdvanced((a) => !a)} style={styles.link}>
          <Text style={{ color: t.muted, fontSize: 13 }}>{advanced ? 'Hide advanced' : 'Advanced'}</Text>
        </Pressable>
        {advanced ? (
          <Field
            testID="setup-baseurl"
            label="OpenRouter API base URL"
            value={baseUrl}
            onChangeText={setBaseUrl}
            keyboardType="url"
            hint="Only change this to use a compatible proxy."
          />
        ) : null}

        <View style={styles.buttons}>
          <Button testID="setup-check" title="Check keys and start" onPress={check} busy={busy} />
          <Button
            testID="setup-skip"
            title="Skip for now"
            kind="secondary"
            onPress={finish}
            disabled={busy}
          />
          <Text style={[styles.note, { color: t.faint }]}>
            Skipping opens the app with whatever keys have passed. Sources without a working key show a red dot in Settings,
            and stories are not matched until OpenRouter is set.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '800', marginHorizontal: 16, fontFamily: 'serif' },
  body: { fontSize: 15, lineHeight: 22, marginHorizontal: 16, marginTop: 10, marginBottom: 6 },
  link: { marginHorizontal: 16, marginTop: 12, alignSelf: 'flex-start' },
  buttons: { marginHorizontal: 16, marginTop: 26, gap: 10 },
  note: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});
