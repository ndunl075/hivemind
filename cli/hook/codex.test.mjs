// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { format, parse, patchPaths } from './codex.mjs';

const FIXTURES = new URL('../../shared/fixtures/hooks/codex/', import.meta.url);
const dir = (rel = '') => new URL(rel, FIXTURES);
const read = (rel) => JSON.parse(readFileSync(new URL(rel, FIXTURES), 'utf8'));
const HOOK = new URL('./hook.mjs', import.meta.url);
const FAKE_AGENT_CRED = ['hm_a', 'test', 'nobody', '1', 'AAAA'].join('.');

const PATCH_FIXTURE_PATHS = ['C:\\proj\\p.txt', 'C:\\proj\\a.txt', 'C:\\proj\\c.txt', 'C:\\proj\\b.txt', 'C:\\proj\\b2.txt'];

describe('codex parse: every recorded input fixture', () => {
  const inputs = readdirSync(dir()).filter((f) => f.endsWith('.json'));
  it('finds the fixtures', () => expect(inputs.length).toBeGreaterThan(15));

  for (const f of inputs) {
    it(f, () => {
      const raw = read(f);
      const p = parse(raw);
      expect(p.event).toBe(raw.hook_event_name);
      expect(p.session).toBe(raw.session_id);
      expect(p.tool).toBe(raw.tool_name ?? null);
      expect(p.editPaths).toEqual(raw.tool_name === 'apply_patch' ? PATCH_FIXTURE_PATHS : []);
      expect(p.isShell).toBe(raw.tool_name === 'Bash');
      expect(p.isHivemindTool).toBe(String(raw.tool_name).startsWith('mcp__hivemind__'));
      expect(p.me).toBe(p.isHivemindTool ? raw.tool_input.me : null);
      expect(p.stopActive).toBe(raw.stop_hook_active === true);
      expect(p.endReason).toBe(raw.reason ?? null);
      expect(p.source).toBe(raw.source ?? null);
    });
  }

  it('passes the SessionStart source through', () => {
    expect(parse(read('SessionStart.json')).source).toBe('startup');
    expect(parse(read('SessionStart.resume.json')).source).toBe('resume');
    for (const source of ['compact', 'clear']) {
      expect(parse({ ...read('SessionStart.json'), source }).source).toBe(source);
    }
  });

  it('subagent events keep the parent session id', () => {
    const raw = read('SubagentStart.json');
    expect(parse(raw).session).toBe(raw.session_id);
  });

  it('rejects payloads without a session', () => {
    expect(() => parse({ hook_event_name: 'Stop' })).toThrow();
    expect(() => parse(null)).toThrow();
    expect(() => parse([])).toThrow();
  });
});

describe('apply_patch paths', () => {
  it('reads Add, Update, Delete and Move targets, absolute or relative', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+x',
      '*** Update File: /abs/old.ts',
      '*** Move to: /abs/moved.ts',
      '@@',
      '-a',
      '+b',
      '*** Delete File: C:\\proj\\gone.txt',
      '*** End Patch',
    ].join('\n');
    expect(patchPaths(patch)).toEqual(['src/new.ts', '/abs/old.ts', '/abs/moved.ts', 'C:\\proj\\gone.txt']);
  });

  it('tolerates CRLF, repeated files, spaces in names and content lines that look like headers', () => {
    const patch = '*** Begin Patch\r\n*** Update File: dir with space/a.txt\r\n@@\r\n+*** Add File: not-a-header\r\n*** Update File: dir with space/a.txt\r\n*** End Patch\r\n';
    expect(patchPaths(patch)).toEqual(['dir with space/a.txt']);
  });

  it('accepts leading whitespace before every header kind (an indented patch)', () => {
    const patch = [
      '  *** Begin Patch',
      '  *** Add File: src/a.ts',
      '  +x',
      '\t*** Update File: src/b.ts',
      '    *** Move to: src/c.ts',
      '   *** Delete File: src/d.ts',
      '  *** End Patch',
    ].join('\n');
    expect(patchPaths(patch)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    // ...and through parse, with CRLF as well
    const p = parse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch.replace(/\n/g, '\r\n') } });
    expect(p.editPaths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    // Added content lines (start with +) are still never headers, however they are indented after the +.
    expect(patchPaths('*** Add File: x.txt\n+  *** Add File: not-a-header\n')).toEqual(['x.txt']);
  });

  it('finds nothing in an empty, missing or malformed patch', () => {
    expect(patchPaths('')).toEqual([]);
    expect(parse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {} }).editPaths).toEqual([]);
    expect(parse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 5 } }).editPaths).toEqual([]);
    expect(parse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }).editPaths).toEqual([]);
  });

  it('handles the Edit and Write aliases', () => {
    const p = parse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'rel/a.txt' } });
    expect(p.editPaths).toEqual(['rel/a.txt']);
  });
});

