import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, router } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ageLabel } from '../../core/util';
import { useStore } from '../../state/store';
import { useTheme } from '../../ui/theme';

/** Top bar title with the last-refreshed time underneath. */
function HeaderTitle({ title }: { title: string }) {
  const t = useTheme();
  const last = useStore((s) => s.lastRefreshAt);
  const refreshing = useStore((s) => s.refreshing);
  const step = useStore((s) => s.refreshStep);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // The refresh may have finished after the last tick: never show a negative age.
  const age = last ? ageLabel(last, Math.max(now, last)) : null;
  const status = refreshing
    ? `Refreshing${step ? `: ${step.toLowerCase()}` : ''}…`
    : age ? (age === 'now' ? 'Updated just now' : `Updated ${age} ago`) : 'Not refreshed yet';
  return (
    <View>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: '800' }}>{title}</Text>
      <Text testID="refresh-status" style={{ color: t.faint, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{status}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const t = useTheme();
  const setupDone = useStore((s) => s.settings.setupDone);
  if (!setupDone) return <Redirect href="/setup" />;
  const icon = (name: keyof typeof Ionicons.glyphMap) =>
    function TabIcon({ color, size }: { color: any; size: number }) {
      return <Ionicons name={name} size={size} color={color} />;
    };
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerShadowVisible: false,
        headerTitleAlign: 'left',
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.faint,
        sceneStyle: { backgroundColor: t.bg },
        headerRight: () => (
          <Pressable
            testID="settings-button"
            accessibilityRole="button"
            accessibilityLabel="Settings"
            hitSlop={12}
            onPress={() => router.push('/settings')}
            style={{ paddingHorizontal: 16 }}
          >
            <Ionicons name="settings-outline" size={22} color={t.text} />
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Feed', headerTitle: () => <HeaderTitle title="News" />, tabBarIcon: icon('newspaper-outline'), tabBarButtonTestID: 'tab-feed' }}
      />
      <Tabs.Screen
        name="later"
        options={{ title: 'Read later', headerTitle: () => <HeaderTitle title="Read later" />, tabBarIcon: icon('bookmark-outline'), tabBarButtonTestID: 'tab-later' }}
      />
      <Tabs.Screen
        name="history"
        options={{ title: 'History', headerTitle: () => <HeaderTitle title="History" />, tabBarIcon: icon('time-outline'), tabBarButtonTestID: 'tab-history' }}
      />
    </Tabs>
  );
}
