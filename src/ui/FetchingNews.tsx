import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import { useTheme } from './theme';

const PULSE_MS = 700;

/** One placeholder card, shaped like an article card, pulsing gently after `delay` ms. */
function SkeletonCard({ delay }: { delay: number }) {
  const t = useTheme();
  const glow = useSharedValue(0);
  useEffect(() => {
    // ReduceMotion.System: with the phone's "remove animations" on, the cards simply stay still.
    const ease = { duration: PULSE_MS, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.System };
    glow.value = withDelay(delay, withRepeat(withSequence(withTiming(1, ease), withTiming(0, ease)), -1, false, undefined, ReduceMotion.System));
  }, [delay, glow]);
  const style = useAnimatedStyle(() => ({ opacity: 0.45 + glow.value * 0.4 }));
  const bar = { backgroundColor: t.strip };
  return (
    <Animated.View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>
      <View style={[styles.meta, bar]} />
      <View style={styles.row}>
        <View style={{ flex: 1, gap: 8 }}>
          <View style={[styles.line, bar]} />
          <View style={[styles.line, bar, { width: '85%' }]} />
          <View style={[styles.line, bar, { width: '55%' }]} />
        </View>
        <View style={[styles.thumb, bar]} />
      </View>
    </Animated.View>
  );
}

/** Shown while a refresh is filling an empty feed: placeholder cards in place of a message. */
export function FetchingNews() {
  const t = useTheme();
  return (
    <View testID="fetching-news" accessible accessibilityLabel="Fetching the news" style={styles.wrap}>
      <Text style={[styles.title, { color: t.muted }]}>Fetching the news…</Text>
      {[0, 1, 2].map((i) => <SkeletonCard key={i} delay={i * 220} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 8 },
  title: { fontSize: 14, fontWeight: '600', textAlign: 'center', marginBottom: 14 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  meta: { width: 90, height: 10, borderRadius: 5, marginBottom: 14 },
  row: { flexDirection: 'row', gap: 12 },
  line: { height: 14, borderRadius: 7, width: '100%' },
  thumb: { width: 92, height: 92, borderRadius: 8 },
});
