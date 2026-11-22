import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { DEFAULT_SETTINGS, type Settings } from '../../core/settings';
import { updateSettings } from '../../platform/runner';
import { showSnack, useStore } from '../../state/store';
import { Button, Field, SectionTitle } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

type NumKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

interface Def {
  key: NumKey;
  label: string;
  hint?: string;
  min: number;
  max: number;
}

const WEIGHTS: Def[] = [
  { key: 'weightA', label: 'A: affinity weight', hint: 'What he opens, by source, section, topic, type, writer and length.', min: 0, max: 10 },
  { key: 'weightS', label: 'S: interest weight', hint: 'Similarity to what he has read, less what he swiped away.', min: 0, max: 10 },
  { key: 'weightF', label: 'F: freshness weight', hint: 'Halves every 8 hours.', min: 0, max: 10 },
  { key: 'weightI', label: 'I: importance weight', hint: 'More outlets covering the story.', min: 0, max: 10 },
  { key: 'coldStartDays', label: 'Cold start (days)', hint: 'While learning is this young, A and S are scaled down.', min: 0, max: 90 },
  { key: 'coldStartFactor', label: 'Cold start factor', min: 0, max: 1 },
];

const THRESHOLDS: Def[] = [
  { key: 'clusterThreshold', label: 'Same story (clustering)', hint: 'Similarity at which an article joins an existing story.', min: 0.3, max: 0.99 },
  { key: 'matchThreshold', label: 'Second-source candidate', hint: 'Lower finds more candidates; the model still has to confirm each one.', min: 0.3, max: 0.99 },
  { key: 'capMatchThreshold', label: 'Second source without the model', hint: 'Used only when the monthly budget is spent.', min: 0.3, max: 0.99 },
  { key: 'digestCoveredThreshold', label: 'Right press: already covered', hint: 'A primary article this close rules a story out.', min: 0.3, max: 0.99 },
  { key: 'digestGreyLow', label: 'Right press: ask the model above', hint: 'Between this and "already covered", the model decides.', min: 0.2, max: 0.99 },
  { key: 'followThreshold', label: 'Followed story: joins above', hint: 'How close a new article must be to the story you followed. Looser than "same story", because a running story moves on.', min: 0.3, max: 0.99 },
  { key: 'embeddingDimensions', label: 'Embedding dimensions', hint: '0 keeps the model\'s own size. Changing this affects new articles only.', min: 0, max: 4096 },
];

const PRICES: Def[] = [
  { key: 'priceChatIn', label: 'Model input price ($ per million tokens)', hint: 'Used only when a response carries no cost.', min: 0, max: 1000 },
  { key: 'priceChatOut', label: 'Model output price ($ per million tokens)', min: 0, max: 1000 },
  { key: 'priceEmbedIn', label: 'Embedding price ($ per million tokens)', min: 0, max: 1000 },
];

const ALL: Def[] = [...WEIGHTS, ...THRESHOLDS, ...PRICES];

export default function RankingScreen() {
  const t = useTheme();
  const s = useStore((st) => st.settings);
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(ALL.map((d) => [d.key, String(s[d.key])])));
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [shown, setShown] = useState(s);
  if (shown !== s) {
    // Settings changed underneath (saved, or defaults restored): show the stored values.
    setShown(s);
    setText(Object.fromEntries(ALL.map((d) => [d.key, String(s[d.key])])));
  }

  const commit = async (d: Def) => {
    const raw = (text[d.key] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < d.min || n > d.max) {
      setErrors((e) => ({ ...e, [d.key]: `Enter a number from ${d.min} to ${d.max}.` }));
      return;
    }
    setErrors((e) => ({ ...e, [d.key]: null }));
    if (n !== s[d.key]) await updateSettings({ [d.key]: n } as Partial<Settings>);
  };

  const section = (title: string, defs: Def[]) => (
    <View key={title}>
      <SectionTitle>{title}</SectionTitle>
      {defs.map((d) => (
        <Field
          key={d.key}
          testID={`ranking-${d.key}`}
          label={d.label}
          hint={d.hint}
          error={errors[d.key]}
          value={text[d.key] ?? ''}
          onChangeText={(v) => setText((p) => ({ ...p, [d.key]: v }))}
          onBlur={() => commit(d)}
          onSubmitEditing={() => commit(d)}
          keyboardType="decimal-pad"
          returnKeyType="done"
        />
      ))}
    </View>
  );

  const restore = async () => {
    const patch: Partial<Settings> = {};
    for (const d of ALL) (patch as any)[d.key] = DEFAULT_SETTINGS[d.key];
    await updateSettings(patch);
    showSnack('Defaults restored');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView testID="ranking-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 60 }}>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, margin: 16, marginBottom: 0 }}>
          score = A weight × A + S weight × S + F weight × F + I weight × I. Changes apply at the next refresh. The Debug screen
          shows recent clusters and match decisions with their scores, for tuning the thresholds on real data.
        </Text>
        {section('Score weights', WEIGHTS)}
        {section('Similarity thresholds', THRESHOLDS)}
        {section('Cost estimates', PRICES)}
        <View style={{ margin: 16, marginTop: 24 }}>
          <Button testID="ranking-restore" title="Restore defaults" kind="secondary" onPress={restore} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
