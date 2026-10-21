/** Regression tests for the Tier 2 review of PR #4. */
import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WaitRegistry } from './waits';
import {
  agentToken, connectViewer, editBody, gateOff, get, hook, inRoom, post, REPO, roomStub, viewerToken,
} from './test-helpers';

afterEach(() => {
  vi.useRealTimers();
});

const T0 = Date.parse('2026-10-21T10:00:00Z');
const at = (ms: number) => vi.setSystemTime(T0 + ms);
const clock = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
};
const HOUR = 3_600_000;
type Meta = { meta: Map<string, string> };

describe('1: over agents are cleaned up before their callsign is reused or session revived', () => {
  it('a reused callsign inherits no locks and no messages', async () => {
    clock();
    const room = 'reuse';
    const a = await agentToken(room, 'ana');
    await hook(a, 's1', editBody('f.ts'));
    await inRoom(room, (r) => r.features.messages.notify('claude-ana', 'for the old session'));
    at(13 * HOUR); // silent for 12 hours: ended, but endedAt was never set
    const fresh = await hook(a, 's2', { event: 'SessionStart' });
    expect(fresh.callsign).toBe('claude-ana');
    expect(fresh.context).not.toContain('for the old session');
    expect(await inRoom(room, (r) => r.features.locks.list())).toEqual([]);
    expect(await inRoom(room, (r) => r.features.messages.hasUnreadDirect('claude-ana'))).toBe(false);
  });

  it('a revived session starts without its old locks', async () => {
    clock();
    const room = 'revive';
    const a = await agentToken(room, 'ana');
    await hook(a, 's1', editBody('f.ts'));
    at(13 * HOUR);
    const back = await hook(a, 's1', { event: 'PostToolUse' });
    expect(back.callsign).toBe('claude-ana');
    expect(await inRoom(room, (r) => r.features.locks.list())).toEqual([]);
  });

  it('reaps over agents when the Room boots', async () => {
    clock();
    const room = 'boot-reap';
    const a = await agentToken(room, 'ana');
    await hook(a, 's1', editBody('f.ts'));
    await inRoom(room, (r) => r.features.messages.notify('claude-ana', 'old'));
    at(13 * HOUR);
    await evictDurableObject(roomStub(room));
    const after = await inRoom(room, (r) => ({
      ended: r.agents.get('claude-ana')?.endedAt ?? null,
      locks: r.features.locks.list().length,
      unread: r.features.messages.hasUnreadDirect('claude-ana'),
    }));
    expect(after.ended).not.toBeNull();
    expect(after).toMatchObject({ locks: 0, unread: false });
  });
});

describe('2: notify filters survive a restart', () => {
  it('a restarted Room filters a broadcast the same way', async () => {
    const room = 'filters';
    const [a, b, c] = await Promise.all(['ana', 'nico', 'sam'].map((p) => agentToken(room, p)));
    await hook(a as string, 'sa', { event: 'SessionStart' });
    await hook(b as string, 'sb', { event: 'SessionStart' });
    await hook(c as string, 'sc', { event: 'SessionStart', repo: 'b'.repeat(40) });
    await inRoom(room, (r) => r.features.messages.notify('*', 'pushed', { repo: REPO, exclude: ['claude-ana'] }));
    await evictDurableObject(roomStub(room));
    expect((await hook(a as string, 'sa', {})).context).toBeNull();
    expect((await hook(c as string, 'sc', { repo: 'b'.repeat(40) })).context).toBeNull();
    expect((await hook(b as string, 'sb', {})).context).toContain('pushed');
  });
});

describe('3: editing under your own folder reservation still takes a file lock', () => {
  it('takes the file lock too', async () => {
    const room = 'own-folder';
    await hook(await agentToken(room, 'ana'), 'sa', { event: 'SessionStart' });
    const kinds = await inRoom(room, (r) => {
      const me = { callsign: 'claude-ana', person: 'ana', kind: 'claude' as const, repo: REPO, checkout: 'checkout-1' };
      r.features.locks.reserve(me, [{ repo: REPO, folder: 'src/' }], null, null);
      r.features.locks.checkEdit(me, REPO, ['src/a.ts']);
      return r.features.locks.list().map((l) => `${l.kind}:${l.path}`);
    });
    expect(kinds).toEqual(['folder:src/', 'file:src/a.ts']);
  });
});

