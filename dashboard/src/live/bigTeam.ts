/**
 * "Big team" demo scenario for development and screenshots (`?demo=team`): 6 people on 2-3 checkouts each, 24 agents
 * of which 8 have ended, with tasks, locks, edges and activity to match. Deterministic; every time is relative to `now`.
 */
import type { ActivityView, AgentKind, AgentView, EdgeView, LockView, Pulse, Snapshot, TaskView } from '../../../shared/contracts';

type Mood = 'W' | 'I' | 'Q' | 'E';
type Spec = [kind: AgentKind, mood: Mood];

/** person -> checkouts (in first-seen order) -> agents. W working, I idle, Q quiet, E ended. */
const ROSTER: [string, Spec[][]][] = [
  ['nico', [[['claude', 'W'], ['claude', 'I']], [['codex', 'W'], ['claude', 'E']], [['codex', 'E']]]],
  ['ana', [[['codex', 'W'], ['claude', 'W'], ['codex', 'I']], [['claude', 'E'], ['claude', 'E']]]],
  ['sam', [[['claude', 'W'], ['claude', 'Q']], [['codex', 'I'], ['codex', 'E']]]],
  ['lena', [[['claude', 'W']], [['codex', 'W'], ['claude', 'I']], [['claude', 'E']]]],
  ['omar', [[['codex', 'Q'], ['claude', 'E']], [['claude', 'W']]]],
  ['priya', [[['claude', 'W'], ['claude', 'I']], [['codex', 'E']]]],
];

const BRANCHES = ['main', 'feat/login', 'fix/billing', 'feat/search', 'chore/deps', 'feat/export', 'fix/flaky-tests'];
const TITLES = [
  'Login page', 'Billing webhook retries', 'Search index', 'Export to CSV', 'Upgrade dependencies', 'Fix flaky tests',
  'Onboarding emails', 'Rate limiting', 'Dark mode', 'Audit log', 'Settings screen', 'Migrate user table',
];
const PATHS = [
  'src/auth/', 'src/billing/webhook.ts', 'src/search/index.ts', 'src/export/csv.ts', 'package.json', 'test/flaky/',
  'src/email/templates/', 'src/api/limits.ts', 'src/ui/theme.css', 'src/audit/log.ts', 'src/ui/settings.tsx', 'db/migrations/',
  'src/auth/session.ts', 'src/ui/nav.tsx', 'src/api/routes.ts', 'README.md',
];
const ACTIVITY = ['Edit', 'Bash npm test', 'Read', 'apply_patch', 'Grep'];

/** Messages the fake source plays, in a loop. Callsigns match the roster above. */
export const TEAM_SCRIPT: Omit<Pulse, 'at'>[] = [
  { type: 'pulse', kind: 'message', from: 'claude-nico', to: 'codex-ana' },
  { type: 'pulse', kind: 'push', from: 'claude-lena', path: 'src/ui/nav.tsx' },
  { type: 'pulse', kind: 'message', from: 'codex-lena', to: 'claude-priya' },
  { type: 'pulse', kind: 'broadcast', from: 'claude-sam' },
];
export const TEAM_SCRIPT_TEXT = [
  'claude-nico → codex-ana: Can you export the Session type?',
  'claude-lena pushed main (1 file)',
  'codex-lena → claude-priya: Dependency bump is merged.',
  'claude-sam → everyone: Staging deploy finished.',
];
export const TEAM_ACTIVITY_TYPE = ['message', 'push', 'message', 'message'];

