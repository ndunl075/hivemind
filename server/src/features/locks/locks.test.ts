/** §9 rules 4, 5, 9, 10 and 12, and the "a lock you waited for was released" notice. Workers pool. */
import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitStateReport } from '../../../../shared/contracts';
import type { HookRequest, ProjectSettings } from '../../../../shared/contracts';
import { agentToken, editBody, hook, inRoom, post, roomStub } from '../../test-helpers';
import { call, type Joined } from '../mcp/test-util';

afterEach(() => {
  vi.useRealTimers();
});

const T0 = Date.parse('2026-10-21T10:00:00Z');
const at = (ms: number) => vi.setSystemTime(T0 + ms);
const clock = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
};

const git = (divergent: string[], over: Partial<GitStateReport> = {}): GitStateReport => ({
  divergent, upstream: 'origin/main', truncated: false, pushed: null, ...over,
});

interface AgentOptions {
  checkout: string;
  branch?: string;
  /** Sent on SessionStart. Every agent of a room passes the same value: the Room keeps one settings object per repo. */
  settings?: ProjectSettings;
  /** The SessionStart baseline (the divergent files at start). Without it SessionStart carries no Git state. */
  baseline?: string[];
}

/** Starts an agent (SessionStart) and returns handles to act as it. Later calls repeat only checkout and branch. */
async function agent(room: string, person: string, o: AgentOptions): Promise<Joined> {
  const token = await agentToken(room, person);
  const session = `s-${person}`;
  const base: Partial<HookRequest> = { checkout: o.checkout, ...(o.branch ? { branch: o.branch } : {}) };
  const first = await hook(token, session, {
    event: 'SessionStart', ...base, settings: o.settings ?? { requireTask: false },
    ...(o.baseline ? { git: git(o.baseline, { baseline: o.baseline }) } : {}),
  });
  return {
    token, cs: first.callsign, session,
    hook: (over = {}) => hook(token, session, { ...base, ...over }),
    call: (name, args = {}) => call(token, name, { me: first.callsign, ...args }),
  };
}

const locks = (room: string) => inRoom(room, (r) => r.features.locks.list().map((l) => `${l.path}:${l.holder}`).sort());
const unread = (room: string, callsign: string) =>
  inRoom(room, (r) => r.features.messages.takeUnread(callsign).map((m) => m.text));
const events = (room: string, type: string) =>
  inRoom(room, (_r, state) => state.storage.sql.exec('SELECT data FROM events WHERE type = ? ORDER BY seq', type).toArray().map((e) => JSON.parse(String(e.data)) as Record<string, any>));
const edit = (a: Joined, path: string, over = {}) => a.hook({ ...editBody(path), ...over });

