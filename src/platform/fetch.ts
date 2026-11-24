import type { FetchFn } from '../core/types';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

/**
 * A GET or POST with a timeout and a browser user agent (publisher pages are requested the way a
 * browser would).
 *
 * Built on XMLHttpRequest, not fetch, so that it works in a background task. React Native's fetch
 * (the whatwg-fetch polyfill) hands every response back through setTimeout, and on Android
 * JavaScript timers do not fire while the app is in the background: every fetch made by the
 * background refresh would wait forever, and Android would end the job for running too long. The
 * timeout is the XHR's own, enforced by the native HTTP client (OkHttp's call timeout, which covers
 * the whole request, body included), so it needs no JavaScript timer either.
 */
export const appFetch: FetchFn = (url, init = {}) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? 'GET', url, true);
    xhr.responseType = 'text';
    xhr.timeout = init.timeoutMs ?? 20000;
    const headers: Record<string, string> = { 'User-Agent': UA, ...(init.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.onload = () => {
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: async () => text,
        json: async () => JSON.parse(text),
      });
    };
    xhr.ontimeout = () => reject(new Error('Timed out'));
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Network error'));
    xhr.send(init.body ?? null);
  });
