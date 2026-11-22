import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { loadSettings } from '../core/settings';
import { getDb } from './db';
import { runRefresh } from './runner';

export const REFRESH_TASK = 'news-refresh';

// Defined at module scope so the task exists when the system starts the app headless.
// WorkManager runs it on Android and BGTaskScheduler on iOS; the system decides when.
TaskManager.defineTask(REFRESH_TASK, async () => {
  let stop = false;
  const sub = BackgroundTask.addExpirationListener(() => {
    stop = true;
  });
  try {
    const db = await getDb();
    const settings = await loadSettings(db);
    if (!settings.setupDone) return BackgroundTask.BackgroundTaskResult.Success;
    await runRefresh('background', () => stop);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    sub.remove();
  }
});

/** (Re)registers periodic refresh at the interval from Settings. Safe to call on every launch. */
export async function registerBackgroundRefresh(minutes: number): Promise<string> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return 'restricted';
    await BackgroundTask.registerTaskAsync(REFRESH_TASK, { minimumInterval: Math.max(15, Math.round(minutes)) });
    return 'registered';
  } catch (e) {
    return e instanceof Error ? e.message : 'unavailable';
  }
}

export async function backgroundStatus(): Promise<string> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    const registered = await TaskManager.isTaskRegisteredAsync(REFRESH_TASK);
    const avail = status === BackgroundTask.BackgroundTaskStatus.Available ? 'available' : 'restricted';
    return `${avail}, ${registered ? 'registered' : 'not registered'}`;
  } catch {
    return 'unavailable';
  }
}

export async function triggerBackgroundForTesting(): Promise<boolean> {
  try {
    return await BackgroundTask.triggerTaskWorkerForTestingAsync();
  } catch {
    return false;
  }
}
