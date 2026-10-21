// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_ENV_OVERRIDES, identity, normalize, staleWarnings, state } from './git.mjs';

let base;
let repo;
let rootSha;

const git = (args, cwd = repo) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hm-git-')));
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
    expect(GIT_ENV_OVERRIDES.GIT_OPTIONAL_LOCKS).toBe('0');
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
    expect(first.report.truncated).toBe(false);
    expect(first.memory.divergent).toEqual(first.report.divergent);

    const next = await state(repo, first.memory);
    expect(next.report.baseline).toBeUndefined();
    expect(next.report.divergent).toEqual(first.report.divergent);
  });

  it('staleWarnings is a no-op in the basic module', async () => {
    expect(await staleWarnings(repo, 'main', [])).toEqual([]);
  });
});