describe('codex format: exact output for every output fixture', () => {
  /** case name -> [event, outcome]; the output must equal the recorded stdout byte for byte. */
  const emitted = {
    'PostToolUse.additionalContext': ['PostToolUse', { decision: 'allow', reason: null, context: '<context>' }],
    'PreToolUse.additionalContext': ['PreToolUse', { decision: 'allow', reason: null, context: '<context>' }],
    'PreToolUse.deny': ['PreToolUse', { decision: 'deny', reason: '<reason>', context: null }],
    'PreToolUse.deny-with-context': ['PreToolUse', { decision: 'deny', reason: '<reason>', context: '<context>' }],
    'SessionStart.additionalContext': ['SessionStart', { decision: 'allow', reason: null, context: '<briefing>' }],
    'Stop.block': ['Stop', { decision: 'block', reason: '<direct-message>', context: null }],
    'UserPromptSubmit.additionalContext': ['UserPromptSubmit', { decision: 'allow', reason: null, context: '<unread-messages>' }],
  };
  /** Recorded to show what Codex tolerates or rejects; Hivemind never emits these shapes. */
  const notEmitted = [
    'PostToolUse.block-with-context', 'PostToolUse.unknown-inner-field',
    'PreToolUse.continue-false', 'PreToolUse.deny-legacy-block', 'PreToolUse.deny-with-systemMessage',
    'PreToolUse.deny-with-unknown-inner-field', 'PreToolUse.deny-with-unknown-top-field',
    'PreToolUse.exit1', 'PreToolUse.exit2', 'PreToolUse.exit2-without-propagation',
    'PreToolUse.invalid-json', 'PreToolUse.plain-text', 'PreToolUse.timeout',
  ];
  const cases = readdirSync(dir('output/')).map((f) => f.replace(/\.json$/, ''));

  it('covers every fixture (a new one must be classified)', () => {
    expect(cases.filter((c) => !(c in emitted) && !notEmitted.includes(c))).toEqual([]);
  });

  for (const [name, [event, outcome]] of Object.entries(emitted)) {
    it(name, () => {
      const fx = read(`output/${name}.json`);
      expect(fx.event).toBe(event);
      expect(fx.verdict).toBe('accepted');
      expect(format(event, outcome)).toBe(fx.stdout);
    });
  }

  it('never emits a rejected shape', () => {
    for (const name of notEmitted) {
      const fx = read(`output/${name}.json`);
      const outputs = [];
      for (const decision of ['allow', 'deny', 'block']) {
        for (const reason of [null, 'r']) {
          for (const context of [null, 'c']) {
            for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
              outputs.push(format(event, { decision, reason, context }));
            }
          }
        }
      }
      if (fx.verdict === 'rejected') expect(outputs.filter((o) => o !== null && o === fx.stdout)).toEqual([]);
    }
  });

  it('only ever uses whitelisted fields', () => {
    const TOP = ['hookSpecificOutput', 'decision', 'reason'];
    const INNER = ['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'additionalContext'];
    for (const decision of ['allow', 'deny', 'block']) {
      for (const reason of [null, '', 'r']) {
        for (const context of [null, '', 'c']) {
          for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
            const out = format(event, { decision, reason, context });
            if (out === null) continue;
            const j = JSON.parse(out);
            expect(Object.keys(j).every((k) => TOP.includes(k))).toBe(true);
            if (j.hookSpecificOutput) {
              expect(Object.keys(j.hookSpecificOutput).every((k) => INNER.includes(k))).toBe(true);
              expect(j.hookSpecificOutput.hookEventName).toBe(event);
            }
          }
        }
      }
    }
  });

  it('prints nothing when there is nothing to say', () => {
    expect(format('PreToolUse', { decision: 'allow', reason: null, context: null })).toBeNull();
    expect(format('PostToolUse', { decision: 'allow', reason: null, context: '' })).toBeNull();
    expect(format('Stop', { decision: 'allow', reason: null, context: 'x' })).toBeNull();
    expect(format('Stop', { decision: 'block', reason: null, context: null })).toBeNull();
    expect(format('SessionEnd', { decision: 'allow', reason: null, context: 'x' })).toBeNull();
  });

  it('gives a deny without a reason a default one', () => {
    const out = JSON.parse(format('PreToolUse', { decision: 'deny', reason: null, context: null }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Hivemind');
  });
});

// ---------------------------------------------------------------------------
// hook.mjs end to end with Codex fixtures
// ---------------------------------------------------------------------------

let base;
let repo;
let rootSha;
const cleanups = [];
let counter = 0;

const git = (args, cwd = repo) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'hm-codex-')));
  repo = join(base, 'proj');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'one']);
  rootSha = git(['rev-parse', 'HEAD']);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** Ephemeral port (not 8790): this file runs in parallel with the CLI tests that own 8790. */
