import * as SecureStore from 'expo-secure-store';
import type { Secrets } from '../core/sources';

/** API keys live in the Android Keystore / iOS Keychain. Nothing secret is stored in SQLite. */
export const secrets: Secrets = {
  async get(ref) {
    try {
      return (await SecureStore.getItemAsync(ref)) || null;
    } catch {
      return null;
    }
  },
  async set(ref, value) {
    await SecureStore.setItemAsync(ref, value.trim());
  },
  async remove(ref) {
    await SecureStore.deleteItemAsync(ref);
  },
};
