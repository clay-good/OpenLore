/**
 * End-to-end proof for the four moat tools shipped in this arc — verify_change,
 * certify_provenance, certify_merge, fleet_status — against REAL git repositories.
 *
 * The per-tool unit suites drive each tool's pure core with hand-built inputs. This file
 * proves the whole path: a real `git init` repo, a real `openlore analyze` index, and each
 * tool invoked exactly as an agent reaches it — through `dispatchTool`. It is the test that
 * would fail if analyze stopped emitting the artifacts a tool reads, if the dispatch wiring
 * dropped an argument, or if a tool returned an error where it should return a verdict.
 *
 * Each `it` builds its own throwaway repo so working-tree edits and branch state never leak
 * between scenarios.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { dispatchTool } from '../tool-dispatch.js';
import { openloreInit } from '../../../api/init.js';
import { openloreAnalyze } from '../../../api/analyze.js';
import { recordVerification } from './fleet-coordination.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';

const repos: string[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map(r => rm(r, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

/** A fresh git repo with a committed baseline (lib.ts + app.ts) on `main`. */
async function newRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-moat-'));
  repos.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'OpenLore Test']);
  git(root, ['config', 'user.email', 'test@openlore.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  await write(root, 'src/lib.ts', 'export function parseConfig(raw: string): object {\n  return JSON.parse(raw);\n}\n');
  await write(root, 'src/app.ts', 'import { parseConfig } from "./lib";\nexport function start(): void {}\n');
  await write(root, '.gitignore', '.openlore/\nnode_modules/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'baseline', '--no-gpg-sign']);
  return root;
}

/** Run `openlore analyze` so the index artifacts the read-path tools need exist on disk. */
async function analyze(root: string): Promise<void> {
  await openloreInit({ rootPath: root });
  await openloreAnalyze({ rootPath: root, force: true });
}

const call = (name: string, root: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  dispatchTool(name, { directory: root, ...args }, root);

describe('certify_merge on a real repo', () => {
  it('flags the disjoint-footprint conflict two green branches hide', async () => {
    const root = await newRepo();
    // ours: start() now calls parseConfig (adds a call edge into it).
    git(root, ['checkout', '-q', '-b', 'ours']);
    await write(root, 'src/app.ts', 'import { parseConfig } from "./lib";\nexport function start(): void {\n  parseConfig("{}");\n}\n');
    git(root, ['commit', '-qam', 'ours: call parseConfig', '--no-gpg-sign']);
    // theirs: parseConfig is removed entirely (branched from main, disjoint files).
    git(root, ['checkout', '-q', 'main']);
    git(root, ['checkout', '-q', '-b', 'theirs']);
    await write(root, 'src/lib.ts', 'export function somethingElse(): void {}\n');
    git(root, ['commit', '-qam', 'theirs: remove parseConfig', '--no-gpg-sign']);

    const res = await call('certify_merge', root, { ours: 'ours', theirs: 'theirs' }) as {
      verdict: string;
      summary: { conflicts: number; incompatible: number };
      findings: Array<{ code: string; message: string }>;
    };

    expect(res.verdict).toBe('incompatible');
    expect(res.summary.incompatible).toBeGreaterThanOrEqual(1);
    expect(res.findings[0].code).toBe('merge-semantic-conflict');
    expect(res.findings[0].message).toMatch(/parseConfig/);
  });

  it('clears two genuinely disjoint branches as no-detected-conflict', async () => {
    const root = await newRepo();
    git(root, ['checkout', '-q', '-b', 'ours']);
    await write(root, 'src/app.ts', 'import { parseConfig } from "./lib";\nexport function start(): void {\n  parseConfig("{}");\n}\n');
    git(root, ['commit', '-qam', 'ours: call parseConfig', '--no-gpg-sign']);
    git(root, ['checkout', '-q', 'main']);
    git(root, ['checkout', '-q', '-b', 'theirs']);
    await write(root, 'src/helper.ts', 'export function helper(): number {\n  return 1;\n}\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qam', 'theirs: add unrelated helper', '--no-gpg-sign']);

    const res = await call('certify_merge', root, { ours: 'ours', theirs: 'theirs' }) as { verdict: string };
    expect(res.verdict).toBe('no-detected-conflict');
  });
});

describe('verify_change on a real repo', () => {
  it('returns a structured receipt for an uncommitted working-tree change', async () => {
    const root = await newRepo();
    await analyze(root);
    // Uncommitted edit: start() now calls parseConfig.
    await write(root, 'src/app.ts', 'import { parseConfig } from "./lib";\nexport function start(): void {\n  parseConfig("{}");\n}\n');

    const res = await call('verify_change', root, { baseRef: 'HEAD' }) as {
      tool?: string;
      error?: string;
      items: unknown[];
      summary: Record<string, unknown>;
      boundaries: string[];
    };

    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.items)).toBe(true);
    expect(res.summary).toBeTypeOf('object');
    expect(Array.isArray(res.boundaries)).toBe(true);
  });
});

