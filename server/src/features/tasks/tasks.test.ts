import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '../../../../shared/contracts';
import { agentToken, editBody, inRoom, post, REPO, roomStub } from '../../test-helpers';
import { call, join } from '../mcp/test-util';

afterEach(() => {
  vi.useRealTimers();
});

const GATE_ON = { settings: { requireTask: true } };

describe('claims', () => {
  it('100 concurrent claims of one task leave exactly one owner', async () => {
    const room = 'claim-race';
    const agents = await Promise.all(Array.from({ length: 50 }, (_, i) => join(room, `p${i}`)));
    const [first] = agents;
    const added = await first!.call('task_add', { tasks: [{ title: 'The contested task' }] });
    const id = added.value.created[0].id as number;

    const results = await Promise.all(agents.flatMap((a) => [0, 1].map(async () => ({ a, r: await a.call('task_claim', { id }) }))));
    expect(results).toHaveLength(100);
    const oks = results.filter((x) => x.r.value.result === 'ok');
    const owners = new Set(oks.map((x) => x.a.cs));
    expect(owners.size).toBe(1);
    const taken = results.filter((x) => x.r.value.result === 'taken');
    expect(taken.length).toBe(100 - oks.length);
    for (const t of taken) {
      expect(t.r.value.owner).toBe([...owners][0]);
      expect(t.r.value.takeable).toBe(false);
    }
    const board = await inRoom(room, (r) => r.features.tasks.list());
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ status: 'in_progress', owner: [...owners][0] });
  });

  it('is idempotent for the owner, and refuses done or dropped tasks', async () => {
    const a = await join('claim-idem', 'ana');
    const { value } = await a.call('task_add', { tasks: [{ title: 'Write docs' }, { title: 'Unrelated spike' }], claim: false });
    const [one, two] = value.created as { id: number }[];
    expect((await a.call('task_claim', { id: one!.id })).value.result).toBe('ok');
    const again = await a.call('task_claim', { id: one!.id });
    expect(again.value).toMatchObject({ result: 'ok', task: { id: one!.id, owner: a.cs } });
    await a.call('task_update', { id: one!.id, status: 'done' });
    const refused = await a.call('task_claim', { id: one!.id });
    expect(refused.isError).toBe(true);
    expect(refused.value).toContain('is done');
    expect((await a.call('task_claim', { id: 9999 })).value).toContain('no task #9999');
    await a.call('task_update', { id: two!.id, status: 'dropped' });
    expect((await a.call('task_claim', { id: two!.id })).value).toContain('is dropped');
  });
});

describe('updates', () => {
  it('only the owner updates a task; the creator may drop it while it is open', async () => {
    const room = 'owner-only';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    const added = await ana.call('task_add', { tasks: [{ title: 'Login page' }, { title: 'Seed data' }, { title: 'Spare task' }] });
    const [login, seed, spare] = added.value.created as { id: number }[];
    await ana.call('task_claim', { id: login!.id });

    const denied = await nico.call('task_update', { id: login!.id, status: 'done' });
    expect(denied.isError).toBe(true);
    expect(denied.value).toContain('Only claude-ana can update task');
    expect((await nico.call('task_update', { id: login!.id, status: 'dropped' })).isError).toBe(true);

    // An open task has no owner: a non-creator cannot touch it, the creator can drop it.
    expect((await nico.call('task_update', { id: seed!.id, status: 'dropped' })).isError).toBe(true);
    expect((await nico.call('task_update', { id: seed!.id, status: 'in_progress' })).isError).toBe(true);
    const dropped = await ana.call('task_update', { id: seed!.id, status: 'dropped', note: 'not needed' });
    expect(dropped.value.task).toMatchObject({ status: 'dropped', owner: null, note: 'not needed' });

    // The creator may not drop a task someone else owns, even her own.
    await nico.call('task_claim', { id: spare!.id });
    expect((await ana.call('task_update', { id: spare!.id, status: 'dropped' })).isError).toBe(true);

    // The owner: note while blocked, give back, finish.
    const blocked = await ana.call('task_update', { id: login!.id, status: 'in_progress', note: 'waiting on the API' });
    expect(blocked.value.task).toMatchObject({ status: 'in_progress', note: 'waiting on the API', owner: 'claude-ana' });
    const given = await ana.call('task_update', { id: login!.id, status: 'open' });
    expect(given.value.task).toMatchObject({ status: 'open', owner: null });
    await nico.call('task_claim', { id: login!.id });
    expect((await nico.call('task_update', { id: login!.id, status: 'done' })).value.task).toMatchObject({ status: 'done', owner: 'claude-nico' });
    expect((await nico.call('task_update', { id: login!.id, status: 'open' })).value).toContain('already done');
  });
});

