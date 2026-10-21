import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../shared/contracts';
import { fixtureSnapshot } from './live/fixture';
import { parseMessage } from './validate';

const base = JSON.parse(JSON.stringify(fixtureSnapshot));

describe('parseMessage element checks', () => {
  it('accepts the fixture unchanged in size', () => {
    const out = parseMessage(base) as Snapshot;
    expect(out.agents).toHaveLength(base.agents.length);
    expect(out.edges).toHaveLength(base.edges.length);
  });

  it('keeps good elements and drops malformed ones', () => {
    const bad = {
      ...base,
      agents: [...base.agents, { callsign: 'x', kind: 'robot', person: 'p', lastEvent: 1, startedAt: 1 }, null, 7],
      tasks: [...base.tasks, { id: 99, title: 'T', status: 'weird' }, { title: 'no id', status: 'open' }],
      locks: [...base.locks, { path: 'a', holder: 'b', kind: 'dir' }],
      edges: [...base.edges, { kind: 'message', from: 'a', at: 1 }, { kind: 'zap', from: 'a', to: 'b', at: 1 }],
      activity: [...base.activity, { seq: 'x', ts: 1, type: 't', text: 'y' }],
    };
    const out = parseMessage(bad) as Snapshot;
    expect(out.agents).toHaveLength(base.agents.length);
    expect(out.tasks).toHaveLength(base.tasks.length);
    expect(out.locks).toHaveLength(base.locks.length);
    expect(out.edges).toHaveLength(base.edges.length);
    expect(out.activity).toHaveLength(base.activity.length);
    expect(out.tasks.every((t) => ['open', 'in_progress', 'done', 'dropped'].includes(t.status))).toBe(true);
  });

  it('normalizes missing optional fields so rendering cannot throw', () => {
    const out = parseMessage({ ...base, agents: [{ callsign: 'a', kind: 'claude', person: 'p', lastEvent: 5, startedAt: 1 }] }) as Snapshot;
    expect(out.agents[0]).toMatchObject({ branch: null, activity: null, idleSince: null, endedAt: null, hooked: false });
  });

  it('rejects a snapshot whose lists are missing or whose usage is malformed', () => {
    expect(parseMessage({ ...base, agents: undefined })).toBeNull();
    expect(parseMessage({ ...base, usage: { requests: 'x', cap: 1 } })).toBeNull();
  });
});
