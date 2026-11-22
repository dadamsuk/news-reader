import type { FetchFn } from '../core/types';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

/** fetch with a timeout and a browser user agent (publisher pages are requested the way a browser would). */
export const appFetch: FetchFn = async (url, init = {}) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
      body: init.body,
      signal: ctrl.signal,
    });
    // Read the body inside the timeout window, so a stalled download cannot hang a refresh.
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('Timed out');
    throw e instanceof Error ? new Error(e.message || 'Network error') : new Error('Network error');
  } finally {
    clearTimeout(timer);
  }
};