describe('the task gate', () => {
  it('denies an edit without a task and allows it after task_add with claim: true', async () => {
    const room = 'gate';
    const ana = await join(room, 'ana', GATE_ON);
    const denied = await ana.hook(editBody('src/a.ts'));
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('[Hivemind] Edit blocked: Claim a task first (`task_claim`, or `task_add` with `claim: true`).');

    const added = await ana.call('task_add', { tasks: [{ title: 'Build the A module' }], claim: true });
    expect(added.value.claim).toMatchObject({ result: 'ok', task: { owner: 'claude-ana', status: 'in_progress' } });
    expect((await ana.hook(editBody('src/a.ts'))).decision).toBe('allow');

    // Finishing the task closes the gate again.
    await ana.call('task_update', { id: added.value.created[0].id, status: 'done' });
    expect((await ana.hook(editBody('src/b.ts'))).decision).toBe('deny');
  });

  it('lists open tasks in the denial, is off with requireTask: false, and only warns in warn mode', async () => {
    const room = 'gate-modes';
    const ana = await join(room, 'ana', GATE_ON);
    await ana.call('task_add', { tasks: [{ title: 'Settings page' }, { title: 'Empty states' }] });
    const denied = await ana.hook(editBody('x.ts'));
    expect(denied.reason).toContain('Open tasks: #1 Settings page · #2 Empty states.');

    const off = await ana.hook({ ...editBody('y.ts'), settings: { requireTask: false } });
    expect(off.decision).toBe('allow');

    const on = await ana.hook({ ...editBody('z.ts'), ...GATE_ON });
    expect(on.decision).toBe('deny');
    await post('/mode', ana.token, { mode: 'warn' });
    const warn = await ana.hook({ ...editBody('z.ts'), ...GATE_ON });
    expect(warn.decision).toBe('allow');
    expect(warn.context).toContain('Heads-up: Claim a task first');
    await post('/mode', ana.token, { mode: 'off' });
    expect((await ana.hook({ ...editBody('w.ts'), ...GATE_ON })).context).toBeNull();
  });

  it('a task owned by someone else does not open the gate', async () => {
    const room = 'gate-other';
    const ana = await join(room, 'ana', GATE_ON);
    const nico = await join(room, 'nico', GATE_ON);
    await ana.call('task_add', { tasks: [{ title: 'Only mine' }], claim: true });
    expect((await ana.hook(editBody('a.ts'))).decision).toBe('allow');
    expect((await nico.hook(editBody('b.ts'))).decision).toBe('deny');
  });
});

