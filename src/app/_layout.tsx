import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { AppState, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// Importing this module also defines the background task, which must happen at startup.
import { registerBackgroundRefresh } from '../platform/background';
import { appWentBackground, initApp, refreshOnOpen, startSession } from '../platform/runner';
import { getState, useStore } from '../state/store';
import { Snackbar } from '../ui/overlays';
import { useTheme } from '../ui/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const t = useTheme();
  const ready = useStore((s) => s.ready);
  const initError = useStore((s) => s.initError);

  useEffect(() => {
    initApp().finally(() => {
      SplashScreen.hideAsync().catch(() => {});
      const s = getState();
      if (!s.ready) return;
      registerBackgroundRefresh(s.settings.refreshMinutes).catch(() => {});
      // The cached feed is on screen first; then it is brought up to date.
      refreshOnOpen();
    });
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (!getState().ready) return;
      if (state === 'background') {
        appWentBackground().catch(() => {});
      } else if (state === 'active') {
        // Ten minutes away ends the session; either way, refresh on return.
        startSession(false).then(refreshOnOpen).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {initError ? <Text style={{ color: t.text, textAlign: 'center' }}>Could not open the database: {initError}</Text> : null}
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.bg }}>
      <SafeAreaProvider>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.card },
            headerTintColor: t.text,
            headerTitleStyle: { color: t.text },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="setup" options={{ headerShown: false }} />
          <Stack.Screen name="e2e" options={{ headerShown: false }} />
          <Stack.Screen name="reader/[id]" options={{ title: '' }} />
          <Stack.Screen name="coverage/[id]" options={{ title: 'Full coverage' }} />
          <Stack.Screen name="story/[id]" options={{ title: 'Following' }} />
          <Stack.Screen name="settings/topics" options={{ title: 'Muted and watched topics' }} />
          <Stack.Screen name="settings/learned" options={{ title: 'What the app has learned' }} />
          <Stack.Screen name="settings/sources" options={{ title: 'Sources' }} />
          <Stack.Screen name="settings/source/[id]" options={{ title: 'Source' }} />
          <Stack.Screen name="settings/ranking" options={{ title: 'Ranking and thresholds' }} />
          <Stack.Screen name="settings/debug" options={{ title: 'Debug' }} />
        </Stack>
        <Snackbar />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