describe('rule 10: ignored paths are never locked', () => {
  it('lets two agents edit an ignored path, and .git always', async () => {
    const room = 'r10';
    const settings = { requireTask: false, ignore: ['dist/**', '*.gen.ts'] };
    const ana = await agent(room, 'ana', { checkout: 'c1', settings });
    const ben = await agent(room, 'ben', { checkout: 'c2', settings });
    for (const p of ['dist/app.js', 'dist/deep/x.js', 'api.gen.ts', '.git/config']) {
      expect((await edit(ana, p)).decision, p).toBe('allow');
      expect((await edit(ben, p)).decision, p).toBe('allow');
    }
    expect(await locks(room)).toEqual([]);
    // Anything else is still locked, and the pattern is anchored: sub/api.gen.ts is not *.gen.ts.
    await edit(ana, 'src/x.ts');
    await edit(ana, 'sub/api.gen.ts');
    expect((await edit(ben, 'src/x.ts')).decision).toBe('deny');
    expect((await edit(ben, 'sub/api.gen.ts')).decision).toBe('deny');
  });

  it('never attributes a shell edit of an ignored path', async () => {
    clock();
    const room = 'r10-shell';
    const ana = await agent(room, 'ana', { checkout: 'c1', settings: { requireTask: false, ignore: ['dist/**'] }, baseline: [] });
    at(20_000);
    await ana.hook({ git: git(['dist/a.js', 'src/b.ts']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual(['src/b.ts:claude-ana']);
  });
});

describe('rule 9: advisory paths are never denied', () => {
  it('lets both agents edit package.json and warns about the other, without locking it', async () => {
    clock();
    const room = 'r9';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const ben = await agent(room, 'ben', { checkout: 'c2' });
    const first = await edit(ana, 'package.json');
    expect(first.decision).toBe('allow');
    expect(first.context).toBeNull();
    expect(await locks(room)).toEqual([]);

    const second = await edit(ben, 'package.json');
    expect(second.decision).toBe('allow');
    expect(second.context).toMatch(/^\[Hivemind\] Heads-up: package\.json is a shared file and claude-ana also has unpushed changes to it\./);

    // Once Ana's report shows the file divergent, the warning stands on that.
    at(20_000);
    await ana.hook({ git: git(['package.json']) });
    expect((await edit(ben, 'package.json')).context).toContain('claude-ana');
    // Ana reverts it: nothing to warn about.
    at(40_000);
    await ana.hook({ git: git([]) });
    expect((await edit(ben, 'package.json')).context).toBeNull();
  });

  it('does not warn about an agent in the same checkout, which shares the working copy', async () => {
    const room = 'r9-mates';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const bea = await agent(room, 'bea', { checkout: 'c1' });
    await edit(ana, 'pnpm-lock.yaml');
    expect((await edit(bea, 'pnpm-lock.yaml')).context).toBeNull();
  });

  it('matches the defaults at any depth and a project\'s own patterns', async () => {
    const room = 'r9-globs';
    const settings = { requireTask: false, advisory: ['docs/**/*.md', '**/package-lock.json'] };
    const ana = await agent(room, 'ana', { checkout: 'c1', settings });
    const ben = await agent(room, 'ben', { checkout: 'c2', settings });
    for (const p of ['docs/a/b.md', 'web/app/package-lock.json']) {
      await edit(ana, p);
      const r = await edit(ben, p);
      expect(r.decision, p).toBe('allow');
      expect(r.context, p).toContain('shared file');
    }
    // No longer advisory once the project replaced the defaults: package.json is an ordinary file now.
    await edit(ana, 'package.json');
    expect((await edit(ben, 'package.json')).decision).toBe('deny');
  });

  it('names who has the file changed, and never denies even a held-looking file in enforce mode', async () => {
    const room = 'r9-many';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const ben = await agent(room, 'ben', { checkout: 'c2' });
    const cat = await agent(room, 'cat', { checkout: 'c3' });
    await edit(ana, 'yarn.lock');
    await edit(ben, 'yarn.lock');
    const r = await edit(cat, 'yarn.lock');
    expect(r.decision).toBe('allow');
    expect(r.context).toContain('claude-ana, claude-ben also have unpushed changes');
  });
});

describe('rule 4: shell edits are attributed afterward, with the baseline', () => {
  it('locks a new file for the agent whose shell command made it, but not the files that were already there', async () => {
    clock();
    const room = 'r4';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: ['old.txt'] });
    const ben = await agent(room, 'ben', { checkout: 'c2' });
    at(20_000);
    await ana.hook({ git: git(['old.txt', 'gen.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual(['gen.txt:claude-ana']);
    const denied = await edit(ben, 'gen.txt');
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('gen.txt is held by claude-ana');
    expect((await edit(ben, 'old.txt')).decision).toBe('allow'); // in Ana's baseline: not hers
  });

  it('needs a shell command since the previous report', async () => {
    clock();
    const room = 'r4-noshell';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: [] });
    at(20_000);
    await ana.hook({ git: git(['appeared.txt']), shellSinceHeartbeat: false });
    expect(await locks(room)).toEqual([]);
  });

  it('is only for files nobody holds', async () => {
    clock();
    const room = 'r4-held';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: [] });
    const ben = await agent(room, 'ben', { checkout: 'c2', baseline: [] });
    await edit(ben, 'taken.txt');
    await edit(ben, 'src/area/ok.txt');
    await ben.call('reserve', { folders: ['lib/'] });
    at(20_000);
    await ana.hook({ git: git(['taken.txt', 'lib/inner.txt', 'free.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual(['free.txt:claude-ana', 'lib/:claude-ben', 'src/area/ok.txt:claude-ben', 'taken.txt:claude-ben']);
  });

  it('locks it for nobody when another agent in the checkout also ran a shell command in that window', async () => {
    clock();
    const room = 'r4-mates';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: [] });
    const bea = await agent(room, 'bea', { checkout: 'c1', baseline: [] });
    at(10_000);
    await bea.hook({ git: git([]), shellSinceHeartbeat: true });
    at(20_000);
    await ana.hook({ git: git(['f.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual([]);
    // The next window is Ana's alone: Bea ran nothing since.
    at(30_000);
    await bea.hook({ git: git([]) });
    at(40_000);
    await ana.hook({ git: git(['f.txt', 'h.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual(['h.txt:claude-ana']);
  });

  it('does not lock bulk output, a truncated report, or anything without a baseline', async () => {
    clock();
    const room = 'r4-limits';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: [] });
    const blank = await agent(room, 'ben', { checkout: 'c2' });
    at(20_000);
    const many = Array.from({ length: 60 }, (_, i) => `out/f${i}.txt`);
    await ana.hook({ git: git(many), shellSinceHeartbeat: true });
    await ana.hook({ git: git([...many, 'x.txt'], { truncated: true }), shellSinceHeartbeat: true });
    at(40_000);
    await blank.hook({ git: git(['b.txt']), shellSinceHeartbeat: true });
    at(60_000);
    await blank.hook({ git: git(['b.txt', 'c.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual([]);
  });

  it('keeps attributing after the Room restarts (the baseline is stored)', async () => {
    clock();
    const room = 'r4-evict';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: ['old.txt'] });
    await evictDurableObject(roomStub(room));
    at(10_000);
    await ana.hook({ git: git(['old.txt']) }); // what the Room remembers is gone: this report only re-learns it
    at(20_000);
    await ana.hook({ git: git(['old.txt', 'new.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual(['new.txt:claude-ana']);
  });

  it('needs a previous report to compare with: the first one after a restart only re-learns', async () => {
    clock();
    const room = 'r4-first';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: [] });
    await evictDurableObject(roomStub(room));
    at(10_000);
    // First report after a restart: nothing to compare with, so a shell flag alone doesn't make an author.
    await ana.hook({ git: git(['z.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual([]);
  });
});

describe('rules 4 and 5: conflicts across checkouts, checkout-mates', () => {
  it('tells both agents once, draws a blocked edge, and announces again only after it went away', async () => {
    clock();
    const room = 'r4-conflict';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const ben = await agent(room, 'ben', { checkout: 'c2', baseline: [] });
    await edit(ana, 'shared.ts');
    at(20_000);
    const reported = await ben.hook({ git: git(['shared.ts']) });
    const toBen = [reported.context ?? ''];
    const toAna = await unread(room, 'claude-ana');
    expect(toBen[0]).toContain('Conflict: shared.ts is also changed by claude-ana in another checkout');
    expect(toAna).toHaveLength(1);
    expect(toAna[0]).toContain('claude-ben changed shared.ts, which you hold');
    const first = await events(room, 'lock.conflict');
    expect(first).toHaveLength(1);
    expect(first[0]?.edge).toEqual({ kind: 'blocked', from: 'claude-ben', to: 'claude-ana', label: 'shared.ts' });

    // Still there on the next reports: no new notices; the edge is redrawn when it would expire.
    at(40_000);
    expect((await ben.hook({ git: git(['shared.ts']) })).context).toBeNull();
    expect(await events(room, 'lock.conflict')).toHaveLength(1);
    at(120_000);
    await ben.hook({ git: git(['shared.ts']) });
    expect(await unread(room, 'claude-ana')).toEqual([]);
    expect(await events(room, 'lock.conflict')).toHaveLength(2);

    // Gone, then back: announced again.
    at(140_000);
    await ben.hook({ git: git([]) });
    at(160_000);
    expect((await ben.hook({ git: git(['shared.ts']) })).context).toContain('Conflict: shared.ts');
    expect(await unread(room, 'claude-ana')).toHaveLength(1);
  });

  it('a file that was already divergent at start still conflicts with a lock held in another checkout', async () => {
    clock();
    const room = 'r4-conflict-base';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    await edit(ana, 'shared.ts');
    const ben = await agent(room, 'ben', { checkout: 'c2', baseline: ['shared.ts'] });
    at(20_000);
    await ben.hook({ git: git(['shared.ts']) });
    expect(await unread(room, 'claude-ana')).toHaveLength(1);
    expect(await events(room, 'lock.conflict')).toHaveLength(1);
  });

  it('also flags a file under a folder reservation, and not advisory or ignored paths', async () => {
    clock();
    const room = 'r4-conflict-folder';
    const settings = { requireTask: false, ignore: ['gen/**'] };
    const ana = await agent(room, 'ana', { checkout: 'c1', settings });
    const ben = await agent(room, 'ben', { checkout: 'c2', settings, baseline: [] });
    await ana.call('reserve', { folders: ['src/'] });
    at(20_000);
    const text = (await ben.hook({ git: git(['src/a.ts', 'gen/x.ts', 'package.json']) })).context ?? '';
    expect(text).toContain('Conflict: src/a.ts is inside a folder reserved by claude-ana in another checkout');
    expect(text).not.toContain('also changed by');
    expect(text).not.toContain('gen/x.ts');
    expect(text).not.toContain('package.json');
  });

  it('never counts an agent in the same checkout as a conflict, and any of them can release the lock', async () => {
    clock();
    const room = 'r5';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const bea = await agent(room, 'bea', { checkout: 'c1', baseline: [] });
    await edit(ana, 'f.ts');
    at(20_000);
    await bea.hook({ git: git(['f.ts']) });
    expect(await unread(room, 'claude-ana')).toEqual([]);
    expect(await unread(room, 'claude-bea')).toEqual([]);
    expect(await events(room, 'lock.conflict')).toEqual([]);
    // Rule 2 still holds for edits: one holder.
    expect((await edit(bea, 'f.ts')).decision).toBe('deny');
    // The file stops being divergent in their shared checkout: the lock goes, whoever reports.
    at(40_000);
    await bea.hook({ git: git([]) });
    expect(await locks(room)).toEqual([]);
    expect((await edit(bea, 'f.ts')).decision).toBe('allow');
  });

  it('warn mode still announces the conflict', async () => {
    clock();
    const room = 'r4-warn';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const ben = await agent(room, 'ben', { checkout: 'c2', baseline: [] });
    await edit(ana, 'w.ts');
    await ana.hook({ git: git(['w.ts']) });
    expect((await post('/mode', ana.token, { mode: 'warn' })).status).toBe(200);
    at(20_000);
    await ben.hook({ git: git(['w.ts']) });
    expect((await unread(room, 'claude-ana')).filter((m) => m.startsWith('Conflict:'))).toHaveLength(1);
  });
});

describe('rule 12: branches don\'t separate locks', () => {
  it('a lock held on one branch denies an edit on another, and a push of either branch releases it', async () => {
    clock();
    const room = 'r12';
    const ana = await agent(room, 'ana', { checkout: 'c1', branch: 'main' });
    const ben = await agent(room, 'ben', { checkout: 'c2', branch: 'feature/auth' });
    await edit(ana, 'src/login.ts');
    const denied = await edit(ben, 'src/login.ts');
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('src/login.ts is held by claude-ana');
    // Ana pushes her work to another branch: the file is no longer divergent in her checkout.
    at(20_000);
    await ana.hook({
      branch: 'wip',
      git: git([], { upstream: 'origin/wip', pushed: { branch: 'wip', sha: 'a1b2c3d', files: [{ path: 'src/login.ts', blob: 'b'.repeat(40) }] } }),
    });
    expect(await locks(room)).toEqual([]);
    expect((await edit(ben, 'src/login.ts')).decision).toBe('allow');
  });
});

describe('"a lock you waited for was released"', () => {
  it('tells the agent that was denied, once, when the lock goes', async () => {
    clock();
    const room = 'wait-notice';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const ben = await agent(room, 'ben', { checkout: 'c2' });
    const cat = await agent(room, 'cat', { checkout: 'c3' });
    await edit(ana, 'hot.ts');
    expect((await edit(ben, 'hot.ts')).decision).toBe('deny');
    expect((await edit(ben, 'hot.ts')).decision).toBe('deny'); // twice is one memory
    at(20_000);
    await ana.hook({ git: git([]) });
    expect(await unread(room, 'claude-ben')).toEqual([
      'A lock you waited for was released: hot.ts (was held by claude-ana). You can edit it now. If claude-ana pushed, pull first.',
    ]);
    expect(await unread(room, 'claude-cat')).toEqual([]);
    expect(cat.cs).toBe('claude-cat');
    // Told once: a later release of a new lock doesn't repeat it.
    await edit(ana, 'hot.ts');
    at(60_000);
    await ana.hook({ git: git([]) });
    expect(await unread(room, 'claude-ben')).toEqual([]);
  });

  it('also covers an explicit release and an emergency unlock, but not the releaser itself', async () => {
    const room = 'wait-notice-release';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const ben = await agent(room, 'ben', { checkout: 'c2' });
    await edit(ana, 'a.ts');
    await edit(ana, 'b.ts');
    await edit(ben, 'a.ts');
    await edit(ben, 'b.ts');
    await ana.call('release', { paths: ['a.ts'] });
    await inRoom(room, (r) => r.features.locks.unlockPath(r.agents.get('claude-ana')?.repo as string, 'b.ts'));
    const msgs = await unread(room, 'claude-ben');
    expect(msgs).toHaveLength(2);
    expect(msgs.join('\n')).toContain('a.ts');
    expect(msgs.join('\n')).toContain('b.ts');
    expect(await unread(room, 'claude-ana')).toEqual([]);
  });

  it('forgets denials after two hours', async () => {
    clock();
    const room = 'wait-notice-ttl';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const ben = await agent(room, 'ben', { checkout: 'c2' });
    await edit(ana, 'old.ts');
    await edit(ben, 'old.ts');
    at(3 * 3_600_000);
    await ana.hook({ git: git([]) });
    expect(await unread(room, 'claude-ben')).toEqual([]);
  });

  it('keeps its memory bounded', async () => {
    const room = 'wait-notice-bound';
    const ana = await agent(room, 'ana', { checkout: 'c1' });
    const names = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12'];
    const others = [];
    for (const n of names) others.push(await agent(room, n, { checkout: `c-${n}` }));
    await edit(ana, 'hot.ts');
    for (const o of others) await edit(o, 'hot.ts');
    await ana.call('release', { paths: ['hot.ts'] });
    let told = 0;
    for (const n of names) if ((await unread(room, `claude-${n}`)).length > 0) told++;
    expect(told).toBe(10); // the ten most recent
  });
});

describe('rule 4: a checkout-mate that has not reported makes the author ambiguous', () => {
  it('locks for nobody while a mate has been silent since the previous report', async () => {
    clock();
    const room = 'r4-silent-mate';
    const ana = await agent(room, 'ana', { checkout: 'c1', baseline: [] });
    await agent(room, 'bea', { checkout: 'c1', baseline: [] });
    at(10_000);
    await ana.hook({ git: git([]) });
    at(20_000);
    await ana.hook({ git: git(['f.txt']), shellSinceHeartbeat: true });
    expect(await locks(room)).toEqual([]);
  });
});