describe('dependencies', () => {
  it('refuses a claim while a dependency is open or in progress, and counts done and dropped as satisfied', async () => {
    const room = 'deps';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    const base = await ana.call('task_add', { tasks: [{ title: 'Database schema' }, { title: 'Auth endpoints' }] });
    const [schema, auth] = base.value.created as { id: number }[];
    const dep = await ana.call('task_add', { tasks: [{ title: 'Login screen', dependsOn: [schema!.id, auth!.id] }] });
    const screen = dep.value.created[0].id as number;

    const waiting = await nico.call('task_claim', { id: screen });
    expect(waiting.value).toEqual({ result: 'waiting', unfinished: [schema!.id, auth!.id] });

    await ana.call('task_claim', { id: schema!.id }); // in progress still counts as unfinished
    expect((await nico.call('task_claim', { id: screen })).value).toEqual({ result: 'waiting', unfinished: [schema!.id, auth!.id] });

    await ana.call('task_update', { id: schema!.id, status: 'done' });
    expect((await nico.call('task_claim', { id: screen })).value).toEqual({ result: 'waiting', unfinished: [auth!.id] });

    await ana.call('task_update', { id: auth!.id, status: 'dropped' }); // creator drops an open task
    const ok = await nico.call('task_claim', { id: screen });
    expect(ok.value).toMatchObject({ result: 'ok', task: { id: screen, owner: 'claude-nico', dependsOn: [schema!.id, auth!.id] } });
  });

  it('rejects dependencies on tasks that do not exist, and creates a task with claim whose dependencies are unfinished', async () => {
    const a = await join('deps2', 'ana');
    const bad = await a.call('task_add', { tasks: [{ title: 'Orphan', dependsOn: [42] }] });
    expect(bad.isError).toBe(true);
    expect(bad.value).toContain('Task #42 does not exist');
    expect((await inRoom('deps2', (r) => r.features.tasks.list()))).toHaveLength(0);

    const base = await a.call('task_add', { tasks: [{ title: 'Foundation work' }] });
    const chained = await a.call('task_add', { tasks: [{ title: 'Built on foundation', dependsOn: [base.value.created[0].id] }], claim: true });
    expect(chained.value.created).toHaveLength(1);
    expect(chained.value.claim).toEqual({ result: 'waiting', unfinished: [base.value.created[0].id] });
    expect((await inRoom('deps2', (r) => r.features.tasks.list())).map((t: TaskView) => t.status)).toEqual(['open', 'open']);
  });

  it('wakes a waiter when the dependency changes', async () => {
    const room = 'deps-wait';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    const base = await ana.call('task_add', { tasks: [{ title: 'Shared types' }], claim: true });
    const id = base.value.created[0].id as number;
    const waiter = nico.call('wait', { seconds: 20, for: `task:${id}` });
    await new Promise((r) => setTimeout(r, 50));
    await ana.call('task_update', { id, status: 'done' });
    expect((await waiter).value).toEqual({ event: 'task' });
    // Already finished: returns at once.
    expect((await nico.call('wait', { seconds: 20, for: `task:${id}` })).value).toEqual({ event: 'task' });
  });
});

describe('duplicates', () => {
  it('returns an exact normalized duplicate instead of creating it, unless forced', async () => {
    const a = await join('dup-exact', 'ana');
    await a.call('task_add', { tasks: [{ title: 'Build the login page' }] });
    const dup = await a.call('task_add', { tasks: [{ title: 'build LOGIN page!!' }] });
    expect(dup.value.created).toEqual([]);
    expect(dup.value.duplicates).toHaveLength(1);
    expect(dup.value.duplicates[0]).toMatchObject({ title: 'build LOGIN page!!', existing: { id: 1, title: 'Build the login page' } });
    const forced = await a.call('task_add', { tasks: [{ title: 'build LOGIN page!!' }], force: true });
    expect(forced.value.created).toHaveLength(1);
    expect(forced.value.duplicates).toEqual([]);
  });

  it('treats a Jaccard overlap of 0.8 as a duplicate and 0.75 as merely similar', async () => {
    const a = await join('dup-jaccard', 'ana');
    await a.call('task_add', { tasks: [{ title: 'alpha beta gamma delta' }] });
    const at80 = await a.call('task_add', { tasks: [{ title: 'alpha beta gamma delta epsilon' }] });
    expect(at80.value.created).toEqual([]);
    expect(at80.value.duplicates[0].existing.id).toBe(1);
    const at75 = await a.call('task_add', { tasks: [{ title: 'alpha beta gamma zeta' }] });
    expect(at75.value.duplicates).toEqual([]);
    expect(at75.value.created[0].similar).toEqual([{ id: 1, title: 'alpha beta gamma delta' }]);
  });

  it('returns at most three similar titles, most similar first, and ignores dropped tasks', async () => {
    const a = await join('dup-similar', 'ana');
    await a.call('task_add', { tasks: [
      { title: 'user profile page' }, { title: 'user profile avatar upload' }, { title: 'user settings page' },
      { title: 'billing page' }, { title: 'profile page redesign' },
    ] });
    const added = await a.call('task_add', { tasks: [{ title: 'user profile screen' }] });
    const similar = added.value.created[0].similar as { id: number }[];
    expect(similar).toHaveLength(3);
    expect(similar[0]!.id).toBe(1); // 2 of 4 words shared beats the rest
    await a.call('task_update', { id: 1, status: 'dropped' });
    const later = await a.call('task_add', { tasks: [{ title: 'user profile view' }] });
    expect((later.value.created[0].similar as { id: number }[]).map((s) => s.id)).not.toContain(1);
  });

  it('does not compare against done tasks as duplicates, and catches duplicates inside one call', async () => {
    const a = await join('dup-batch', 'ana');
    const first = await a.call('task_add', { tasks: [{ title: 'Ship it' }], claim: true });
    await a.call('task_update', { id: first.value.created[0].id, status: 'done' });
    const again = await a.call('task_add', { tasks: [{ title: 'Ship it' }, { title: 'ship it' }, { title: 'Write release notes' }] });
    expect(again.value.created.map((c: { title: string }) => c.title)).toEqual(['Ship it', 'Write release notes']);
    expect(again.value.duplicates).toHaveLength(1);
  });
});