describe('certify_provenance on a real repo', () => {
  it('is reproducible over the same change and sensitive to a different one', async () => {
    const root = await newRepo();
    await analyze(root);
    await write(root, 'src/app.ts', 'import { parseConfig } from "./lib";\nexport function start(): void {\n  parseConfig("{}");\n}\n');

    const first = await call('certify_provenance', root, { baseRef: 'HEAD' }) as { digest: string; error?: string };
    const second = await call('certify_provenance', root, { baseRef: 'HEAD' }) as { digest: string };
    expect(first.error).toBeUndefined();
    expect(first.digest).toBeTruthy();
    // Same working tree, same base → identical content-addressed digest.
    expect(second.digest).toBe(first.digest);

    // The digest certifies the SEMANTIC footprint (blast radius + structural delta), not the diff
    // text, so a change with a different footprint — here, a newly added exported function — must
    // produce a different digest. (A text edit with the same footprint reproducing the digest is
    // the correct, intended property, not a collision.)
    await write(root, 'src/app.ts', 'import { parseConfig } from "./lib";\nexport function start(): void {\n  parseConfig("{}");\n}\nexport function extra(): number {\n  return 2;\n}\n');
    const third = await call('certify_provenance', root, { baseRef: 'HEAD' }) as { digest: string };
    expect(third.digest).not.toBe(first.digest);
  });

  it('emits an in-toto statement whose subject digest is the predicate content address', async () => {
    const root = await newRepo();
    await analyze(root);
    await write(root, 'src/app.ts', 'import { parseConfig } from "./lib";\nexport function start(): void {\n  parseConfig("{}");\n}\n');

    const res = await call('certify_provenance', root, { baseRef: 'HEAD', format: 'in-toto' }) as {
      statement?: { subject: Array<{ digest: { sha256: string } }>; predicateType: string };
      digest?: string;
    };
    expect(res.statement).toBeDefined();
    expect(res.statement!.subject[0].digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('fleet_status on a real repo', () => {
  it('invalidates a recorded verdict once a proven symbol actually drifts', async () => {
    const root = await newRepo();
    await analyze(root);

    // Anchor a verdict to parseConfig, using the exact content hash the live graph reports,
    // so it starts genuinely fresh (not fresh by assumption).
    const ctx = AnchorContext.open(root);
    expect(ctx).not.toBeNull();
    const anchorNodes = ctx!.anchorNodesForFiles(['src/lib.ts']);
    const pc = anchorNodes.find(n => n.name === 'parseConfig');
    expect(pc, 'analyze should index parseConfig in src/lib.ts').toBeDefined();

    await recordVerification(root, {
      id: 'v1',
      verdict: 'blast-radius-clean',
      branch: 'feat/x',
      baseCommit: git(root, ['rev-parse', 'HEAD']).trim(),
      producedBy: 'blast_radius',
      anchors: [{
        nodeId: pc!.id,
        symbolName: pc!.name,
        filePath: pc!.filePath,
        contentHash: pc!.contentHash,
        ...(pc!.stableId ? { stableId: pc!.stableId } : {}),
      }],
    });

    const before = await call('fleet_status', root) as {
      verificationMemory: { records: Array<{ id: string; state: string }>; summary: Record<string, number> };
    };
    expect(before.verificationMemory.records.find(r => r.id === 'v1')?.state).toBe('still-valid');

    // Now actually change parseConfig's body and re-analyze: the recorded hash no longer matches.
    await write(root, 'src/lib.ts', 'export function parseConfig(raw: string): object {\n  const trimmed = raw.trim();\n  return JSON.parse(trimmed);\n}\n');
    await analyze(root);

    const after = await call('fleet_status', root) as {
      verificationMemory: { records: Array<{ id: string; state: string; reason: string }> };
    };
    const rec = after.verificationMemory.records.find(r => r.id === 'v1');
    expect(rec?.state).toBe('invalidated');
    expect(rec?.reason).toMatch(/changed/);
  });
});
