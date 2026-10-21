/**
 * The Worker (ARCHITECTURE.md §8.1, §13): routing and token verification. Signatures are checked statelessly here,
 * so requests with bad tokens never wake a Room. The Room then checks only the generation and the revoke list.
 */
import type {
  AdminCreateRoomResponse, AdminInviteResponse, AdminRevokeResponse, AdminWebhookResponse, ErrorResponse,
} from '../../shared/contracts';
import { DASHBOARD_SUBPROTOCOL } from '../../shared/contracts';
import type { Env } from './env';
import { verifySignature, webhookSecret } from './features/github';
import type { InternalClaims } from './room';
import {
  bearer, PERSON_NAME_RE, ROOM_NAME_RE, secretsEqual, signAgentToken, signViewerToken, verifyAgentToken, verifyViewerToken,
} from './tokens';
import { errorResponse, json } from './util';

export { Room } from './room';

const MAX_BODY_BYTES = 256 * 1024;
/** A GitHub push payload lists every file of up to 20 commits; this is generous for that and bounded for the rest. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

class Reject extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Reject(413, 'body too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Reject(413, 'body too large');
  return text;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(await readBody(request));
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Reject) throw e;
  }
  throw new Reject(400, 'body must be a JSON object');
}

function toRoom(env: Env, claims: InternalClaims, path: string, init: { method?: string; body?: string | null; headers?: Headers } = {}): Promise<Response> {
  const stub = env.ROOM.get(env.ROOM.idFromName(claims.room));
  const headers = init.headers ?? new Headers({ 'content-type': 'application/json' });
  // Only the Worker sets this header: it is always overwritten here.
  headers.set('x-hm-claims', JSON.stringify(claims));
  return stub.fetch(new Request(`https://room.internal${path}`, { method: init.method ?? 'GET', headers, body: init.body ?? null }));
}

async function agentClaims(request: Request, env: Env): Promise<InternalClaims> {
  const token = bearer(request);
  const claims = token ? await verifyAgentToken(env.TOKEN_SECRET, token) : null;
  if (!claims) throw new Reject(401, 'invalid token');
  return { kind: 'agent', room: claims.room, person: claims.person, generation: claims.generation };
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const token = bearer(request);
  if (!token || !env.ADMIN_TOKEN || !(await secretsEqual(token, env.ADMIN_TOKEN))) throw new Reject(401, 'invalid admin token');
}

async function relayError(res: Response): Promise<never> {
  let message = 'room error';
  try { message = ((await res.json()) as ErrorResponse).error; } catch { /* keep default */ }
  throw new Reject(res.status, message);
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  await requireAdmin(request, env);
  const parts = url.pathname.split('/').filter(Boolean); // ['admin', 'rooms', room?, action?]
  if (parts[1] !== 'rooms') throw new Reject(404, 'not found');
  const room = parts[2];
  const action = parts[3];
  const checkRoom = (r: unknown): string => {
    if (typeof r !== 'string' || !ROOM_NAME_RE.test(r)) throw new Reject(400, 'room names are lowercase letters, digits and hyphens (up to 40)');
    // Reserved: fake test tokens use the room name "test", and the secret scanner allowlists them (.gitleaks.toml).
    if (r === 'test') throw new Reject(400, 'the room name "test" is reserved');
    return r;
  };

  if (!room) {
    if (request.method !== 'POST') throw new Reject(405, 'method not allowed');
    const name = checkRoom((await readJson(request)).room);
    const res = await toRoom(env, { kind: 'admin', room: name }, '/admin/init', { method: 'POST', body: '{}' });
    if (!res.ok) return relayError(res);
    const { viewerGeneration } = (await res.json()) as { viewerGeneration: number };
    const out: AdminCreateRoomResponse = { room: name, viewerToken: await signViewerToken(env.TOKEN_SECRET, name, viewerGeneration) };
    return json(out);
  }
  checkRoom(room);
  if (!action) {
    if (request.method !== 'DELETE') throw new Reject(405, 'method not allowed');
    const res = await toRoom(env, { kind: 'admin', room }, '/admin/delete', { method: 'POST', body: '{}' });
    return res.ok ? json({ deleted: true }) : relayError(res);
  }
  if (request.method !== 'POST') throw new Reject(405, 'method not allowed');
  const claims: InternalClaims = { kind: 'admin', room };
  if (action === 'invite') {
    const person = (await readJson(request)).person;
    if (typeof person !== 'string' || !PERSON_NAME_RE.test(person)) throw new Reject(400, 'person names are lowercase letters, digits, - and _ (up to 32)');
    const res = await toRoom(env, claims, '/admin/invite', { method: 'POST', body: JSON.stringify({ person }) });
    if (!res.ok) return relayError(res);
    const { generation } = (await res.json()) as { generation: number };
    const out: AdminInviteResponse = { agentToken: await signAgentToken(env.TOKEN_SECRET, room, person, generation) };
    return json(out);
  }
  if (action === 'revoke') {
    const body = await readJson(request);
    const res = await toRoom(env, claims, '/admin/revoke', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) return relayError(res);
    const { viewerGeneration } = (await res.json()) as { viewerGeneration?: number };
    const out: AdminRevokeResponse = viewerGeneration === undefined ? {} : { viewerToken: await signViewerToken(env.TOKEN_SECRET, room, viewerGeneration) };
    return json(out);
  }
  if (action === 'webhook') {
    const body = await readJson(request);
    const res = await toRoom(env, claims, '/admin/webhook', {
      method: 'POST', body: JSON.stringify({ disable: body.disable === true, repo: body.repo, fullName: body.fullName }),
    });
    if (!res.ok) return relayError(res);
    const { generation, fullName } = (await res.json()) as { generation?: number; fullName?: string };
    if (generation === undefined) return json({} satisfies AdminWebhookResponse);
    const out: AdminWebhookResponse = {
      generation, ...(fullName ? { fullName } : {}), path: `/github/${room}/${generation}`, secret: await webhookSecret(env.TOKEN_SECRET, room, generation),
    };
    return json(out);
  }
  throw new Reject(404, 'not found');
}