describe('areas and takeover', () => {
  it('reserves the areas on a claim and frees them when the task is done', async () => {
    const room = 'areas';
    const ana = await join(room, 'ana', { repoName: 'demo' });
    const nico = await join(room, 'nico', { repoName: 'demo' });
    const added = await ana.call('task_add', { tasks: [{ title: 'Rework auth', areas: ['src/auth', 'src/auth/', 'src/session/'] }], claim: true });
    expect(added.value.claim.reserved.map((l: { path: string }) => l.path)).toEqual(['src/auth/', 'src/session/']);
    expect(added.value.claim.reserved[0]).toMatchObject({ kind: 'folder', holder: 'claude-ana', taskId: 1, repo: REPO });

    const blocked = await nico.hook(editBody('src/auth/login.ts'));
    expect(blocked.decision).toBe('deny');
    await ana.call('task_update', { id: 1, status: 'done' });
    expect((await nico.hook(editBody('src/auth/login.ts'))).decision).toBe('allow');
    expect((await inRoom(room, (r) => r.features.locks.list())).filter((l) => l.holder === 'claude-ana')).toEqual([]);
  });

  it('claims even when an area is held by someone else, and says so', async () => {
    const room = 'areas-busy';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.call('reserve', { folders: ['src/api/'] });
    const added = await nico.call('task_add', { tasks: [{ title: 'Api and ui', areas: ['src/api/', 'src/ui/'] }], claim: true });
    expect(added.value.claim.result).toBe('ok');
    expect(added.value.claim.reserved.map((l: { path: string }) => l.path)).toEqual(['src/ui/']);
    expect(added.value.claim.warning).toContain('src/api/ (held by claude-ana)');
  });

  it('validates areas and needs a repo for them', async () => {
    const a = await join('areas-bad', 'ana');
    expect((await a.call('task_add', { tasks: [{ title: 'X task', areas: ['../outside/'] }] })).value).toContain('Invalid area');
    expect((await a.call('task_add', { tasks: [{ title: 'X task', areas: ['.git/hooks'] }] })).value).toContain('Invalid area');
    expect((await a.call('task_add', { tasks: [{ title: 'X task', areas: ['src/'] }], repo: 'nope' })).value).toContain('Unknown repo');
    const token = await agentToken('areas-bad', 'nico');
    const reg = await call(token, 'register', { kind: 'claude' });
    const noRepo = await call(token, 'task_add', { me: reg.value.callsign, tasks: [{ title: 'Y task', areas: ['src/'] }] });
    // The room has exactly one repo, so register picked it up and the areas resolve.
    expect(noRepo.isError).toBe(false);
  });

  it('takes over a takeable owner\'s task with a reason, moves the reservations, and notifies the old owner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-21T10:00:00Z'));
    const room = 'takeover-task';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.call('task_add', { tasks: [{ title: 'Payments', areas: ['src/pay/'] }], claim: true });
    await ana.hook({ event: 'Stop' });

    vi.setSystemTime(Date.parse('2026-10-21T10:10:00Z'));
    nico.hook({}); // keep nico active
    const early = await nico.call('task_claim', { id: 1, take: true, reason: 'urgent' });
    expect(early.value).toEqual({ result: 'taken', owner: 'claude-ana', ownerState: 'idle', takeable: false });

    vi.setSystemTime(Date.parse('2026-10-21T10:20:00Z'));
    await nico.hook({});
    const plain = await nico.call('task_claim', { id: 1 });
    expect(plain.value).toEqual({ result: 'taken', owner: 'claude-ana', ownerState: 'idle', takeable: true });
    const noReason = await nico.call('task_claim', { id: 1, take: true });
    expect(noReason.isError).toBe(true);
    expect(noReason.value).toContain('needs a reason');

    const took = await nico.call('task_claim', { id: 1, take: true, reason: 'Ana is away' });
    expect(took.value).toMatchObject({ result: 'ok', task: { owner: 'claude-nico' } });
    expect(took.value.reserved.map((l: { holder: string }) => l.holder)).toEqual(['claude-nico']);
    const notice = await ana.hook({ event: 'PostToolUse' });
    expect(notice.context).toContain('claude-nico took over your task #1 "Payments" (reason: Ana is away)');
    expect((await ana.call('task_update', { id: 1, status: 'done' })).isError).toBe(true);
  });
});

