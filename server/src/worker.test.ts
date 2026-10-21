import { env, listDurableObjectIds, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN, agentToken, connectViewer, get, hook, inRoom, post, REPO, TOKEN_SECRET, viewerToken,
} from './test-helpers';
import { signAgentToken, verifyAgentToken, verifyViewerToken } from './tokens';

const BASE = 'https://example.com';
const ns = (env as unknown as { ROOM: DurableObjectNamespace }).ROOM;

function admin(method: string, path: string, body?: unknown, token = ADMIN_TOKEN): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function editPath(path: string) {
  return { event: 'PreToolUse' as const, tool: 'Edit', paths: [path] };
}

it('answers /health', async () => {
  const res = await SELF.fetch(`${BASE}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

describe('tokens', () => {
  it('round-trips and rejects tampering', async () => {
    const t = await agentToken('team', 'ana', 3);
    expect(await verifyAgentToken(TOKEN_SECRET, t)).toEqual({ kind: 'agent', room: 'team', person: 'ana', generation: 3 });
    expect(await verifyAgentToken(TOKEN_SECRET, t.replace('.ana.', '.bob.'))).toBeNull();
    expect(await verifyAgentToken(TOKEN_SECRET, t.replace('.3.', '.4.'))).toBeNull();
    expect(await verifyAgentToken('other-secret', t)).toBeNull();
    expect(await verifyAgentToken(TOKEN_SECRET, 'hm_a.test.nobody.1.AAAA')).toBeNull();
    expect(await verifyAgentToken(TOKEN_SECRET, 'garbage')).toBeNull();
    const v = await viewerToken('team');
    expect(await verifyViewerToken(TOKEN_SECRET, v)).toEqual({ kind: 'viewer', room: 'team', generation: 1 });
    expect(await verifyViewerToken(TOKEN_SECRET, t)).toBeNull();
    expect(await verifyAgentToken(TOKEN_SECRET, v)).toBeNull();
  });
});

describe('bad tokens never touch a Room', () => {
  it('rejects forged agent and viewer tokens before any Room exists', async () => {
    const room = 'ghost-room';
    const before = (await listDurableObjectIds(ns)).length;
    const forged = await signAgentToken('not-the-secret', room, 'ana', 1);
    const tokens = ['', 'garbage', 'hm_a.test.nobody.1.AAAA', forged, `${await agentToken(room, 'ana')}x`, await viewerToken(room)];
    for (const t of tokens) {
      for (const [method, path] of [['POST', '/hook'], ['POST', '/mcp'], ['GET', '/whoami'], ['POST', '/mode'], ['POST', '/unlock']] as const) {
        const res = await SELF.fetch(`${BASE}${path}`, {
          method,
          headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(res.status, `${method} ${path} with "${t.slice(0, 12)}"`).toBe(401);
      }
    }
    // Viewer sockets: no token, a bad token, an agent token, and a token for another room.
    const offers = ['hivemind', 'hivemind, hm_v.ghost-room.1.AAAA', `hivemind, ${await agentToken(room, 'ana')}`, `hivemind, ${await viewerToken('other')}`];
    for (const offer of offers) {
      const res = await SELF.fetch(`${BASE}/r/${room}/ws`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': offer } });
      expect([401, 403]).toContain(res.status);
    }
    // A token in the URL is not accepted either.
    const viaUrl = await SELF.fetch(`${BASE}/r/${room}/ws?token=${await viewerToken(room)}`, { headers: { upgrade: 'websocket' } });
    expect(viaUrl.status).toBe(401);
    expect((await listDurableObjectIds(ns)).length).toBe(before);
  });

  it('a valid signature with a stale generation reaches the Room and is refused there', async () => {
    const room = 'rotated';
    const res = await get('/whoami', await agentToken(room, 'ana', 1));
    expect(res.status).toBe(200);
    const stale = await admin('POST', `/admin/rooms/${room}/revoke`, { rotate: 'agents' });
    expect(stale.status).toBe(200);
    expect((await get('/whoami', await agentToken(room, 'ana', 1))).status).toBe(401);
    expect((await get('/whoami', await agentToken(room, 'ana', 2))).status).toBe(200);
  });
});

describe('routes', () => {
  it('whoami returns room, person and mode without registering anything', async () => {
    const room = 'who';
    const res = await get('/whoami', await agentToken(room, 'ana'));
    expect(await res.json()).toEqual({ room: 'who', person: 'ana', mode: 'enforce' });
    expect(await inRoom(room, (r) => r.agents.all().length)).toBe(0);
  });

  it('validates hook bodies and methods', async () => {
    const t = await agentToken('valid', 'ana');
    expect((await post('/hook', t, { v: 2 })).status).toBe(400);
    expect((await post('/hook', t, { v: 1, event: 'Nope', agent: 'claude', session: 's', repo: REPO, checkout: 'c' })).status).toBe(400);
    expect((await get('/hook', t)).status).toBe(405);
    const bad = await SELF.fetch(`${BASE}/hook`, { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: '{nope' });
    expect(bad.status).toBe(400);
    const huge = await SELF.fetch(`${BASE}/hook`, { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: 'x'.repeat(300_000) });
    expect(huge.status).toBe(413);
  });

  it('applies the per-person burst limit', async () => {
    const t = await agentToken('burst', 'ana');
    const other = await agentToken('burst', 'nico');
    const results = await Promise.all(Array.from({ length: 30 }, () => get('/whoami', t)));
    const limited = results.filter((r) => r.status === 429).length;
    expect(limited).toBe(10);
    expect((await get('/whoami', other)).status).toBe(200);
  });

  it("rejects a second person using someone else's session", async () => {
    const room = 'impersonate';
    await hook(await agentToken(room, 'ana'), 'shared-session', {});
    const res = await post('/hook', await agentToken(room, 'nico'), { v: 1, event: 'PostToolUse', agent: 'claude', session: 'shared-session', repo: REPO, checkout: 'c', branch: null, head: null });
    expect(res.status).toBe(403);
  });

  it('enforces the 50 agent limit', async () => {
    const room = 'full';
    const people = Array.from({ length: 51 }, (_, i) => `p${i}`);
    const statuses: number[] = [];
    for (const p of people) {
      const res = await post('/hook', await agentToken(room, p), { v: 1, event: 'SessionStart', agent: 'claude', session: `s-${p}`, repo: REPO, checkout: 'c', branch: null, head: null });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(50);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('admin routes', () => {
  it('needs the admin secret', async () => {
    expect((await admin('POST', '/admin/rooms', { room: 'x1' }, 'wrong')).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/admin/rooms`, { method: 'POST', body: '{"room":"x1"}' })).status).toBe(401);
    expect((await admin('POST', '/admin/rooms', { room: 'Bad Name' })).status).toBe(400);
  });

  it('creates a room, invites, revokes, rotates and deletes', async () => {
    const created = await (await admin('POST', '/admin/rooms', { room: 'lifecycle' })).json() as { room: string; viewerToken: string };
    expect(created.room).toBe('lifecycle');
    expect(await verifyViewerToken(TOKEN_SECRET, created.viewerToken)).toMatchObject({ room: 'lifecycle', generation: 1 });

    const invited = await (await admin('POST', '/admin/rooms/lifecycle/invite', { person: 'ana' })).json() as { agentToken: string };
    expect(invited.agentToken).toBe(await agentToken('lifecycle', 'ana'));
    expect((await get('/whoami', invited.agentToken)).status).toBe(200);
    expect((await admin('POST', '/admin/rooms/lifecycle/invite', { person: 'Bad Person' })).status).toBe(400);

    const bob = (await (await admin('POST', '/admin/rooms/lifecycle/invite', { person: 'bob' })).json() as { agentToken: string }).agentToken;
    await hook(invited.agentToken, 'sa', editPath('f.ts'));
    expect((await admin('POST', '/admin/rooms/lifecycle/revoke', { person: 'ana' })).status).toBe(200);
    expect((await get('/whoami', invited.agentToken)).status).toBe(401);
    expect((await get('/whoami', bob)).status).toBe(200);
    // Revoking ends the person's agents, so their locks no longer block anyone.
    expect((await hook(bob, 'sb', editPath('f.ts'))).decision).toBe('allow');
    expect((await admin('POST', '/admin/rooms/lifecycle/invite', { person: 'ana' })).status).toBe(409);

    const rotated = await (await admin('POST', '/admin/rooms/lifecycle/revoke', { rotate: 'viewer' })).json() as { viewerToken: string };
    expect(await verifyViewerToken(TOKEN_SECRET, rotated.viewerToken)).toMatchObject({ generation: 2 });
    const oldViewer = await SELF.fetch(`${BASE}/r/lifecycle/ws`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `hivemind, ${created.viewerToken}` } });
    expect(oldViewer.status).toBe(401);
    const viewer = await connectViewer('lifecycle', rotated.viewerToken);
    expect(await viewer.next((m) => m.type === 'snapshot')).toMatchObject({ room: 'lifecycle' });
    viewer.socket.close();
    expect((await get('/whoami', bob)).status).toBe(200);

    expect((await admin('POST', '/admin/rooms/lifecycle/revoke', { person: 'bob', rotate: 'agents' })).status).toBe(400);
    expect((await admin('POST', '/admin/rooms/lifecycle/revoke', { rotate: 'agents' })).status).toBe(200);
    expect((await admin('POST', '/admin/rooms/lifecycle/invite', { person: 'ana' })).status).toBe(200);

    expect((await admin('DELETE', '/admin/rooms/lifecycle')).status).toBe(200);
    // Data is gone and tokens issued before the delete stay dead.
    expect(await inRoom('lifecycle', (r) => r.agents.all().length)).toBe(0);
    const reinvited = await (await admin('POST', '/admin/rooms/lifecycle/invite', { person: 'ana' })).json() as { agentToken: string };
    expect(await verifyAgentToken(TOKEN_SECRET, reinvited.agentToken)).toMatchObject({ generation: 3 });
    expect((await get('/whoami', reinvited.agentToken)).status).toBe(200);
  });
});

