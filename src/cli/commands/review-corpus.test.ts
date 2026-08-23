import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runReviewCorpusCli } from './review-corpus.js';

const execFileAsync = promisify(execFile);
const created: string[] = [];

afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

const baseSpec = `# Demo Specification

## Requirements

### Requirement: RejectInvalidTokens

The system SHALL reject invalid tokens within 200 ms.

#### Scenario: Invalid token

- **GIVEN** an invalid token
- **WHEN** authentication runs
- **THEN** the request is rejected
`;

const weakenedSpec = baseSpec.replace('SHALL', 'SHOULD');

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-review-corpus-'));
  created.push(root);
  await mkdir(join(root, 'openspec', 'specs', 'demo'), { recursive: true });
  await writeFile(join(root, 'openspec', 'specs', 'demo', 'spec.md'), baseSpec);
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['add', 'openspec'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base corpus',
  ], { cwd: root });
  return root;
}

async function writeBlockingPolicy(root: string): Promise<void> {
  await mkdir(join(root, '.openlore'), { recursive: true });
  await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
    version: '1.0.0',
    projectType: 'nodejs',
    openspecPath: 'openspec',
    analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
    generation: { domains: 'auto' },
    createdAt: '2026-01-01T00:00:00Z',
    lastRun: null,
    enforcement: { policy: { 'corpus-normative-weakened': 'blocking' } },
  }, null, 2));
}

