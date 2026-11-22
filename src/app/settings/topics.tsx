import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { addRule, listRules, removeRule } from '../../core/topics';
import { DAY, type TopicRule, type TopicRuleKind } from '../../core/types';
import { getDb } from '../../platform/db';
import { bumpData, showSnack } from '../../state/store';
import { Button, Choice, Field, Group, Row, SectionTitle } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

const KINDS = ['Mute', 'Watch'] as const;
const DURATIONS = ['1 day', '1 week', '1 month', 'Until removed'] as const;
const DURATION_MS: Record<(typeof DURATIONS)[number], number | null> = {
  '1 day': DAY, '1 week': 7 * DAY, '1 month': 30 * DAY, 'Until removed': null,
};

function expiryText(r: TopicRule, now: number): string {
  if (r.expiresAt == null) return 'Until removed';
  const days = (r.expiresAt - now) / DAY;
  if (days < 1) return `Ends in ${Math.max(1, Math.round(days * 24))} hours`;
  return `Ends in ${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`;
}

/** Mute and watch lists: words or phrases matched against headlines, standfirsts, sections and topics. */
export default function TopicsScreen() {
  const t = useTheme();
  const { suggest } = useLocalSearchParams<{ suggest?: string }>();
  const suggestions = (suggest ?? '').split('|').map((x) => x.trim()).filter(Boolean);
  const [rules, setRules] = useState<TopicRule[]>([]);
  const [term, setTerm] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('Mute');
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]>('1 week');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const at = Date.now();
    setRules(await listRules(await getDb(), at));
    setNow(at);
  }, []);
  useFocusEffect(useCallback(() => {
    load().catch(() => {});
  }, [load]));

  // A mute usually has an end; a watch usually does not.
  const pickKind = (k: (typeof KINDS)[number]) => {
    setKind(k);
    setDuration(k === 'Watch' ? 'Until removed' : '1 week');
  };

  const add = async () => {
    const at = Date.now();
    const ms = DURATION_MS[duration];
    const ruleKind: TopicRuleKind = kind === 'Mute' ? 'mute' : 'watch';
    const id = await addRule(await getDb(), ruleKind, term, ms == null ? null : at + ms, at);
    if (id == null) {
      setError('Enter a word or phrase of at least two letters.');
      return;
    }
    setError(null);
    showSnack(ruleKind === 'mute' ? `Muted: ${term.trim()}` : `Watching: ${term.trim()}`);
    setTerm('');
    await load();
    bumpData();
  };

  const remove = async (r: TopicRule) => {
    await removeRule(await getDb(), r.id);
    await load();
    bumpData();
  };

  const list = (ruleKind: TopicRuleKind, title: string, empty: string) => {
    const items = rules.filter((r) => r.kind === ruleKind);
    return (
      <View>
        <SectionTitle>{title}</SectionTitle>
        {items.length ? (
          <Group>
            {items.map((r) => (
              <Row
                key={r.id}
                testID={`topic-${r.kind}-${r.id}`}
                title={r.term}
                subtitle={expiryText(r, now)}
                right={<Button small kind="secondary" title="Remove" testID={`topic-remove-${r.id}`} onPress={() => remove(r)} />}
              />
            ))}
          </Group>
        ) : (
          <Text style={[styles.empty, { color: t.faint }]}>{empty}</Text>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView testID="topics-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 60 }}>
        <Text style={[styles.intro, { color: t.muted }]}>
          A muted word or phrase hides matching stories from For you, Right press, Outside your bubble and the briefing. A watched
          one puts matching stories at the top of For you, from any source. Whole words are matched, in headlines, standfirsts,
          sections and topics.
        </Text>
        <Field
          testID="topic-term"
          label="Word or phrase"
          value={term}
          onChangeText={setTerm}
          placeholder="for example: mansion tax"
          error={error}
          returnKeyType="done"
          onSubmitEditing={add}
        />
        {suggestions.length ? (
          <View style={styles.suggest}>
            {suggestions.map((sg) => (
              <Pressable
                key={sg}
                testID={`topic-suggest-${sg}`}
                accessibilityRole="button"
                onPress={() => setTerm(sg)}
                style={[styles.chip, { borderColor: t.border, backgroundColor: t.card }]}
              >
                <Text style={{ color: t.text, fontSize: 13 }}>{sg}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Choice testID="topic-kind" options={KINDS} value={kind} onChange={pickKind} />
        <Choice testID="topic-duration" label="For how long" options={DURATIONS} value={duration} onChange={setDuration} />
        <View style={{ marginHorizontal: 16, marginTop: 16 }}>
          <Button testID="topic-add" title={kind === 'Mute' ? 'Mute it' : 'Watch it'} onPress={add} disabled={!term.trim()} />
        </View>
        {list('mute', 'Muted', 'Nothing is muted.')}
        {list('watch', 'Watched', 'Nothing is watched.')}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 13, lineHeight: 19, margin: 16, marginBottom: 0 },
  suggest: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginHorizontal: 16, marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7 },
  empty: { fontSize: 14, marginHorizontal: 20 },
});
