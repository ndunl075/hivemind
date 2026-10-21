/**
 * Room tokens (ARCHITECTURE.md §13). Signed with HMAC-SHA256, never stored.
 *   agent:  hm_a.<room>.<person>.<generation>.<signature>
 *   viewer: hm_v.<room>.<generation>.<signature>
 * Names are lowercase letters, digits, '-' and '_' so the dots always split cleanly.
 */
import type { AgentTokenClaims, ViewerTokenClaims } from '../../shared/contracts';

export const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PERSON_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function key(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function sign(secret: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', await key(secret, 'sign'), enc.encode(data)));
}

/** Constant-time verification through crypto.subtle.verify. */
async function verify(secret: string, data: string, signature: string): Promise<boolean> {
  const sig = fromB64url(signature);
  if (!sig) return false;
  return crypto.subtle.verify('HMAC', await key(secret, 'verify'), sig, enc.encode(data));
}

export async function signAgentToken(secret: string, room: string, person: string, generation: number): Promise<string> {
  const body = `hm_a.${room}.${person}.${generation}`;
  return `${body}.${await sign(secret, body)}`;
}

export async function signViewerToken(secret: string, room: string, generation: number): Promise<string> {
  const body = `hm_v.${room}.${generation}`;
  return `${body}.${await sign(secret, body)}`;
}

function parseGeneration(text: string | undefined): number | null {
  if (!text || !/^[0-9]{1,9}$/.test(text)) return null;
  return Number(text);
}

export async function verifyAgentToken(secret: string, token: string): Promise<AgentTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'hm_a') return null;
  const [, room, person, gen, signature] = parts as [string, string, string, string, string];
  const generation = parseGeneration(gen);
  if (generation === null || !ROOM_NAME_RE.test(room) || !PERSON_NAME_RE.test(person)) return null;
  if (!(await verify(secret, `hm_a.${room}.${person}.${gen}`, signature))) return null;
  return { kind: 'agent', room, person, generation };
}

export async function verifyViewerToken(secret: string, token: string): Promise<ViewerTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'hm_v') return null;
  const [, room, gen, signature] = parts as [string, string, string, string];
  const generation = parseGeneration(gen);
  if (generation === null || !ROOM_NAME_RE.test(room)) return null;
  if (!(await verify(secret, `hm_v.${room}.${gen}`, signature))) return null;
  return { kind: 'viewer', room, generation };
}

/** Constant-time comparison of two secrets (hashes both so lengths don't leak). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function bearer(request: Request): string | null {
  const h = request.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? (m[1] ?? null) : null;
}