describe('MCP endpoint', () => {
  const rpc = (token: string, body: unknown) => post('/mcp', token, body);

  it('answers initialize, tools/list and the status tool; GET is 405', async () => {
    const room = 'mcp';
    const t = await agentToken(room, 'ana');
    const start = await hook(t, 'sa', { event: 'SessionStart' });
    expect((await get('/mcp', t)).status).toBe(405);

    const init = await (await rpc(t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json() as {
      result: { protocolVersion: string; instructions: string; serverInfo: { name: string } };
    };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.serverInfo.name).toBe('hivemind');
    expect(init.result.instructions).toContain('## Hivemind (live multi-agent coordination)');

    const note = await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);

    const list = await (await rpc(t, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((x) => x.name)).toContain('status');

    const call = await (await rpc(t, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: { me: start.callsign } } })).json() as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(call.result.isError).toBeUndefined();
    const status = JSON.parse(call.result.content[0]?.text as string);
    expect(status.you.callsign).toBe('claude-ana');
    expect(status.mode).toBe('enforce');
    expect(status.agents).toHaveLength(1);
    expect(status).toMatchObject({ heldByOthers: [], yours: [], unread: 0 });
  });

  it("refuses a me that is not the caller's, and unknown tools or methods", async () => {
    const room = 'mcp-me';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(b, 'sb', { event: 'SessionStart' });
    const wrong = await (await rpc(b, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: { me: 'claude-ana' } } })).json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(wrong.result.isError).toBe(true);
    expect(wrong.result.content[0]?.text).toContain('not your callsign');
    const missing = await (await rpc(b, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } })).json() as { result: { isError: boolean } };
    expect(missing.result.isError).toBe(true);
    const unknown = await (await rpc(b, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } })).json() as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
    const method = await (await rpc(b, { jsonrpc: '2.0', id: 4, method: 'resources/list' })).json() as { error: { code: number } };
    expect(method.error.code).toBe(-32601);
    expect((await rpc(b, { nope: true })).status).toBe(400);
  });
});