async function fakeServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(data) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(requests.at(-1).body)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function laptop(url) {
  const dirPath = mkdtempSync(join(base, 'lap-'));
  const home = join(dirPath, 'home');
  const tmp = join(dirPath, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: url, room: 'r', person: 'nobody', token: FAKE_AGENT_CRED, repos: [rootSha] }));
  return { home, tmp, session: `codex-sess-${process.pid}-${++counter}` };
}

function run(t, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [decodeURIComponent(HOOK.pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'codex'], {
      env: { ...process.env, HIVEMIND_HOME: t.home, TEMP: t.tmp, TMP: t.tmp, TMPDIR: t.tmp },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** A recorded Codex payload, pointed at the test checkout. apply_patch paths become absolute paths inside it. */
function payload(name, t, over = {}) {
  const raw = read(`${name}.json`);
  raw.cwd = repo;
  raw.session_id = t.session;
  if (raw.tool_name === 'apply_patch') {
    raw.tool_input.command = raw.tool_input.command.replaceAll('C:\\proj\\', `${repo}${repo.includes('\\') ? '\\' : '/'}`);
  }
  return { ...raw, ...over };
}

const OK = { decision: 'allow', reason: null, context: null, callsign: 'codex-test', heartbeatMs: 15000, mode: 'enforce' };
const fixtureStdout = (name) => read(`output/${name}.json`).stdout;

describe('hook.mjs codex end to end', () => {
  it('SessionStart prints the exact Codex briefing output', async () => {
    const srv = await fakeServer(() => ({ ...OK, context: '<briefing>' }));
    const t = laptop(srv.url);
    const r = await run(t, payload('SessionStart', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(fixtureStdout('SessionStart.additionalContext'));
    expect(srv.requests[0].body).toMatchObject({ event: 'SessionStart', agent: 'codex', session: t.session });
  });

  it('keeps the baseline on resume (source is passed through)', async () => {
    const srv = await fakeServer(() => ({ ...OK, context: '<briefing>' }));
    const t = laptop(srv.url);
    writeFileSync(join(repo, 'dirty1.txt'), 'x');
    cleanups.push(() => rmSync(join(repo, 'dirty1.txt'), { force: true }));
    await run(t, payload('SessionStart', t));
    writeFileSync(join(repo, 'dirty2.txt'), 'x');
    cleanups.push(() => rmSync(join(repo, 'dirty2.txt'), { force: true }));
    await run(t, payload('SessionStart.resume', t));
    const [first, second] = srv.requests.map((r) => r.body);
    expect(first.git.baseline).toContain('dirty1.txt');
    expect(second.git.baseline).toBeUndefined();
  });

  it('apply_patch PreToolUse sends every patched path and a deny prints the exact Codex deny', async () => {
    const srv = await fakeServer(() => ({ ...OK, decision: 'deny', reason: '<reason>' }));
    const t = laptop(srv.url);
    await run(t, payload('SessionStart', t));
    const r = await run(t, payload('PreToolUse.apply_patch', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(fixtureStdout('PreToolUse.deny'));
    const req = srv.requests.at(-1).body;
    expect(req.event).toBe('PreToolUse');
    expect(req.paths.sort()).toEqual(['a.txt', 'b.txt', 'b2.txt', 'c.txt', 'p.txt']);
  });

  it('a deny with context and a Stop block match the recorded Codex output', async () => {
    const deny = await fakeServer(() => ({ ...OK, decision: 'deny', reason: '<reason>', context: '<context>' }));
    const t = laptop(deny.url);
    await run(t, payload('SessionStart', t));
    expect((await run(t, payload('PreToolUse.apply_patch', t))).stdout).toBe(fixtureStdout('PreToolUse.deny-with-context'));

    const stop = await fakeServer(() => ({ ...OK, decision: 'block', reason: '<direct-message>' }));
    const t2 = laptop(stop.url);
    await run(t2, payload('SessionStart', t2));
    expect((await run(t2, payload('Stop', t2))).stdout).toBe(fixtureStdout('Stop.block'));
  });

  it('every recorded Codex input fixture exits 0 without crashing', async () => {
    const srv = await fakeServer(() => OK);
    const t = laptop(srv.url);
    for (const f of readdirSync(FIXTURES).filter((n) => n.endsWith('.json'))) {
      const r = await run(t, payload(f.replace(/\.json$/, ''), t));
      expect(r.code, f).toBe(0);
      expect(r.stderr, f).toBe('');
    }
  }, 60000);
});