describe('4: paths are canonical', () => {
  it('rejects absolute and escaping paths and keys locks on the canonical path', async () => {
    const room = 'canon';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    for (const bad of ['../x.ts', '/etc/passwd', 'C:/x.ts', 'a/../../x.ts']) {
      const res = await post('/hook', a, { v: 1, event: 'PreToolUse', agent: 'claude', session: 'sa', repo: REPO, checkout: 'c', branch: null, head: null, paths: [bad] });
      expect(res.status, bad).toBe(400);
      await res.text();
    }
    const gitBad = await post('/hook', a, { v: 1, event: 'PostToolUse', agent: 'claude', session: 'sa', repo: REPO, checkout: 'c', branch: null, head: null, git: { divergent: ['../x'], upstream: null, truncated: false, pushed: null } });
    expect(gitBad.status).toBe(400);
    await gitBad.text();

    expect((await hook(a, 'sa', { ...gateOff, ...editBody('src/./a/../b.ts') })).decision).toBe('allow');
    expect((await inRoom(room, (r) => r.features.locks.list().map((l) => l.path)))).toEqual(['src/b.ts']);
    const denied = await hook(b, 'sb', editBody('./src//b.ts'));
    expect(denied.decision).toBe('deny');
    const bad = await post('/unlock', b, { path: { repo: REPO, path: '../src/b.ts' } });
    expect(bad.status).toBe(400);
    await bad.text();
    const ok = await post('/unlock', b, { path: { repo: REPO, path: 'src/x/../b.ts' } });
    expect(((await ok.json()) as { released: unknown[] }).released).toHaveLength(1);
  });
});

describe('5: MCP tool names', () => {
  it('answers inherited names with -32602, not HTTP 500', async () => {
    const t = await agentToken('mcp-proto', 'ana');
    await hook(t, 'sa', { event: 'SessionStart' });
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const res = await post('/mcp', t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { me: 'claude-ana' } } });
      expect(res.status, name).toBe(200);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
    }
  });
});

describe('6: rule 3 follows the lock checkout', () => {
  it('ignores a holder reporting from another checkout and accepts any agent of the lock checkout', async () => {
    clock();
    const room = 'checkouts';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', { ...gateOff, ...editBody('f.ts') }); // checkout-1
    await hook(b, 'sb', { event: 'SessionStart' }); // checkout-1
    at(30_000);
    const empty = { divergent: [], upstream: 'origin/main', truncated: false, pushed: null };
    await hook(a, 'sa', { checkout: 'checkout-2', git: empty });
    expect(await inRoom(room, (r) => r.features.locks.list().length)).toBe(1);
    await hook(b, 'sb', { checkout: 'checkout-1', git: empty });
    expect(await inRoom(room, (r) => r.features.locks.list().length)).toBe(0);
  });
});

describe('7: young locks survive an older Git report', () => {
  it('does not release a lock taken within the last heartbeat interval', async () => {
    clock();
    const room = 'young';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', { ...gateOff, ...editBody('f.ts') });
    at(5_000);
    await hook(a, 'sa', { git: { divergent: [], upstream: 'origin/main', truncated: false, pushed: null } });
    expect(await inRoom(room, (r) => r.features.locks.list().length)).toBe(1);
    at(16_000);
    await hook(a, 'sa', { git: { divergent: [], upstream: 'origin/main', truncated: false, pushed: null } });
    expect(await inRoom(room, (r) => r.features.locks.list().length)).toBe(0);
  });
});

describe('8: snapshots only when something changed', () => {
  it('stays quiet for whoami, rejected requests and no-op heartbeats', async () => {
    const room = 'quiet';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(a, 'sa', { event: 'PostToolUse' }); // settles activity and branch
    const viewer = await connectViewer(room, await viewerToken(room));
    await viewer.next((m) => m.type === 'snapshot');
    await new Promise((r) => setTimeout(r, 400));
    const baseline = viewer.messages.length;
    await (await get('/whoami', a)).text();
    await (await get('/whoami', 'garbage')).text();
    await hook(a, 'sa', { event: 'PostToolUse' });
    await new Promise((r) => setTimeout(r, 500));
    expect(viewer.messages.length).toBe(baseline);
    await hook(a, 'sa', { event: 'PostToolUse', branch: 'feature' });
    await viewer.next((m) => m.type === 'snapshot' && (m.agents as { branch: string }[])[0]?.branch === 'feature');
    viewer.socket.close();
  });
});