describe('ended owners', () => {
  it('returns the tasks of an ended owner to open with a note, and frees the folders', async () => {
    const room = 'ended-owner';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.call('task_add', { tasks: [{ title: 'Long job', areas: ['lib/'] }], claim: true });
    await ana.call('task_update', { id: 1, status: 'in_progress', note: 'half way' });
    await ana.hook({ event: 'SessionEnd', endReason: 'exit' });

    const board = await inRoom(room, (r) => r.features.tasks.list());
    expect(board[0]).toMatchObject({ status: 'open', owner: null });
    expect(board[0]!.note).toContain('claude-ana ended');
    expect(board[0]!.note).toContain('half way');
    expect((await inRoom(room, (r) => r.features.locks.list()))).toEqual([]);
    expect((await nico.call('task_claim', { id: 1 })).value.result).toBe('ok');
  });

  it('returns tasks lazily when the owner has been silent for 12 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-21T10:00:00Z'));
    const room = 'ended-silent';
    const ana = await join(room, 'ana');
    const nico = await join(room, 'nico');
    await ana.call('task_add', { tasks: [{ title: 'Silent job' }], claim: true });
    vi.setSystemTime(Date.parse('2026-10-21T22:30:00Z'));
    const status = await nico.call('status');
    expect(status.value.tasks).toMatchObject([{ id: 1, status: 'open', owner: null }]);
    expect(status.value.agents.map((a: { callsign: string }) => a.callsign)).toEqual(['claude-nico']);
  });
});

describe('persistence', () => {
  it('keeps the board across a Room restart', async () => {
    const room = 'tasks-restart';
    const ana = await join(room, 'ana');
    await ana.call('task_add', { tasks: [{ title: 'Survives restarts', description: 'details', areas: ['pkg/'] }, { title: 'Second one' }], claim: false });
    await ana.call('task_claim', { id: 1 });
    await ana.call('task_add', { tasks: [{ title: 'Third one', dependsOn: [1] }] });
    await evictDurableObject(roomStub(room));
    const board = await inRoom(room, (r) => r.features.tasks.list());
    expect(board.map((t: TaskView) => [t.id, t.status, t.owner, t.dependsOn])).toEqual([
      [1, 'in_progress', 'claude-ana', []], [2, 'open', null, []], [3, 'open', null, [1]],
    ]);
    expect(board[0]).toMatchObject({ description: 'details', areas: [{ repo: REPO, folder: 'pkg/' }], createdBy: 'claude-ana' });
    const next = await (await join(room, 'sam')).call('task_add', { tasks: [{ title: 'Fourth one' }] });
    expect(next.value.created[0].id).toBe(4);
  });

  it('puts a line about your task into the briefing', async () => {
    const room = 'briefing-task';
    const ana = await join(room, 'ana');
    await ana.call('task_add', { tasks: [{ title: 'My own work' }], claim: true });
    const again = await ana.hook({ event: 'SessionStart' });
    expect(again.context).toContain('Your task: #1 My own work');
  });
});

describe('input hygiene', () => {
  it('cleans titles to one line and rejects empty ones', async () => {
    const a = await join('hygiene', 'ana');
    const dirty = ['  Fix', String.fromCharCode(10), 'the ', String.fromCharCode(0x202e), 'bug', String.fromCharCode(7), ' ', String.fromCharCode(13, 10), ' now  '].join('');
    const added = await a.call('task_add', { tasks: [{ title: dirty }] });
    expect(added.value.created[0].title).toBe('Fix the bug now');
    expect((await a.call('task_add', { tasks: [{ title: '   ' }] })).value).toContain('needs a title');
    expect((await a.call('task_add', { tasks: [{ title: 'A' }, { title: 'B' }], claim: true })).value).toContain('single task');
  });
});
