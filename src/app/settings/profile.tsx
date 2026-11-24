import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { recentSignals, resetModeLearning, tagWeightExtremes, type SignalRow } from '../../core/learning';
import { contentLines, getProfile, listProfileVersions, restoreProfileVersion, saveProfileEdit, setLinePinned, type Profile } from '../../core/profile';
import { AI_MODE_ID } from '../../core/types';
import { ageLabel, errMsg } from '../../core/util';
import { getDb } from '../../platform/db';
import { bumpData, showSnack, useStore } from '../../state/store';
import { Button, Group, Row, SectionTitle } from '../../ui/kit';
import { useTheme } from '../../ui/theme';

const KIND_LABEL: Record<string, string> = {
  more: 'More like this', interested: 'Thumbs up', save: 'Read later', read: 'Read', open: 'Opened', open_more: 'Opened another source',
  ignored: 'Seen, not opened', dismiss: 'Thumbs down', less: 'Less like this', less_source: 'Less from this source', less_topic: 'Less on these topics',
};

/**
 * Learning for a sections-layout mode: the interest profile (editable; lines you write or change
 * are pinned, and every version can be restored), the top and bottom tag weights, the last 50
 * signals, and Reset learning for this mode.
 */
export default function ProfileScreen() {
  const t = useTheme();
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();
  const modeId = Number(modeParam) || AI_MODE_ID;
  const mode = useStore((s) => s.modes.find((m) => m.id === modeId));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [versions, setVersions] = useState<Profile[]>([]);
  const [weights, setWeights] = useState<{ top: [string, number][]; bottom: [string, number][] }>({ top: [], bottom: [] });
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const db = await getDb();
    setProfile(await getProfile(db, modeId));
    setVersions(await listProfileVersions(db, modeId));
    setWeights(await tagWeightExtremes(db, modeId, 10));
    setSignals(await recentSignals(db, modeId, 50));
    setNow(Date.now());
  }, [modeId]);
  useFocusEffect(useCallback(() => {
    load().catch(() => {});
  }, [load]));

  const save = async () => {
    if (draft == null) return;
    try {
      await saveProfileEdit(await getDb(), modeId, draft, Date.now());
      setDraft(null);
      await load();
      bumpData();
      showSnack('Profile saved. Your new lines are pinned; stories waiting are scored again at the next refresh.');
    } catch (e) {
      showSnack(errMsg(e));
    }
  };

  const togglePin = useCallback(async (line: string, pinned: boolean) => {
    await setLinePinned(await getDb(), modeId, line, !pinned, Date.now());
    await load();
  }, [modeId, load]);

  const restore = (v: Profile) => {
    Alert.alert(`Restore version ${v.version}?`, 'It becomes the newest version; nothing is lost.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore', onPress: async () => { await restoreProfileVersion(await getDb(), modeId, v.version, Date.now()); await load(); bumpData(); } },
    ]);
  };

  const reset = () => {
    Alert.alert(`Reset learning for ${mode?.name ?? 'this mode'}?`, 'Tag and source weights are cleared, the starter profile comes back (earlier versions can be restored) and the cold start begins again. Other modes are not touched.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => { await resetModeLearning(await getDb(), modeId, Date.now()); await load(); bumpData(); showSnack('Learning reset for this mode'); } },
    ]);
  };

  const pinned = new Set(profile?.pinned ?? []);
  const weightRow = ([tag, w]: [string, number]) => (
    <Row key={tag} title={tag} right={<Text style={{ color: w >= 0 ? t.green : t.red, fontVariant: ['tabular-nums'], fontWeight: '700' }}>{w >= 0 ? '+' : ''}{w.toFixed(2)}</Text>} />
  );
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: `Learning: ${mode?.name ?? ''}` }} />
      <ScrollView testID="profile-screen" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 80 }}>
        <SectionTitle>Interest profile</SectionTitle>
        <Text style={[styles.note, { color: t.muted }]}>
          {profile ? `Version ${profile.version}, ${profile.createdBy === 'llm' ? 'rewritten by the model' : profile.createdBy === 'starter' ? 'the starter profile' : 'edited by you'} ${ageLabel(profile.createdAt, now)} ago. ` : ''}
          The model rewrites it from your signals weekly or after 50 signals. Lines you write or edit are pinned (📌) and kept word for word.
        </Text>
        {draft != null ? (
          <View style={{ marginHorizontal: 16, gap: 10 }}>
            <TextInput
              testID="profile-input"
              multiline
              value={draft}
              onChangeText={setDraft}
              autoCapitalize="sentences"
              textAlignVertical="top"
              style={[styles.editor, { color: t.text, backgroundColor: t.card, borderColor: t.border }]}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button testID="profile-cancel" style={{ flex: 1 }} kind="secondary" title="Cancel" onPress={() => setDraft(null)} />
              <Button testID="profile-save" style={{ flex: 1 }} title="Save" onPress={save} />
            </View>
          </View>
        ) : (
          <View style={[styles.doc, { backgroundColor: t.card, borderColor: t.border }]}>
            {(profile?.markdown ?? '').split('\n').map((raw, i) => {
              const line = raw.trim();
              if (!line) return <View key={i} style={{ height: 6 }} />;
              const heading = /^#{1,6}\s+(.*)$/.exec(line);
              if (heading) return <Text key={i} style={[styles.h, { color: t.text }]}>{heading[1]}</Text>;
              const on = pinned.has(line);
              return (
                <Pressable key={i} testID={`profile-line-${i}`} onLongPress={() => togglePin(line, on)} style={styles.line}>
                  <Text style={{ color: t.text, flex: 1, fontSize: 14, lineHeight: 20 }}>{line.replace(/^[-*]\s*/, '• ')}</Text>
                  {on ? <Text accessibilityLabel="Pinned">📌</Text> : null}
                </Pressable>
              );
            })}
            {profile && !contentLines(profile.markdown).length ? <Text style={{ color: t.faint }}>Empty</Text> : null}
          </View>
        )}
        {draft == null ? (
          <View style={{ marginHorizontal: 16, marginTop: 10, gap: 10 }}>
            <Button testID="profile-edit" kind="secondary" title="Edit profile" onPress={() => setDraft(profile?.markdown ?? '')} />
            <Text style={{ color: t.faint, fontSize: 12 }}>Long-press a line to pin or unpin it.</Text>
            <Button testID="profile-versions" kind="secondary" title={showVersions ? 'Hide earlier versions' : `Earlier versions (${Math.max(0, versions.length - 1)})`} onPress={() => setShowVersions((v) => !v)} />
          </View>
        ) : null}
        {showVersions ? (
          <Group style={{ marginTop: 10 }}>
            {versions.slice(1).map((v) => (
              <Row key={v.version} testID={`profile-version-${v.version}`} title={`Version ${v.version}`} subtitle={`${v.createdBy === 'llm' ? 'Model' : v.createdBy === 'starter' ? 'Starter' : 'You'}, ${ageLabel(v.createdAt, now)} ago`} onPress={() => restore(v)} />
            ))}
          </Group>
        ) : null}

        <SectionTitle>Topics it likes most</SectionTitle>
        <Group>{weights.top.length ? weights.top.map(weightRow) : <Row title="Nothing yet" />}</Group>
        <SectionTitle>Topics it likes least</SectionTitle>
        <Group>{weights.bottom.length ? weights.bottom.map(weightRow) : <Row title="Nothing yet" />}</Group>

        <SectionTitle>Last 50 signals</SectionTitle>
        <Group>
          {signals.length ? signals.map((s, i) => (
            <Row
              key={i}
              title={s.headline}
              subtitle={`${KIND_LABEL[s.kind] ?? s.kind}${s.section === 'other' ? ' (In other news)' : ''} · ${ageLabel(s.at, now)} ago`}
              right={<Text style={{ color: s.weight >= 0 ? t.green : t.red, fontVariant: ['tabular-nums'] }}>{s.weight >= 0 ? '+' : ''}{s.weight.toFixed(2)}</Text>}
            />
          )) : <Row title="No signals yet" />}
        </Group>

        <Group style={{ marginTop: 24 }}>
          <Row testID="profile-reset" title="Reset learning for this mode" danger onPress={reset} />
        </Group>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  note: { marginHorizontal: 16, marginBottom: 10, fontSize: 13, lineHeight: 18 },
  editor: { minHeight: 320, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14, fontFamily: 'monospace' },
  doc: { marginHorizontal: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  h: { fontSize: 15, fontWeight: '800', marginTop: 6, marginBottom: 2 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingVertical: 3 },
});