export function bigTeamSnapshot(now: number): Snapshot {
  const agents: AgentView[] = [];
  const tasks: TaskView[] = [];
  const locks: LockView[] = [];
  const min = 60_000;
  let n = 0;
  let nextTask = 1;

  for (const [person, checkouts] of ROSTER) {
    const used = new Map<string, number>();
    checkouts.forEach((specs, ci) => {
      const checkout = `${person}-checkout-${ci + 1}`;
      const branch = BRANCHES[(n + ci) % BRANCHES.length]!;
      for (const [kind, mood] of specs) {
        const base = `${kind}-${person}`;
        const count = (used.get(base) ?? 0) + 1;
        used.set(base, count);
        const callsign = count === 1 ? base : `${base}-${count}`;
        const startedAt = now - (300 - n * 7 - ci * 40) * min;
        let lastEvent = now - (3 + (n % 5)) * 1000;
        let idleSince: number | null = null;
        let endedAt: number | null = null;
        if (mood === 'I') {
          lastEvent = now - (2 + (n % 6)) * min;
          idleSince = lastEvent;
        } else if (mood === 'Q') {
          lastEvent = now - (17 + n) * min;
        } else if (mood === 'E') {
          lastEvent = now - (50 + n * 9) * min;
          endedAt = lastEvent + 2 * min;
        }
        let taskId: number | null = null;
        if (mood === 'W' || (mood === 'I' && n % 2 === 0)) {
          taskId = nextTask++;
          tasks.push({
            id: taskId, title: TITLES[(taskId - 1) % TITLES.length]!, description: null, status: 'in_progress', owner: callsign,
            createdBy: callsign, dependsOn: [], areas: [], note: null, createdAt: now - 80 * min, updatedAt: now - 5 * min,
          });
        }
        if (mood !== 'E' || n % 3 === 0) {
          const paths = mood === 'W' ? 2 : 1;
          for (let k = 0; k < paths; k++) {
            const path = PATHS[(n * 2 + k) % PATHS.length]!;
            locks.push({
              repo: 'repo-demo', path, kind: path.endsWith('/') ? 'folder' : 'file', holder: callsign, checkout,
              taskId, reason: null, acquiredAt: now - (25 + n) * min,
            });
          }
        }
        agents.push({
          callsign, kind, person, repo: 'repo-demo', repoName: 'demo-app', checkout, branch, head: null, hooked: n !== 9,
          activity: mood === 'W' ? `${ACTIVITY[n % ACTIVITY.length]} ${PATHS[(n * 2) % PATHS.length]}` : null,
          startedAt, lastEvent, idleSince, endedAt, outageAt: null, outageMs: null, taskId,
        });
        n++;
      }
    });
  }

  const open = (title: string, dependsOn: number[]): void => {
    tasks.push({
      id: nextTask, title, description: null, status: 'open', owner: null, createdBy: 'claude-nico', dependsOn, areas: [], note: null,
      createdAt: now - 60 * min, updatedAt: now - 60 * min,
    });
    nextTask++;
  };
  open('Write release notes', [1]);
  open('Load test the API', [2, 3]);
  open('Update the docs', []);
  for (let i = 0; i < 3; i++) {
    tasks.push({
      id: nextTask, title: `Earlier cleanup ${i + 1}`, description: null, status: 'done', owner: agents[i * 5]!.callsign, createdBy: 'claude-nico',
      dependsOn: [], areas: [], note: null, createdAt: now - 200 * min, updatedAt: now - 120 * min,
    });
    nextTask++;
  }

  const edges: EdgeView[] = [
    { kind: 'message', from: 'claude-nico', to: 'codex-ana', at: now - 20_000 },
    { kind: 'message', from: 'codex-lena', to: 'claude-priya', at: now - 35_000 },
    { kind: 'waiting', from: 'claude-sam', to: 'claude-ana', at: now - 5 * min },
  ];
  const first = locks.find((l) => l.holder === 'codex-ana' && l.kind === 'file');
  if (first) edges.push({ kind: 'blocked', from: 'claude-omar-2', to: 'codex-ana', label: first.path.split('/').pop()!, at: now - 40_000 });

  const activity: ActivityView[] = [
    { seq: 3, ts: now - 20_000, type: 'message', actor: 'claude-nico', text: 'claude-nico → codex-ana: Can you export the Session type?' },
    { seq: 2, ts: now - 40_000, type: 'lock.denied', actor: 'claude-omar-2', text: 'claude-omar-2 was blocked from a file held by codex-ana' },
    { seq: 1, ts: now - 3 * min, type: 'push', actor: 'claude-lena', text: 'claude-lena pushed main (2 files)' },
  ];

  return { type: 'snapshot', room: 'demo', mode: 'enforce', now, usage: { requests: 41200, cap: 100000 }, agents, tasks, locks, edges, activity };
}
