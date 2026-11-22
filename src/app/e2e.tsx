import Constants from 'expo-constants';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { saveSettings } from '../core/settings';
import { importSources, listSources, updateSource } from '../core/sources';
import { getDb } from '../platform/db';
import { appFetch } from '../platform/fetch';
import { reloadSettings, startSession } from '../platform/runner';
import { secrets } from '../platform/secrets';
import { bumpData } from '../state/store';

const E2E = !!Constants.expoConfig?.extra?.e2e;

/**
 * Test hook, compiled in only when the build sets E2E=1 (see app.config.ts). Reached by deep link:
 *   newsreader://e2e?action=mock&host=10.0.2.2:8787   point sources and OpenRouter at the mock server
 *   newsreader://e2e?action=background&minutes=11     pretend the app spent that long in the background
 *   newsreader://e2e?action=guardianrss               read the Guardian via public RSS (no API key needed)
 */
export default function E2EScreen() {
  const params = useLocalSearchParams<{ action?: string; host?: string; minutes?: string }>();
  const [msg, setMsg] = useState('Working…');

  useEffect(() => {
    if (!E2E) return;
    (async () => {
      const db = await getDb();
      if (params.action === 'mock' && params.host) {
        const base = `http://${params.host}`;
        const res = await appFetch(`${base}/e2e/sources.json`);
        if (!res.ok) throw new Error(`mock server answered ${res.status}`);
        await importSources(db, secrets, await res.text());
        await saveSettings(db, { openrouterBaseUrl: `${base}/openrouter/api/v1`, wifiOnlyPrefetch: false });
        await reloadSettings();
        bumpData();
      } else if (params.action === 'guardianrss') {
        // Live testing without a Guardian API key: read the Guardian through its public RSS feeds.
        const g = (await listSources(db)).find((s) => s.name === 'Guardian');
        if (!g) throw new Error('no Guardian source');
        await updateSource(db, g.id, {
          ...g, adapter: 'rss',
          endpoint: [
            'https://www.theguardian.com/uk/rss',
            'https://www.theguardian.com/politics/rss',
            'https://www.theguardian.com/world/rss',
          ].join('\n'),
        });
        bumpData();
      } else if (params.action === 'background') {
        const minutes = Number(params.minutes ?? '11');
        // The deep link itself briefly backgrounds the app; let that settle before rewriting the clock.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await saveSettings(db, { lastBackgroundAt: Date.now() - minutes * 60_000 });
        await startSession(false);
        bumpData();
      } else {
        throw new Error(`unknown action ${params.action}`);
      }
      router.replace('/');
    })().catch((e) => setMsg(`E2E hook failed: ${e instanceof Error ? e.message : String(e)}`));
  }, [params.action, params.host, params.minutes]);

  if (!E2E) return <Redirect href="/" />;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text testID="e2e-status">{msg}</Text>
    </View>
  );
}
