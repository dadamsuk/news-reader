import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../../state/store';
import { useTheme } from '../../ui/theme';

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const setupDone = useStore((s) => s.settings.setupDone);
  if (!setupDone) return <Redirect href="/setup" />;
  const icon = (name: keyof typeof Ionicons.glyphMap) =>
    function TabIcon({ color, size }: { color: any; size: number }) {
      return <Ionicons name={name} size={size} color={color} />;
    };
  return (
    <Tabs
      screenOptions={{
        // No title bar: each screen starts under the status bar, and Settings is a tab.
        headerShown: false,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.faint,
        sceneStyle: { backgroundColor: t.card, paddingTop: insets.top },
      }}
    >
      {/* Tapping Feed while it is showing opens the category list (see the feed screen). */}
      <Tabs.Screen name="index" options={{ title: 'Feed', tabBarIcon: icon('newspaper-outline'), tabBarButtonTestID: 'tab-feed' }} />
      <Tabs.Screen name="pulse" options={{ title: 'Pulse', tabBarIcon: icon('pulse-outline'), tabBarButtonTestID: 'tab-pulse' }} />
      <Tabs.Screen name="later"options={{ title: 'Read later', tabBarIcon: icon('bookmark-outline'), tabBarButtonTestID: 'tab-later' }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: icon('time-outline'), tabBarButtonTestID: 'tab-history' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings-outline'), tabBarButtonTestID: 'tab-settings' }} />
    </Tabs>
  );
}