async function captureRun(
  options: Parameters<typeof runReviewCorpusCli>[0],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return {
      code: await runReviewCorpusCli(options),
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe('review-corpus CLI', () => {
  it('emits pipeable deterministic JSON and keeps advisory findings successful', async () => {
    const root = await makeRepo();
    await writeFile(join(root, 'openspec', 'specs', 'demo', 'spec.md'), weakenedSpec);

    const first = await captureRun({ cwd: root, json: true });
    const second = await captureRun({ cwd: root, json: true });

    expect(first).toEqual(second);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    const payload = JSON.parse(first.stdout) as {
      schemaVersion: number;
      verdict: string;
      findings: Array<{
        code: string;
        artifact: string;
        requirement?: string;
        baseValue?: string;
        headValue?: string;
        enforcementClass: string;
      }>;
      base: { requested: string; resolved: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.verdict).toBe('review-recommended');
    expect(payload.base).toMatchObject({ requested: 'auto' });
    expect(payload.base.resolved).toMatch(/^[0-9a-f]{40,64}$/i);
    expect(payload.findings).toContainEqual(expect.objectContaining({
      code: 'corpus-normative-weakened',
      artifact: 'openspec/specs/demo/spec.md',
      requirement: 'RejectInvalidTokens',
      baseValue: 'SHALL',
      headValue: 'SHOULD',
      enforcementClass: 'advisory',
    }));
  });

  it('does not let an auto directory hijack default Git base resolution', async () => {
    const root = await makeRepo();
    await mkdir(join(root, 'auto', 'openspec', 'specs', 'demo'), { recursive: true });
    await writeFile(join(root, 'auto', 'openspec', 'specs', 'demo', 'spec.md'), weakenedSpec);
    await writeFile(join(root, 'openspec', 'specs', 'demo', 'spec.md'), weakenedSpec);

    const result = await captureRun({ cwd: root, json: true });
    const payload = JSON.parse(result.stdout) as { base: { kind: string }; verdict: string };
    expect(payload.base.kind).toBe('revision');
    expect(payload.verdict).toBe('review-recommended');
  });

  it('reviews the configured openspecPath and emits canonical artifact keys', async () => {
    const root = await makeRepo();
    await mkdir(join(root, 'docs', 'specs-root', 'specs', 'demo'), { recursive: true });
    await writeFile(join(root, 'docs', 'specs-root', 'specs', 'demo', 'spec.md'), baseSpec);
    await execFileAsync('git', ['add', 'docs/specs-root'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'custom corpus',
    ], { cwd: root });
    await writeFile(join(root, 'docs', 'specs-root', 'specs', 'demo', 'spec.md'), weakenedSpec);
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'nodejs', openspecPath: 'docs/specs-root',
      analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
      generation: { domains: 'auto' }, createdAt: '2026-01-01T00:00:00Z', lastRun: null,
    }));

    const result = await captureRun({ cwd: root, base: 'HEAD', json: true });
    const payload = JSON.parse(result.stdout) as { findings: Array<{ artifact: string; code: string }> };
    expect(payload.findings).toContainEqual(expect.objectContaining({
      artifact: 'openspec/specs/demo/spec.md',
      code: 'corpus-normative-weakened',
    }));
  });

  it('returns non-zero only when policy promotes a finding to blocking', async () => {
    const root = await makeRepo();
    await writeFile(join(root, 'openspec', 'specs', 'demo', 'spec.md'), weakenedSpec);
    await writeBlockingPolicy(root);

    const result = await captureRun({ cwd: root });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Corpus intent review: review-recommended');
    expect(result.stdout).toContain('[blocking] corpus-normative-weakened');
    expect(result.stderr).toBe('');
  });

  it('discloses an unresolvable explicit base without substituting another ref', async () => {
    const root = await makeRepo();

    const result = await captureRun({ cwd: root, base: 'not-a-real-base', json: true });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Base ref "not-a-real-base" did not resolve.*refusing to substitute/i);
  });

  it('accepts directories for both sides without requiring Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-review-corpus-dirs-'));
    created.push(root);
    const base = join(root, 'base');
    const head = join(root, 'head');
    await mkdir(join(base, 'openspec', 'specs', 'demo'), { recursive: true });
    await mkdir(join(head, 'openspec', 'specs', 'demo'), { recursive: true });
    await writeFile(join(base, 'openspec', 'specs', 'demo', 'spec.md'), baseSpec);
    await writeFile(join(head, 'openspec', 'specs', 'demo', 'spec.md'), weakenedSpec);

    const result = await captureRun({ cwd: root, base, head, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { base: { kind: string }; head: { kind: string }; verdict: string };
    expect(payload).toMatchObject({
      base: { kind: 'directory' },
      head: { kind: 'directory' },
      verdict: 'review-recommended',
    });
  });

  it('accepts explicit directory paths with spaces and neutralizes terminal controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore review corpus dirs '));
    created.push(root);
    const base = join(root, 'base state');
    const head = join(root, 'head state');
    const unsafeName = 'Unsafe\u001b]8;;https://attacker.example\u0007click';
    await mkdir(join(base, 'openspec', 'specs', 'demo'), { recursive: true });
    await mkdir(join(head, 'openspec', 'specs', 'demo'), { recursive: true });
    await writeFile(join(base, 'openspec', 'specs', 'demo', 'spec.md'), baseSpec.replace('RejectInvalidTokens', unsafeName));
    await writeFile(join(head, 'openspec', 'specs', 'demo', 'spec.md'), weakenedSpec.replace('RejectInvalidTokens', unsafeName));

    const result = await captureRun({ cwd: root, base: 'base state', head: 'head state' });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout).not.toContain('\u0007');
    expect(result.stdout).toContain('corpus-normative-weakened');
  });

  it('uses an empty policy when uninitialized but fails honestly on malformed config', async () => {
    const root = await makeRepo();
    await writeFile(join(root, 'openspec', 'specs', 'demo', 'spec.md'), weakenedSpec);

    const uninitialized = await captureRun({ cwd: root, json: true });
    expect(uninitialized.code).toBe(0);
    expect(uninitialized.stderr).toBe('');

    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), '{ malformed');
    const malformed = await captureRun({ cwd: root, json: true });
    expect(malformed.code).toBe(2);
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toMatch(/Invalid JSON.*config\.json/i);
  });
});
