import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../../../shared/contracts';
import protocol from '../../../../shared/protocol.md';
import { agentToken, editBody, get, inRoom, post } from '../../test-helpers';
import { call, join, rawMcp, rpc } from './test-util';

afterEach(() => {
  vi.useRealTimers();
});

const ALL_TOOLS = ['status', 'task_add', 'task_claim', 'task_update', 'reserve', 'release', 'take', 'post', 'inbox', 'wait', 'register'];

describe('protocol', () => {
  it('initialize carries the §6.5 protocol text as instructions, and negotiates the version', async () => {
    const token = await agentToken('mcp-init', 'ana');
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.instructions).toBe(protocol);
    expect(init.result.instructions).toContain('## Hivemind (live multi-agent coordination)');
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.serverInfo.name).toBe('hivemind');
    expect((await rpc(token, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-06-18');
    expect((await rpc(token, 'ping')).result).toEqual({});
  });

  it('answers server/discover and any unknown method with JSON-RPC -32601 in an HTTP 200, never a transport error', async () => {
    const token = await agentToken('mcp-unknown', 'ana');
    for (const method of ['server/discover', 'resources/list', 'prompts/list', 'completion/complete', 'nope']) {
      const res = await post('/mcp', token, { jsonrpc: '2.0', id: 7, method, params: {} });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: number; error: { code: number; message: string } };
      expect(body.id).toBe(7);
      expect(body.error.code).toBe(-32601);
    }
    // Notifications get no body.
    const note = await post('/mcp', token, { jsonrpc: '2.0', method: 'server/discover' });
    expect(note.status).toBe(202);
    expect((await post('/mcp', token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('GET and DELETE are 405; bad JSON is a parse error; batches are rejected', async () => {
    const token = await agentToken('mcp-misc', 'ana');
    expect((await get('/mcp', token)).status).toBe(405);
    const del = await SELF.fetch('https://example.com/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect(del.status).toBe(405);
    const bad = await rawMcp(token, '{nope');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const batch = await post('/mcp', token, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'server/discover' },
    ]);
    expect(batch.status).toBe(400);
    expect(((await batch.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('lists every tool with a description, a title and an input schema that requires me (except register)', async () => {
    const token = await agentToken('mcp-list', 'ana');
    const list = await rpc(token, 'tools/list');
    const tools = list.result.tools as { name: string; title: string; description: string; inputSchema: { type: string; required: string[]; properties: Record<string, unknown> }; annotations?: Record<string, boolean> }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.inputSchema.type).toBe('object');
      if (t.name === 'register') {
        expect(t.inputSchema.required).toEqual(['kind']);
        expect(t.inputSchema.properties).not.toHaveProperty('me');
      } else {
        expect(t.inputSchema.required).toContain('me');
        expect(t.inputSchema.properties).toHaveProperty('me');
      }
    }
    expect(tools.find((t) => t.name === 'status')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'wait')?.description).toContain(String(LIMITS.waitMaxSeconds));
  });
});

describe('argument validation', () => {
  it('answers -32602 for wrong types, missing required arguments and unknown tools', async () => {
    const a = await join('mcp-args', 'ana');
    const cases: [string, Record<string, unknown>][] = [
      ['task_claim', { id: 'seven' }],
      ['task_claim', { id: 1.5 }],
      ['task_claim', {}],
      ['task_add', { tasks: 'nope' }],
      ['task_add', { tasks: [] }],
      ['task_add', { tasks: [{ description: 'no title' }] }],
      ['task_update', { id: 1, status: 'finished' }],
      ['reserve', { folders: [] }],
      ['post', { to: a.cs }],
      ['wait', { seconds: '5' }],
      ['wait', {}],
      ['inbox', { recent: 'yes' }],
    ];
    for (const [name, args] of cases) {
      const r = await a.call(name, args);
      expect(r.rpcError?.code, `${name} ${JSON.stringify(args)}`).toBe(-32602);
      expect(r.rpcError?.message).toContain('Invalid params');
    }
    expect((await call(a.token, 'no_such_tool', { me: a.cs })).rpcError?.code).toBe(-32602);
    const badArgs = await rpc(a.token, 'tools/call', { name: 'status', arguments: ['x'] });
    expect(badArgs.error.code).toBe(-32602);
  });

  it('shows me problems as tool errors the agent can read', async () => {
    const a = await join('mcp-me2', 'ana');
    const b = await join('mcp-me2', 'nico');
    const missing = await call(a.token, 'status', {});
    expect(missing).toMatchObject({ isError: true, value: expect.stringContaining('`me` is required') });
    const wrong = await call(b.token, 'status', { me: a.cs });
    expect(wrong).toMatchObject({ isError: true, value: expect.stringContaining('not your callsign') });
    const unknown = await call(a.token, 'status', { me: 'claude-ghost' });
    expect(unknown.isError).toBe(true);
  });
});

describe('wait', () => {
  it('rejects a non-finite or non-numeric seconds with -32602 instead of failing the request', async () => {
    const a = await join('wait-bad', 'ana');
    for (const seconds of ['1e999', '-1e999', '"5"', 'null', 'true']) {
      const res = await rawMcp(a.token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait","arguments":{"me":"${a.cs}","seconds":${seconds}}}}`);
      expect(res.status, seconds).toBe(200);
      expect(((await res.json()) as { error: { code: number } }).error.code, seconds).toBe(-32602);
    }
  });

  it('times out, takes fractional seconds and refuses negative ones', async () => {
    const a = await join('wait-timeout', 'ana');
    const started = Date.now();
    expect((await a.call('wait', { seconds: 0.05 })).value).toEqual({ event: 'timeout' });
    expect((await a.call('wait', { seconds: -5 })).rpcError?.code).toBe(-32602);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await a.call('wait', { seconds: 0, for: 'bogus' })).value).toContain('`for` must be');
  });

  it('wakes on a message, and returns at once when one is already waiting', async () => {
    const room = 'wait-msg';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    const waiter = nico.call('wait', { seconds: 20 });
    await new Promise((r) => setTimeout(r, 50));
    await ana.call('post', { to: nico.cs, text: 'wake up' });
    const got = await waiter;
    expect(got.value.event).toBe('message');
    expect(got.value.messages.map((m: { text: string }) => m.text)).toEqual(['wake up']);
    // Delivered: it does not come again.
    expect((await nico.call('inbox')).value.unread).toEqual([]);

    await ana.call('post', { to: 'all', text: 'broadcast first' });
    const started = Date.now();
    const now = await nico.call('wait', { seconds: 30, for: 'message' });
    expect(now.value.messages.map((m: { text: string }) => m.text)).toEqual(['broadcast first']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('wakes when the lock on a path is released, matching case-insensitively', async () => {
    const room = 'wait-release';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.hook(editBody('src/Login.ts'));
    const pending = nico.call('wait', { seconds: 20, for: 'release:src/login.ts' });
    await new Promise((r) => setTimeout(r, 50));
    const released = await ana.call('release', { paths: ['src/Login.ts'] });
    expect(released.value.released.map((l: { path: string }) => l.path)).toEqual(['src/Login.ts']);
    expect((await pending).value).toEqual({ event: 'release' });
  });

  it('wakes for a file under a reserved folder when the folder is released', async () => {
    const room = 'wait-folder';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.call('reserve', { folders: ['docs/'] });
    const pending = nico.call('wait', { seconds: 20, for: 'release:docs/guide.md' });
    await new Promise((r) => setTimeout(r, 50));
    await ana.call('release', { paths: ['docs/'] });
    expect((await pending).value).toEqual({ event: 'release' });
  });

  it('a second wait by the same caller replaces the first, which ends with a timeout', async () => {
    const room = 'wait-replace';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.hook(editBody('busy.ts'));
    const first = nico.call('wait', { seconds: 20, for: 'release:busy.ts' });
    await new Promise((r) => setTimeout(r, 50));
    const second = nico.call('wait', { seconds: 20, for: 'release:busy.ts' });
    expect((await first).value).toEqual({ event: 'timeout' });
    await ana.call('release', {});
    expect((await second).value).toEqual({ event: 'release' });
  });

  it('returns at once for a path nobody holds, and for yours', async () => {
    const room = 'wait-free';
    const ana = await join(room, 'ana');
    await ana.hook(editBody('mine.ts'));
    expect((await ana.call('wait', { seconds: 20, for: 'release:mine.ts' })).value).toEqual({ event: 'release' });
    expect((await ana.call('wait', { seconds: 20, for: 'release:free.ts' })).value).toEqual({ event: 'release' });
    expect((await ana.call('wait', { seconds: 1, for: 'release:../escape' })).value).toContain('repo-relative');
    expect((await ana.call('wait', { seconds: 1, for: 'task:99' })).value).toContain('no task');
  });
});

describe('tools', () => {
  it('status shows the room as the caller sees it', async () => {
    const room = 'tool-status';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.call('task_add', { tasks: [{ title: 'Mine' }], claim: true });
    await ana.hook(editBody('a.ts'));
    await nico.call('post', { to: ana.cs, text: 'hi' });
    const s = (await ana.call('status')).value;
    expect(s.you).toMatchObject({ callsign: ana.cs, taskId: 1 });
    expect(s.mode).toBe('enforce');
    expect(s.agents.map((a: { callsign: string; state: string }) => [a.callsign, a.state])).toEqual([[ana.cs, 'working'], [nico.cs, 'working']]);
    expect(s.tasks).toMatchObject([{ id: 1, owner: ana.cs }]);
    expect(s.yours.map((l: { path: string }) => l.path)).toEqual(['a.ts']);
    expect(s.heldByOthers).toEqual([]);
    expect(s.unread).toBe(1);
    expect((await nico.call('status')).value.heldByOthers.map((l: { path: string }) => l.path)).toEqual(['a.ts']);
  });

  it('reserve is all or nothing and validates folders; release reports files that may be unpushed', async () => {
    const room = 'tool-reserve';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    const first = await ana.call('reserve', { folders: ['src/auth', 'lib/'], reason: 'auth rework' });
    expect(first.value).toEqual({ granted: true, conflicts: [] });
    const clash = await nico.call('reserve', { folders: ['docs/', 'src/auth/sub/'] });
    expect(clash.value.granted).toBe(false);
    expect(clash.value.conflicts).toMatchObject([{ holder: ana.cs, path: 'src/auth/', kind: 'folder' }]);
    expect((await inRoom(room, (r) => r.features.locks.holdings(nico.cs)))).toEqual([]);
    expect((await nico.call('reserve', { folders: ['../up/'] })).value).toContain('repo-relative');
    expect((await nico.call('reserve', { folders: ['.git/'] })).value).toContain('.git');
    expect((await nico.call('reserve', { folders: ['x/'], repo: 'unknown-repo' })).value).toContain('Unknown repo');

    await ana.hook(editBody('src/auth/login.ts'));
    const some = await ana.call('release', { paths: ['lib'] });
    expect(some.value).toMatchObject({ released: [{ path: 'lib/', kind: 'folder' }], stillDivergent: [] });
    const all = await ana.call('release', {});
    expect(all.value.released.map((l: { path: string }) => l.path).sort()).toEqual(['src/auth/', 'src/auth/login.ts']);
    expect(all.value.stillDivergent).toEqual(['src/auth/login.ts']);
    expect((await ana.call('release', { paths: ['never/held.ts'] })).value).toEqual({ released: [], stillDivergent: [] });
  });

  it('take refuses a working holder and takes from a takeable one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-21T10:00:00Z'));
    const room = 'tool-take';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.hook(editBody('f.ts'));
    await ana.hook({ event: 'Stop' });
    vi.setSystemTime(Date.parse('2026-10-21T10:05:00Z'));
    const early = await nico.call('take', { path: 'f.ts', reason: 'need it' });
    expect(early.value).toMatchObject({ ok: false, error: expect.stringContaining('not takeable') });
    vi.setSystemTime(Date.parse('2026-10-21T10:20:00Z'));
    await nico.hook({});
    const taken = await nico.call('take', { path: 'f.ts', reason: 'urgent fix' });
    expect(taken.value).toMatchObject({ ok: true, lock: { path: 'f.ts', holder: nico.cs, reason: 'urgent fix' } });
    expect((await ana.hook({ event: 'PostToolUse' })).context).toContain('claude-nico took your file lock on f.ts');
    expect((await nico.call('take', { path: 'f.ts', reason: '  ' })).value).toContain('needs a reason');
    expect((await nico.call('take', { path: 'free.ts', reason: 'x' })).value).toMatchObject({ ok: false });
  });

  it('register gives a not-enforced callsign that can use the board and messages', async () => {
    const room = 'tool-register';
    const ana = await join(room, 'ana', { repoName: 'demo' });
    const token = await agentToken(room, 'nico');
    const reg = await call(token, 'register', { kind: 'codex', note: 'working through the IDE' });
    expect(reg.value).toEqual({ callsign: 'codex-nico', enforced: false });
    const second = await call(token, 'register', { kind: 'codex' });
    expect(second.value.callsign).toBe('codex-nico-2');

    const me = 'codex-nico';
    const added = await call(token, 'task_add', { me, tasks: [{ title: 'From the IDE', areas: ['ide/'] }], claim: true });
    expect(added.value.claim).toMatchObject({ result: 'ok', reserved: [{ path: 'ide/', holder: me }] });
    const status = (await ana.call('status')).value;
    const entry = status.agents.find((a: { callsign: string }) => a.callsign === me);
    expect(entry).toMatchObject({ hooked: false, kind: 'codex', repo: expect.any(String), repoName: 'demo', activity: 'working through the IDE', taskId: 1 });
    await ana.call('post', { to: me, text: 'hello IDE' });
    expect((await call(token, 'inbox', { me })).value.unread[0].text).toBe('hello IDE');
    expect((await call(token, 'register', { kind: 'codex', repo: 'nope' })).value).toContain('Unknown repo');
    expect((await call(token, 'register', { kind: 'gemini' })).rpcError?.code).toBe(-32602);
  });

  it('an agent with no repo has to name one for tools that need a repo', async () => {
    const room = 'tool-register2';
    const token = await agentToken(room, 'nico');
    const first = await call(token, 'register', { kind: 'claude' });
    expect(first.value.callsign).toBe('claude-nico');
    const noRepo = await call(token, 'reserve', { me: 'claude-nico', folders: ['a/'] });
    expect(noRepo.isError).toBe(true);
    expect(noRepo.value).toContain('You have no repo yet');
  });

  it('does not leak other tools through inherited property names', async () => {
    const a = await join('tool-proto', 'ana');
    expect((await call(a.token, 'constructor', { me: a.cs })).rpcError?.code).toBe(-32602);
    expect((await call(a.token, '__proto__', { me: a.cs })).rpcError?.code).toBe(-32602);
  });
});

describe('review fixes', () => {
  it('rejects the tools of an ended agent before running them, without touching it', async () => {
    const room = 'ended-me';
    const ana = await join(room, 'ana');
    await ana.hook({ event: 'SessionEnd', endReason: 'exit' });
    const before = await inRoom(room, (r) => r.agents.get(ana.cs)?.lastEvent);
    await new Promise((r) => setTimeout(r, 20));
    for (const [name, args] of [['status', {}], ['task_add', { tasks: [{ title: 'Ghost work' }] }], ['post', { to: 'all', text: 'hi' }]] as const) {
      const r = await ana.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.value).toContain('has ended');
    }
    expect(await inRoom(room, (r) => r.agents.get(ana.cs)?.lastEvent)).toBe(before);
    expect(await inRoom(room, (r) => r.features.tasks.list())).toEqual([]);
  });

  it('wait refuses more than 45 seconds with -32602', async () => {
    const a = await join('wait-max', 'ana');
    const r = await a.call('wait', { seconds: 46 });
    expect(r.rpcError?.code).toBe(-32602);
    expect(r.rpcError?.message).toContain('at most 45');
    const tools = (await rpc(a.token, 'tools/list')).result.tools as { name: string; inputSchema: { properties: { seconds?: { maximum?: number } } } }[];
    expect(tools.find((t) => t.name === 'wait')?.inputSchema.properties.seconds?.maximum).toBe(45);
  });

  it('a batch of waits is refused at once instead of running one after another', async () => {
    const a = await join('batch-wait', 'ana');
    const started = Date.now();
    const res = await post('/mcp', a.token, [1, 2, 3].map((id) => ({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'wait', arguments: { me: a.cs, seconds: 1 } },
    })));
    expect(res.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('does not report a message event when no message is left to deliver', async () => {
    const room = 'wait-empty';
    const ana = await join(room, 'ana');
    const waiter = ana.call('wait', { seconds: 5 });
    await new Promise((r) => setTimeout(r, 50));
    await inRoom(room, (r) => {
      r.features.messages.notify(ana.cs, 'gone before the wait returns');
      r.features.messages.takeUnread(ana.cs); // read elsewhere in the same turn
    });
    expect((await waiter).value).toEqual({ event: 'timeout' });
  });

  it('caps MCP registrations at three unhooked agents per person', async () => {
    const token = await agentToken('register-cap', 'nico');
    for (let i = 0; i < 3; i++) expect((await call(token, 'register', { kind: 'claude' })).isError).toBe(false);
    const fourth = await call(token, 'register', { kind: 'claude' });
    expect(fourth.isError).toBe(true);
    expect(fourth.value).toContain('already have 3 agents registered without hooks');
    expect((await call(await agentToken('register-cap', 'sam'), 'register', { kind: 'claude' })).isError).toBe(false);
  });
});
