/**
 * GitHub webhook authentication (ARCHITECTURE.md §13).
 *
 * The per-room webhook secret is not stored: it is HMAC-SHA256(TOKEN_SECRET, "hm_gh|<room>|<generation>"), so the
 * Worker can verify a delivery statelessly, before any Room wakes (like room tokens). The Room stores only the current
 * generation; rotating bumps it, which changes both the secret and the payload URL.
 */
import { b64url } from '../../tokens';

const enc = new TextEncoder();

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** The secret an admin pastes into GitHub's "Secret" field. */
export async function webhookSecret(tokenSecret: string, room: string, generation: number): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(tokenSecret, 'sign'), enc.encode(`hm_gh|${room}|${generation}`));
  return b64url(sig);
}

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;

/** True when the X-Hub-Signature-256 header is the HMAC-SHA256 of the raw body under the secret. Constant time. */
export async function verifySignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  const m = header ? SIGNATURE_RE.exec(header) : null;
  if (!m) return false;
  const hex = m[1] as string;
  const sig = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sig[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, body);
}