describe('9, 10, 11, 12: housekeeping', () => {
  it('prunes old budget rows even when the guard never switched', async () => {
    clock();
    const room = 'prune-budget';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', {});
    await inRoom(room, (r, state) => {
      (r as unknown as Meta).meta.set('budget:2026-10-01', '5');
      state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('budget:2026-10-01', '5')").toArray();
    });
    at(61_000);
    await hook(a, 'sa', {});
    expect(await inRoom(room, (r) => (r as unknown as Meta).meta.has('budget:2026-10-01'))).toBe(false);
  });

  it('/mode with the current mode makes no event and no announcement; a change names the person', async () => {
    const room = 'mode-same';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', { event: 'SessionStart' });
    const events = (state: DurableObjectState) => state.storage.sql.exec("SELECT actor FROM events WHERE type = 'mode.changed'").toArray();
    await (await post('/mode', a, { mode: 'enforce' })).text();
    expect(await inRoom(room, (_r, s) => events(s).length)).toBe(0);
    expect((await hook(a, 'sa', {})).context).toBeNull();
    await (await post('/mode', a, { mode: 'warn' })).text();
    expect(await inRoom(room, (_r, s) => events(s).map((e) => e.actor))).toEqual(['ana']);
  });

  it('unlocking a file says when it also dropped a covering folder reservation', async () => {
    const room = 'unlock-folder';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(b, 'sb', { event: 'SessionStart' });
    await inRoom(room, (r) => r.features.locks.reserve({ callsign: 'claude-ana', person: 'ana', kind: 'claude', repo: REPO, checkout: 'c' }, [{ repo: REPO, folder: 'src/' }], null, null));
    const res = (await (await post('/unlock', b, { path: { repo: REPO, path: 'src/a.ts' } })).json()) as { released: { path: string }[]; note: string };
    expect(res.released.map((l) => l.path)).toEqual(['src/']);
    expect(res.note).toContain('folder lock src/ (held by claude-ana)');
    expect((await hook(a, 'sa', {})).context).toContain('Also dropped folder lock src/');
  });

  it('drops settings of repos nobody has been seen in for 24 hours, and delivered state of ended agents', async () => {
    clock();
    const room = 'prune-settings';
    const a = await agentToken(room, 'ana');
    const other = 'd'.repeat(40);
    await hook(a, 'sa', { event: 'SessionStart', settings: { requireTask: false } });
    await hook(a, 'sb', { event: 'SessionStart', repo: other, settings: { requireTask: false } });
    await inRoom(room, (r) => r.features.messages.notify('claude-ana', 'x'));
    await hook(a, 'sa', {}); // delivers it
    const rows = (state: DurableObjectState) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM deliveries').toArray()[0]?.n;
    expect(await inRoom(room, (_r, s) => rows(s))).toBe(1);
    await hook(a, 'sa', { event: 'SessionEnd', endReason: 'logout' });
    expect(await inRoom(room, (_r, s) => rows(s))).toBe(0);
    at(25 * HOUR);
    await hook(a, 'sc', { event: 'SessionStart' }); // only REPO is alive now
    at(25 * HOUR + 61_000);
    await hook(a, 'sc', {});
    const keys = await inRoom(room, (r) => [...(r as unknown as Meta).meta.keys()].filter((k) => k.startsWith('settings:')));
    expect(keys).toEqual([`settings:${REPO}`]);
  });
});

describe('13: waits', () => {
  it('rejects non-finite seconds and reports the event kind', async () => {
    const w = new WaitRegistry();
    expect(() => w.park('x', ['message:x'], Number.NaN)).toThrow(RangeError);
    const p = w.park('x', ['task:7'], 45);
    w.wake(['task:7']);
    expect(await p).toEqual({ event: 'task', key: 'task:7' });
  });
});

describe('round 2: invalid folders are never reserved', () => {
  it('refuses ., .., absolute, escaping and .git folders instead of reserving the whole repo', async () => {
    const room = 'bad-folders';
    await hook(await agentToken(room, 'ana'), 'sa', { event: 'SessionStart' });
    const out = await inRoom(room, (r) => {
      const me = { callsign: 'claude-ana', person: 'ana', kind: 'claude' as const, repo: REPO, checkout: 'c' };
      const results = ['.', '', '..', '../x/', '/abs/', 'a/../..', '.git/', 'C:/x/'].map((folder) => r.features.locks.reserve(me, [{ repo: REPO, folder }], null, null));
      const mixed = r.features.locks.reserve(me, [{ repo: REPO, folder: 'ok/' }, { repo: REPO, folder: '..' }], null, null);
      const good = r.features.locks.reserve(me, [{ repo: REPO, folder: './src/x/../auth' }], null, null);
      return { results, mixed, good, held: r.features.locks.list().map((l) => l.path) };
    });
    for (const res of out.results) expect(res).toEqual({ granted: false, conflicts: [] });
    expect(out.mixed.granted).toBe(false);
    expect(out.good.granted).toBe(true);
    expect(out.held).toEqual(['src/auth/']);
  });
});
