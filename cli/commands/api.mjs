/**
 * Calls to the Hivemind server. Tokens go only in the Authorization header, and no error message ever includes one.
 * @typedef {import('./context.mjs').Context} Context
 */
import { CliError } from './context.mjs';

const TIMEOUT_MS = 15000;

/**
 * Plain https, or http only for this machine (§13): a token must never cross the network in the clear.
 * @param {string} raw
 * @returns {string} the URL without a trailing slash
 */
export function normalizeServer(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CliError('the server must be a full URL such as https://hivemind.example.com');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new CliError('the server must be an https:// URL (http:// is only allowed for localhost)');
  }
  if (u.username || u.password) throw new CliError('the server URL must not contain a user name or password');
  u.hash = '';
  u.search = '';
  return u.toString().replace(/\/+$/, '');
}

/**
 * Loose shape check so a typo is caught before it is sent anywhere. The server is the real judge.
 * @param {string} t
 */
export function looksLikeAgentToken(t) {
  return /^hm_a\.[A-Za-z0-9_.-]{8,}$/.test(t);
}

/**
 * @param {Context} ctx
 * @param {string} server normalized
 * @param {string} path
 * @param {{ method?: string, token: string, body?: unknown }} opts
 * @returns {Promise<any>}
 */
export async function call(ctx, server, path, opts) {
  /** @type {Response} */
  let res;
  try {
    res = await ctx.fetch(server + path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const cause = /** @type {{ cause?: { code?: string } }} */ (e).cause?.code;
    throw new CliError(`could not reach ${server}${cause ? ` (${cause})` : ''}`);
  }
  /** @type {any} */
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`;
    throw new CliError(`the server said no (${res.status}): ${msg.replaceAll(opts.token, '***')}`);
  }
  if (json === null || typeof json !== 'object') throw new CliError('the server sent an answer that is not JSON');
  return json;
}

/**
 * The link that opens the dashboard with its read-only token in the fragment (never sent to a server).
 * @param {string} server
 * @param {string} room
 * @param {string} viewerToken
 */
export function dashboardLink(server, room, viewerToken) {
  return `${server}/r/${encodeURIComponent(room)}#v=${viewerToken}`;
}
