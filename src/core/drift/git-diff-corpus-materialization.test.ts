import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeOpenSpecCorpus } from './git-diff.js';

const execFileAsync = promisify(execFile);
const GIT_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf899d15f71049056';

async function initRepo(directory: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: directory });
  await execFileAsync('git', ['config', 'commit.gpgSign', 'false'], { cwd: directory });
}

async function commitAll(directory: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: directory });
  await execFileAsync('git', ['commit', '-m', message], { cwd: directory });
}

async function gitOutput(directory: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: directory })).stdout;
}

interface RepositorySnapshot {
  head: string;
  status: string;
  index: Buffer;
}

async function snapshotRepository(directory: string): Promise<RepositorySnapshot> {
  const indexPath = (await gitOutput(directory, ['rev-parse', '--git-path', 'index'])).trim();
  return {
    head: await gitOutput(directory, ['rev-parse', 'HEAD']),
    status: await gitOutput(directory, ['status', '--porcelain=v1', '-uall']),
    index: await readFile(resolve(directory, indexPath)),
  };
}

function entries(materialized: Awaited<ReturnType<typeof materializeOpenSpecCorpus>>): Array<[string, string]> {
  return [...materialized.files.entries()];
}

describe('materializeOpenSpecCorpus', () => {
  let repository: string;

  beforeEach(async () => {
    repository = await realpath(await mkdtemp(join(tmpdir(), 'openlore-corpus-materialize-')));
    await initRepo(repository);
    await mkdir(join(repository, 'openspec', 'specs', 'zeta'), { recursive: true });
    await mkdir(join(repository, 'openspec', 'specs', 'alpha'), { recursive: true });
    await writeFile(join(repository, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    await writeFile(join(repository, 'openspec', 'specs', 'zeta', 'spec.md'), '# Zeta v1\n', 'utf8');
    await writeFile(join(repository, 'openspec', 'specs', 'alpha', 'spec.md'), '# Alpha v1\n', 'utf8');
    await writeFile(join(repository, 'unrelated.txt'), 'not corpus\n', 'utf8');
    await commitAll(repository, 'initial corpus');
  });

  afterEach(async () => {
    await rm(repository, { recursive: true, force: true });
  });

  it('reads committed blobs from a disclosed revision without touching a dirty worktree, index, or HEAD', async () => {
    await writeFile(join(repository, 'openspec', 'specs', 'alpha', 'spec.md'), '# Alpha dirty\n', 'utf8');
    await writeFile(join(repository, 'openspec', 'specs', 'working-only.md'), '# Working only\n', 'utf8');
    await execFileAsync('git', ['add', 'openspec/specs/alpha/spec.md'], { cwd: repository });
    const before = await snapshotRepository(repository);

    const materialized = await materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: 'HEAD' },
    });
    const after = await snapshotRepository(repository);

    expect(materialized.source).toEqual({
      kind: 'revision',
      requested: 'HEAD',
      resolved: before.head.trim(),
    });
    expect(materialized.paths).toEqual([
      'openspec/config.yaml',
      'openspec/specs/alpha/spec.md',
      'openspec/specs/zeta/spec.md',
    ]);
    expect(materialized.files.get('openspec/specs/alpha/spec.md')).toBe('# Alpha v1\n');
    expect(materialized.files.has('openspec/specs/working-only.md')).toBe(false);
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
    expect(after.index.equals(before.index)).toBe(true);
  });

  it('reads selected files from a directory through a confined, deterministic path set', async () => {
    await writeFile(join(repository, 'openspec', 'specs', 'alpha', 'spec.md'), '# Alpha working tree\n', 'utf8');

    const materialized = await materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'directory', directory: repository },
      paths: [
        'openspec/specs/zeta/spec.md',
        'openspec/specs/alpha/spec.md',
        'openspec/specs/zeta/spec.md',
      ],
    });

    expect(materialized.source).toEqual({
      kind: 'directory',
      requested: repository,
      resolved: repository,
    });
    expect(materialized.paths).toEqual([
      'openspec/specs/alpha/spec.md',
      'openspec/specs/zeta/spec.md',
    ]);
    expect(entries(materialized)).toEqual([
      ['openspec/specs/alpha/spec.md', '# Alpha working tree\n'],
      ['openspec/specs/zeta/spec.md', '# Zeta v1\n'],
    ]);
  });

  it('returns byte-identical path and map order across repeated and concurrent revision reads', async () => {
    const request = {
      rootPath: repository,
      source: { kind: 'revision' as const, revision: 'HEAD' },
    };
    const sequential = await materializeOpenSpecCorpus(request);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => materializeOpenSpecCorpus(request)));

    for (const result of concurrent) {
      expect(result).toEqual(sequential);
      expect(entries(result)).toEqual(entries(sequential));
    }
  });

  it('rejects unresolved or argument-shaped revisions instead of substituting a ref', async () => {
    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: 'missing-corpus-ref' },
    })).rejects.toThrow('does not resolve to a commit');

    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: '--upload-pack=evil' },
    })).rejects.toThrow('must not begin with');
  });

  it('materializes the canonical empty-tree base of a single-commit repository as an empty corpus', async () => {
    const materialized = await materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: GIT_EMPTY_TREE_SHA },
    });

    expect(materialized.source).toEqual({
      kind: 'revision',
      requested: GIT_EMPTY_TREE_SHA,
      resolved: GIT_EMPTY_TREE_SHA,
    });
    expect(materialized.paths).toEqual([]);
    expect(entries(materialized)).toEqual([]);

    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: GIT_EMPTY_TREE_SHA },
      paths: ['../../etc/passwd'],
    })).rejects.toThrow('Invalid OpenSpec corpus path');
  });

  it('rejects selected path traversal and git pathspec magic', async () => {
    for (const filePath of ['../openspec/spec.md', 'openspec/../outside.md', ':(glob)openspec/**']) {
      await expect(materializeOpenSpecCorpus({
        rootPath: repository,
        source: { kind: 'directory', directory: repository },
        paths: [filePath],
      })).rejects.toThrow('Invalid OpenSpec corpus path');
    }
  });

  it('fails closed when a directory corpus path is a symlink escape', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'openlore-corpus-outside-')));
    try {
      await writeFile(join(outside, 'stolen.md'), '# Outside\n', 'utf8');
      await symlink(join(outside, 'stolen.md'), join(repository, 'openspec', 'specs', 'escape.md'));

      await expect(materializeOpenSpecCorpus({
        rootPath: repository,
        source: { kind: 'directory', directory: repository },
        paths: ['openspec/specs/escape.md'],
      })).rejects.toThrow(/outside the project directory|Path escape blocked/);

      await expect(materializeOpenSpecCorpus({
        rootPath: repository,
        source: { kind: 'directory', directory: repository },
      })).rejects.toThrow(/outside the project directory|Path escape blocked/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects internal parent symlinks and non-regular files before opening them', async () => {
    const alternate = join(repository, 'alternate');
    await mkdir(join(alternate, 'specs', 'demo'), { recursive: true });
    await writeFile(join(alternate, 'specs', 'demo', 'spec.md'), '# Alias\n');
    await rm(join(repository, 'openspec'), { recursive: true });
    await symlink('alternate', join(repository, 'openspec'));

    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'directory', directory: repository },
    })).rejects.toThrow(/real directory|symbolic-link/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking on its open', async () => {
    const fifo = join(repository, 'openspec', 'specs', 'pipe.md');
    await execFileAsync('mkfifo', [fifo]);

    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'directory', directory: repository },
      paths: ['openspec/specs/pipe.md'],
    })).rejects.toThrow('not a regular file');
  });

  it('normalizes a configured corpus root into canonical openspec keys', async () => {
    await mkdir(join(repository, 'docs', 'specs-root', 'specs', 'demo'), { recursive: true });
    await writeFile(join(repository, 'docs', 'specs-root', 'specs', 'demo', 'spec.md'), '# Custom\n');

    const materialized = await materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'directory', directory: repository },
      corpusRoot: './docs/specs-root',
    });

    expect(entries(materialized)).toEqual([
      ['openspec/specs/demo/spec.md', '# Custom\n'],
    ]);

    await commitAll(repository, 'custom corpus root');
    const revision = await materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: 'HEAD' },
      corpusRoot: 'docs/specs-root//',
    });
    expect(entries(revision)).toEqual(entries(materialized));
  });

  it('bounds a root-level corpus to OpenSpec-owned subtrees', async () => {
    await mkdir(join(repository, 'specs', 'demo'), { recursive: true });
    await writeFile(join(repository, 'specs', 'demo', 'spec.md'), '# Root corpus\n');
    await writeFile(join(repository, 'source.ts'), 'export const ignored = true;\n');

    const materialized = await materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'directory', directory: repository },
      corpusRoot: '.',
    });
    expect(entries(materialized)).toContainEqual(['openspec/specs/demo/spec.md', '# Root corpus\n']);
    expect(materialized.paths).not.toContain('openspec/source.ts');
  });

  it('rejects a committed symlink instead of reading its target text as corpus content', async () => {
    await symlink('alpha/spec.md', join(repository, 'openspec', 'specs', 'linked.md'));
    await commitAll(repository, 'symlink corpus fixture');

    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: 'HEAD' },
    })).rejects.toThrow('not a regular committed file');
  });

  it('bounds revision blob reads before loading hostile corpus content', async () => {
    await writeFile(
      join(repository, 'openspec', 'specs', 'oversized.md'),
      Buffer.alloc(4 * 1024 * 1024 + 1, 0x61),
    );
    await commitAll(repository, 'oversized corpus fixture');

    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: 'HEAD' },
      paths: ['openspec/specs/oversized.md'],
    })).rejects.toThrow('exceeds corpus file limit');
  });

  it('rejects invalid UTF-8 corpus bytes instead of replacement-decoding them', async () => {
    const path = join(repository, 'openspec', 'specs', 'invalid.md');
    await writeFile(path, Buffer.from([0xff]));
    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'directory', directory: repository },
      paths: ['openspec/specs/invalid.md'],
    })).rejects.toThrow();

    await commitAll(repository, 'invalid utf8 corpus fixture');
    await expect(materializeOpenSpecCorpus({
      rootPath: repository,
      source: { kind: 'revision', revision: 'HEAD' },
      paths: ['openspec/specs/invalid.md'],
    })).rejects.toThrow();
  });
});
