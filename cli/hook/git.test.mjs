// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GIT_ENV_OVERRIDES, identity, normalize, refs, repoNameOf, staleWarnings, state } from './git.mjs';

let base;
let repo;
let rootSha;

const git = (args, cwd = repo) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'hm-git-')));
  repo = join(base, 'proj');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'one']);
  rootSha = git(['rev-parse', 'HEAD']);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('git.mjs', () => {
  it('runs every Git call with GIT_OPTIONAL_LOCKS=0', () => {
    expect(GIT_ENV_OVERRIDES).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  });

  it('identity: root commit, toplevel, branch, head', async () => {
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const id = await identity(join(repo, 'sub'));
    expect(id).not.toBeNull();
    expect(id.repo).toBe(rootSha);
    expect(resolve(id.root)).toBe(resolve(repo));
    expect(id.branch).toBe('main');
    expect(id.head).toBe(rootSha.slice(0, 7));
    expect(id.repoName).toBeNull();
  });

  it('identity: repoName from origin, null outside a repo or before the first commit', async () => {
    git(['remote', 'add', 'origin', 'https://example.invalid/team/widgets.git']);
    expect((await identity(repo)).repoName).toBe('widgets');
    const bare = join(base, 'empty');
    mkdirSync(bare);
    git(['init', '-q'], bare);
    expect(await identity(bare)).toBeNull();
    expect(await identity(base)).toBeNull();
  });

  it('normalize: repo-relative POSIX, drops outside and .git/', () => {
    const root = repo;
    expect(normalize(root, repo, [join(repo, 'a.txt'), 'b.txt', join(repo, 'sub', 'deep', 'new.ts')]))
      .toEqual(['a.txt', 'b.txt', 'sub/deep/new.ts']);
    expect(normalize(root, join(repo, 'sub'), ['x.ts', '../a.txt'])).toEqual(['sub/x.ts', 'a.txt']);
    expect(normalize(root, repo, [join(base, 'elsewhere.txt'), '../x', join(repo, '.git', 'config'), '.git/HEAD', repo, ''])).toEqual([]);
    expect(normalize(root, repo, ['a.txt', './a.txt'])).toEqual(['a.txt']);
  });

  it('normalize: a cwd reached through a link (or a Windows 8.3 short name) still maps to the checkout, even for new files', () => {
    const link = join(base, 'link-to-proj');
    symlinkSync(repo, link, 'junction');
    expect(normalize(repo, link, ['brand-new/file.ts', join(link, 'other.ts')])).toEqual(['brand-new/file.ts', 'other.ts']);
  });

  it('normalize: drops .git at any depth and in any letter case', () => {
    expect(normalize(repo, repo, ['.GIT/config', 'sub/.Git/HEAD', 'vendor/pkg/.git/index', join(repo, 'x', '.gIt', 'y'), 'sub/.github/ci.yml']))
      .toEqual(['sub/.github/ci.yml']);
  });

  it('normalize: forward slashes in absolute paths', () => {
    const fwd = `${repo.split('\\').join('/')}/sub/f.ts`;
    expect(normalize(repo, repo, [fwd])).toEqual(['sub/f.ts']);
  });

  it.runIf(process.platform === 'win32')('normalize: mixed-case drive and path use the on-disk case', () => {
    const lowerDrive = repo[0].toLowerCase() + repo.slice(1);
    expect(normalize(repo, lowerDrive, [join(lowerDrive, 'a.txt')])).toEqual(['a.txt']);
    expect(normalize(repo, repo, [join(repo.toUpperCase(), 'A.TXT')])).toEqual(['a.txt']);
    expect(normalize(repo.toUpperCase(), repo.toLowerCase(), ['sub/new.ts'])).toEqual(['sub/new.ts']);
    expect(normalize(repo, repo, [join(repo, '.GIT', 'config')])).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('normalize: extended-length \\\\?\\ paths', () => {
    expect(normalize(repo, repo, [`\\\\?\\${join(repo, 'a.txt')}`, `\\\\?\\${join(repo, 'sub', 'n.ts')}`])).toEqual(['a.txt', 'sub/n.ts']);
    expect(normalize(`\\\\?\\${repo}`, repo, ['a.txt'])).toEqual(['a.txt']);
  });

  it('refs: branch and head only', async () => {
    const r = await refs(repo);
    expect(r.branch).toBe('main');
    expect(r.head).toBe(rootSha.slice(0, 7));
  });

  it('state: divergent files from git status; baseline only without previous', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    mkdirSync(join(repo, 'dir'), { recursive: true });
    writeFileSync(join(repo, 'dir', 'x.txt'), 'x\n');
    renameSync(join(repo, 'b.txt'), join(repo, 'c.txt'));
    git(['add', 'b.txt', 'c.txt']);

    const first = await state(repo, null);
    expect([...first.report.divergent].sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'dir/x.txt', 'new.txt']);
    expect(first.report.baseline).toEqual(first.report.divergent);
    expect(first.report.pushed).toBeNull();
    expect(first.report.truncated).toBe(true); // no remote: committed work can't be told from pushed work
    expect(first.memory.divergent).toEqual(first.report.divergent);

    const next = await state(repo, first.memory);
    expect(next.report.baseline).toBeUndefined();
    expect(next.report.divergent).toEqual(first.report.divergent);
  });

  it('staleWarnings: nothing to say for no pushes, and never throws outside a repository', async () => {
    expect(await staleWarnings(repo, 'main', [])).toEqual([]);
    const lonely = join(base, 'not-a-repo');
    mkdirSync(lonely);
    const push = { path: 'a.txt', sha: 'abcdef1234', blob: 'b'.repeat(40), by: 'codex-ana', branch: 'main', at: Date.now() };
    expect(await staleWarnings(lonely, 'main', [push], { budgetMs: 60_000 })).toEqual([`codex-ana pushed changes to a.txt 0s ago. Fetch and pull first.`]);
  });

  describe('staleWarnings time budget', () => {
    const push = { path: 'a.txt', sha: 'abcdef1234', blob: 'b'.repeat(40), by: 'codex-ana', branch: 'main', at: Date.now() };
    const WARNING = expect.stringMatching(/^codex-ana pushed changes to a\.txt \d+s ago\. Fetch and pull first\.$/);
    // Every Git command takes 1.2 s, longer than the 0.9 s production limit; `merge-base` and `cat-file` (is the commit known?) fail.
    // Each call gets its own record: commands left running by an earlier test must not leak into it.
    const slowExecOf = (timeouts) => (args, cwd, timeout) => { timeouts.push(timeout); return new Promise((res, rej) => setTimeout(() => (['cat-file', 'merge-base'].includes(args[0]) ? rej(new Error('unknown commit')) : res('')), 1_200)); };
    const slowExec = slowExecOf([]);
    const saved = process.env.HIVEMIND_GIT_BUDGET_MS;
    afterEach(() => { if (saved === undefined) delete process.env.HIVEMIND_GIT_BUDGET_MS; else process.env.HIVEMIND_GIT_BUDGET_MS = saved; });

    it('by default a slow Git is cut off after about 0.9 s and the warning is dropped', async () => {
      delete process.env.HIVEMIND_GIT_BUDGET_MS;
      expect(await staleWarnings(repo, 'main', [push], { exec: slowExec })).toEqual([]);
    });
    it('the budgetMs option lets slow Git finish, and sets the per-command limit to max(600, budget)', async () => {
      let timeouts = [];
      expect(await staleWarnings(repo, 'main', [push], { exec: slowExecOf(timeouts), budgetMs: 10_000 })).toEqual([WARNING]);
      expect(timeouts.length).toBeGreaterThan(0);
      for (const x of timeouts) expect(x).toBe(10_000);
      timeouts = [];
      delete process.env.HIVEMIND_GIT_BUDGET_MS;
      await staleWarnings(repo, 'main', [push], { exec: slowExecOf(timeouts) });
      for (const x of timeouts) expect(x).toBe(600);
    });
    it.each(['-5', 'abc', '1.5', 'Infinity', '0', '99999999999', ''])('an invalid HIVEMIND_GIT_BUDGET_MS (%j) is ignored', async (v) => {
      process.env.HIVEMIND_GIT_BUDGET_MS = v;
      const timeouts = [];
      expect(await staleWarnings(repo, 'main', [push], { exec: slowExecOf(timeouts) })).toEqual([]);
      expect(timeouts.length).toBeGreaterThan(0);
      for (const x of timeouts) expect(x).toBe(600);
    });
    it('an invalid budgetMs option is ignored too', async () => {
      delete process.env.HIVEMIND_GIT_BUDGET_MS;
      expect(await staleWarnings(repo, 'main', [push], { exec: slowExec, budgetMs: -5 })).toEqual([]);
      expect(await staleWarnings(repo, 'main', [push], { exec: slowExec, budgetMs: Infinity })).toEqual([]);
    });
    it('HIVEMIND_GIT_BUDGET_MS does the same, and the option wins over it', async () => {
      process.env.HIVEMIND_GIT_BUDGET_MS = '10000';
      expect(await staleWarnings(repo, 'main', [push], { exec: slowExec })).toEqual([WARNING]);
      expect(await staleWarnings(repo, 'main', [push], { exec: slowExec, budgetMs: 100 })).toEqual([]);
    });
  });
});

