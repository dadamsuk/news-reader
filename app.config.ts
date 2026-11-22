import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withGradleProperties, type ConfigPlugin } from 'expo/config-plugins';

/**
 * The generated Gradle settings give the build JVM 512 MB of metaspace, which a release build of
 * this many native modules exhausts ("Failed to notify build listener > Metaspace").
 */
const withGradleMemory: ConfigPlugin = (config) =>
  withGradleProperties(config, (c) => {
    const value = '-Xmx4096m -XX:MaxMetaspaceSize=1536m';
    const existing = c.modResults.find((p) => p.type === 'property' && p.key === 'org.gradle.jvmargs');
    if (existing && existing.type === 'property') existing.value = value;
    else c.modResults.push({ type: 'property', key: 'org.gradle.jvmargs', value });
    return c;
  });

/**
 * E2E=1 builds the variant used by the Maestro flows: it allows plain-HTTP traffic to the local
 * mock server and enables the newsreader://e2e test hook. Store builds never set it.
 */
const E2E = process.env.E2E === '1';

// Set by `eas init`. Until then EAS Update has no URL and the app simply runs its embedded bundle.
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID ?? '';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'News',
  slug: 'news-reader',
  version: '1.0.0',
  scheme: 'newsreader',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  runtimeVersion: { policy: 'appVersion' },
  updates: EAS_PROJECT_ID
    ? { url: `https://u.expo.dev/${EAS_PROJECT_ID}`, fallbackToCacheTimeout: 0, checkAutomatically: 'ON_LOAD' }
    : { enabled: false },
  ios: {
    bundleIdentifier: 'net.dsc.newsreader',
    supportsTablet: false,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: 'net.dsc.newsreader',
    adaptiveIcon: {
      backgroundColor: '#A8201A',
      foregroundImage: './assets/android-icon-foreground.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-background-task',
    'expo-secure-store',
    'expo-web-browser',
    'expo-sharing',
    ['expo-image', { disableLibdav1d: false }],
    ['expo-splash-screen', { backgroundColor: '#F4F3EF', image: './assets/splash-icon.png', imageWidth: 120, dark: { backgroundColor: '#0E0E10' } }],
    ['expo-build-properties', { android: { usesCleartextTraffic: E2E } }],
    withGradleMemory as any,
  ],
  extra: {
    e2e: E2E,
    eas: EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : undefined,
  },
});