/** The body of a webhook delivery as bytes (the signature is over the exact bytes), refusing more than the limit. */
async function readWebhookBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) throw new Reject(413, 'body too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Reject(413, 'body too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * POST /github/<room>/<generation>: a GitHub `push` webhook (§12, §13). The signature is checked statelessly here, with
 * the secret derived from TOKEN_SECRET, so unsigned or mis-signed requests and unknown rooms never wake a Room.
 * The Room then checks that this generation is the current one.
 */
async function githubWebhook(request: Request, env: Env, match: RegExpExecArray): Promise<Response> {
  if (request.method !== 'POST') throw new Reject(405, 'method not allowed');
  const room = match[1] as string;
  const generation = Number(match[2]);
  if (!ROOM_NAME_RE.test(room) || !Number.isSafeInteger(generation) || generation < 1) throw new Reject(404, 'not found');
  const event = request.headers.get('x-github-event');
  const signature = request.headers.get('x-hub-signature-256');
  if (!signature || !event) throw new Reject(401, 'invalid signature');
  const body = await readWebhookBody(request);
  const secret = await webhookSecret(env.TOKEN_SECRET, room, generation);
  if (!(await verifySignature(secret, body, signature))) throw new Reject(401, 'invalid signature');
  if (event !== 'ping' && event !== 'push') throw new Reject(400, 'only push events are accepted');
  if ((request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new Reject(400, 'set the webhook content type to application/json (it is application/x-www-form-urlencoded)');
  }
  const headers = new Headers({ 'content-type': 'application/json', 'x-gh-event': event });
  return toRoom(env, { kind: 'webhook', room, generation }, '/github', { method: 'POST', body: new TextDecoder().decode(body), headers });
}

/** The viewer token rides in Sec-WebSocket-Protocol next to 'hivemind' (§13), never in the URL. */
function viewerTokenFrom(request: Request): string | null {
  const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim());
  if (!offered.includes(DASHBOARD_SUBPROTOCOL)) return null;
  return offered.find((p) => p.startsWith('hm_v.')) ?? null;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/health') return json({ ok: true });
  if (path.startsWith('/admin/')) return admin(request, env, url);

  const githubMatch = /^\/github\/([^/]+)\/(\d{1,9})$/.exec(path);
  if (githubMatch) return githubWebhook(request, env, githubMatch);

  const wsMatch = /^\/r\/([^/]+)\/ws$/.exec(path);
  if (wsMatch) {
    if (method !== 'GET') throw new Reject(405, 'method not allowed');
    const token = viewerTokenFrom(request);
    const claims = token ? await verifyViewerToken(env.TOKEN_SECRET, token) : null;
    if (!claims) throw new Reject(401, 'invalid viewer token');
    if (claims.room !== wsMatch[1]) throw new Reject(403, 'token is for another room');
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new Reject(426, 'expected a WebSocket upgrade');
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    return toRoom(env, { kind: 'viewer', room: claims.room, generation: claims.generation }, '/ws', { headers });
  }

  switch (path) {
    case '/hook':
    case '/mode':
    case '/unlock': {
      if (method !== 'POST') throw new Reject(405, 'method not allowed');
      const claims = await agentClaims(request, env);
      return toRoom(env, claims, path, { method: 'POST', body: await readBody(request) });
    }
    case '/mcp': {
      if (method !== 'POST') return errorResponse('method not allowed', 405, { allow: 'POST' });
      const claims = await agentClaims(request, env);
      return toRoom(env, claims, path, { method: 'POST', body: await readBody(request) });
    }
    case '/whoami': {
      if (method !== 'GET') throw new Reject(405, 'method not allowed');
      return toRoom(env, await agentClaims(request, env), path);
    }
  }

  // Dashboard files are normally served as static assets without reaching the Worker; this is the fallback.
  if (method === 'GET' || method === 'HEAD') return env.ASSETS.fetch(request);
  throw new Reject(404, 'not found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof Reject) return errorResponse(e.message, e.status);
      return errorResponse('internal error', 500);
    }
  },
} satisfies ExportedHandler<Env>;