describe('repoNameOf (issue #21)', () => {
  it('names remote URLs and local paths by their last segment, without .git', () => {
    const cases = {
      'https://example.invalid/team/widgets.git': 'widgets',
      'https://example.invalid/team/widgets/': 'widgets',
      'git@example.invalid:team/widgets.git': 'widgets',
      'git@example.invalid:widgets.git': 'widgets',
      'ssh://git@example.invalid:2222/team/widgets.git': 'widgets',
      [String.raw`C:\some\folder\origin.git`]: 'origin',
      [`${String.raw`C:\some\folder\origin`}\\`]: 'origin',
      'c:/some/folder/origin.git': 'origin',
      [String.raw`\\server\share\repos\origin.git`]: 'origin',
      '/srv/git/origin.git': 'origin',
      'file:///C:/some/folder/origin.git': 'origin',
      'file:///srv/git/origin': 'origin',
    };
    for (const [url, name] of Object.entries(cases)) expect(repoNameOf(url), url).toBe(name);
    expect(repoNameOf(null)).toBeNull();
    expect(repoNameOf('')).toBeNull();
    expect(repoNameOf('/')).toBeNull();
    expect(repoNameOf('/srv/repo/.git')).toBe('repo');
    expect(repoNameOf('/srv/repo/.GIT/')).toBe('repo');
    expect(repoNameOf(String.raw`C:\work\repo\.git`)).toBe('repo');
    expect(repoNameOf('/srv/Repo.GIT')).toBe('Repo');
    expect(repoNameOf('ssh://example.invalid:2222/')).toBeNull();
    expect(repoNameOf('ssh://example.invalid:2222')).toBeNull();
  });
});
