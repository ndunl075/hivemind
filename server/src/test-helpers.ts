/** Helpers shared by the Workers-pool tests. Not imported by the Worker. */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import type { HookRequest, HookResponse } from '../../shared/contracts';
import type { Room } from './room';
import { signAgentToken, signViewerToken } from './tokens';

export const TOKEN_SECRET = (env as unknown as { TOKEN_SECRET: string }).TOKEN_SECRET;
export const ADMIN_TOKEN = (env as unknown as { ADMIN_TOKEN: string }).ADMIN_TOKEN;
export const REPO = 'a'.repeat(40);

export function agentToken(room: string, person: string, generation = 1): Promise<string> {
  return signAgentToken(TOKEN_SECRET, room, person, generation);
}

export function viewerToken(room: string, generation = 1): Promise<string> {
  return signViewerToken(TOKEN_SECRET, room, generation);
}

export function post(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function get(path: string, token: string): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, { headers: { authorization: `Bearer ${token}` } });
}

export function hookBody(session: string, over: Partial<HookRequest> = {}): HookRequest {
  return {
    v: 1, event: 'PostToolUse', agent: 'claude', session, repo: REPO, checkout: 'checkout-1', branch: 'main', head: 'abc1234', ...over,
  };
}

export async function hook(token: string, session: string, over: Partial<HookRequest> = {}): Promise<HookResponse> {
  const res = await post('/hook', token, hookBody(session, over));
  if (res.status !== 200) throw new Error(`hook failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as HookResponse;
}

export function editBody(path: string): Partial<HookRequest> {
  return { event: 'PreToolUse', tool: 'Edit', paths: [path] };
}

export function roomStub(room: string): DurableObjectStub<Room> {
  return (env as unknown as { ROOM: DurableObjectNamespace<Room> }).ROOM.get(
    (env as unknown as { ROOM: DurableObjectNamespace<Room> }).ROOM.idFromName(room),
  );
}

export function inRoom<R>(room: string, fn: (r: Room, state: DurableObjectState) => R | Promise<R>): Promise<R> {
  return runInDurableObject(roomStub(room), fn);
}

/** Collects messages from a dashboard socket and lets a test wait for one that matches. */
export class Viewer {
  readonly messages: Array<Record<string, unknown>> = [];
  private waiters: Array<{ match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      this.messages.push(m);
      for (const w of [...this.waiters]) {
        if (w.match(m)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          w.resolve(m);
        }
      }
    });
  }

  next(match: (m: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const seen = this.messages.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for a dashboard message')), timeoutMs);
      this.waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
}

export async function connectViewer(room: string, token: string): Promise<Viewer> {
  const res = await SELF.fetch(`https://example.com/r/${room}/ws`, {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': `hivemind, ${token}` },
  });
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
  const ws = res.webSocket;
  const viewer = new Viewer(ws);
  ws.accept();
  return viewer;
}
