/**
 * The viewer token (§13): it arrives in the URL fragment (`/r/<room>#v=<token>`), is kept in localStorage and
 * removed from the address bar. Every storage call is wrapped, because storage can be unavailable.
 */

export function roomFromPath(pathname: string): string {
  const m = /^\/r\/([^/]+)/.exec(pathname);
  if (!m) return 'demo';
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export function tokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const v = params.get('v');
  return v && v.length > 0 ? v : null;
}

/** Loose shape check, so a typo is caught before connecting. The server is the real judge. */
export function looksLikeViewerToken(text: string): boolean {
  return /^hm_v\.[A-Za-z0-9_.-]{4,}$/.test(text.trim());
}

const key = (room: string) => `hivemind.viewer.${room}`;

export function loadToken(room: string): string | null {
  try {
    return localStorage.getItem(key(room));
  } catch {
    return null;
  }
}

export function saveToken(room: string, token: string): void {
  try {
    localStorage.setItem(key(room), token);
  } catch {
    /* the token then lasts for this page view only */
  }
}

export function forgetToken(room: string): void {
  try {
    localStorage.removeItem(key(room));
  } catch {
    /* nothing to forget */
  }
}

/** Reads the token from the fragment (storing it and clearing the address bar), else from storage. */
export function resolveToken(loc: Pick<Location, 'pathname' | 'hash' | 'search'>, replaceUrl: (url: string) => void): string | null {
  const room = roomFromPath(loc.pathname);
  const fromUrl = tokenFromFragment(loc.hash);
  if (fromUrl) {
    saveToken(room, fromUrl);
    replaceUrl(loc.pathname + loc.search);
    return fromUrl;
  }
  return loadToken(room);
}
