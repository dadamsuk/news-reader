import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import { useTheme } from './theme';

export function SectionTitle({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.sectionTitle, { color: t.muted }]}>{children}</Text>;
}

export function Group({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.group, { backgroundColor: t.card, borderColor: t.border }, style]}>{children}</View>;
}

export function Row({
  title, subtitle, right, onPress, testID, danger, icon,
}: {
  title: string; subtitle?: string | null; right?: React.ReactNode; onPress?: () => void; testID?: string;
  danger?: boolean; icon?: React.ReactNode;
}) {
  const t = useTheme();
  const body = (
    <View style={[styles.row, { borderBottomColor: t.border }]}>
      {icon ? <View style={{ marginRight: 12 }}>{icon}</View> : null}
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: danger ? t.red : t.text }]}>{title}</Text>
        {subtitle ? <Text style={[styles.rowSub, { color: t.muted }]}>{subtitle}</Text> : null}
      </View>
      {right}
      {onPress && !right ? <Ionicons name="chevron-forward" size={18} color={t.faint} /> : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{body}</View>;
  return (
    <Pressable testID={testID} onPress={onPress} android_ripple={{ color: t.border }} accessibilityRole="button">
      {body}
    </Pressable>
  );
}

export function SwitchRow({
  title, subtitle, value, onChange, testID,
}: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  const t = useTheme();
  return (
    <Row
      title={title}
      subtitle={subtitle}
      right={<Switch testID={testID} value={value} onValueChange={onChange} trackColor={{ true: t.accent, false: t.border }} thumbColor="#ffffff" />}
    />
  );
}

export function Field({
  label, hint, error, style, ...input
}: TextInputProps & { label: string; hint?: string; error?: string | null }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.muted }]}>{label}</Text>
      <TextInput
        placeholderTextColor={t.faint}
        autoCapitalize="none"
        autoCorrect={false}
        {...input}
        style={[styles.input, { color: t.text, borderColor: error ? t.red : t.border, backgroundColor: t.card }, style]}
      />
      {error ? <Text style={[styles.hint, { color: t.red }]}>{error}</Text> : hint ? <Text style={[styles.hint, { color: t.faint }]}>{hint}</Text> : null}
    </View>
  );
}

export function Button({
  title, onPress, kind = 'primary', busy, disabled, testID, style, small,
}: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; busy?: boolean; disabled?: boolean;
  testID?: string; style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : 'transparent';
  const fg = kind === 'primary' ? t.onAccent : kind === 'danger' ? t.red : t.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      android_ripple={{ color: t.border }}
      style={[
        styles.button, small && styles.buttonSmall,
        { backgroundColor: bg, borderColor: kind === 'primary' ? t.accent : kind === 'danger' ? t.red : t.border, opacity: disabled ? 0.5 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[styles.buttonText, small && { fontSize: 13 }, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Choice<T extends string>({
  label, options, value, onChange, testID,
}: { label?: string; options: readonly T[]; value: T; onChange: (v: T) => void; testID?: string }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.label, { color: t.muted }]}>{label}</Text> : null}
      <View style={styles.choiceWrap}>
        {options.map((o) => {
          const on = o === value;
          return (
            <Pressable
              key={o}
              testID={testID ? `${testID}-${o}` : undefined}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => onChange(o)}
              style={[styles.chip, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : t.card }]}
            >
              <Text style={{ color: on ? t.onAccent : t.text, fontSize: 13, fontWeight: on ? '700' : '500' }}>{o}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: t.text }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: t.muted }]}>{body}</Text> : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 22, marginBottom: 8, marginHorizontal: 20 },
  group: { marginHorizontal: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 50 },
  rowTitle: { fontSize: 16 },
  rowSub: { fontSize: 13, marginTop: 2, lineHeight: 18 },
  field: { marginHorizontal: 16, marginTop: 14 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  hint: { fontSize: 12, marginTop: 5, lineHeight: 17 },
  button: { borderRadius: 10, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  buttonSmall: { paddingVertical: 7, paddingHorizontal: 12, minHeight: 34 },
  buttonText: { fontSize: 15, fontWeight: '700' },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, minHeight: 320 },
  emptyTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 8, marginBottom: 16 },
});
