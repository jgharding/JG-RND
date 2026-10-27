import { writable, get } from 'svelte/store';

// Injected from package.json by vite.config.ts
declare const __APP_VERSION__: string;
export const APP_VERSION: string = __APP_VERSION__;

export const RELEASES_URL = 'https://github.com/jgharding/JG-RND/releases/latest';
const LATEST_RELEASE_API = 'https://api.github.com/repos/jgharding/JG-RND/releases/latest';
const AUTO_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'jgrnd-app-update-checked';

export interface AppUpdateState {
  status: 'idle' | 'checking' | 'available' | 'current' | 'error';
  latest: string | null; // newest release tag, e.g. "v1.1.0"
  url: string; // the release page to open
}

export const appUpdate = writable<AppUpdateState>({ status: 'idle', latest: null, url: RELEASES_URL });

/** "v1.2.0" -> [1, 2, 0]; null if it has no leading numbers */
function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(v.trim());
  return m ? m[1].split('.').map(Number) : null;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function recentlyChecked(): boolean {
  try {
    const at = Number(localStorage.getItem(LAST_CHECK_KEY));
    return at > 0 && Date.now() - at < AUTO_CHECK_EVERY_MS;
  } catch {
    return false;
  }
}

/**
 * Compares this app with the newest GitHub release. The automatic check on startup is skipped if one ran in
 * the last few hours (GitHub's anonymous API allows 60 requests an hour); a manual check always runs.
 */
export async function checkForAppUpdate(manual = false): Promise<void> {
  if (get(appUpdate).status === 'checking') return;
  if (!manual && recentlyChecked()) return;
  appUpdate.update((s) => ({ ...s, status: 'checking' }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`GitHub answered ${resp.status}`);
    const release = (await resp.json()) as { tag_name?: string; html_url?: string };
    const tag = release.tag_name ?? '';
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    } catch {
      // private mode etc.: the check just runs again next time
    }
    appUpdate.set({
      status: isNewerVersion(tag, APP_VERSION) ? 'available' : 'current',
      latest: tag || null,
      url: release.html_url ?? RELEASES_URL,
    });
  } catch {
    appUpdate.update((s) => ({ ...s, status: 'error' }));
  } finally {
    clearTimeout(timer);
  }
}
