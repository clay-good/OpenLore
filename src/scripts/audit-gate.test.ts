import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function runGate(report: unknown): Promise<{ code: number; output: string }> {
  const bin = await mkdtemp(join(tmpdir(), 'openlore-audit-gate-'));
  created.push(bin);
  await writeFile(
    join(bin, 'npm'),
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(report)}'\n`,
    { mode: 0o755 },
  );
  try {
    const result = await execFileAsync(process.execPath, ['scripts/audit-gate.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: (failure.stdout ?? '') + (failure.stderr ?? '') };
  }
}

afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('audit-gate malformed report handling', () => {
  it('accepts a complete clean npm audit report', async () => {
    const result = await runGate({
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('audit-gate: OK');
  });

  it('fails closed when a high advisory has no stable identifier', async () => {
    const result = await runGate({
      vulnerabilities: {
        unsafe: { severity: 'high', via: [{ severity: 'high', title: 'unsafe', url: '' }] },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('has no stable URL-derived id');
  });

  it('fails closed when metadata and the vulnerability map disagree', async () => {
    const result = await runGate({
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('metadata reports 1 high/critical vulnerabilities');
  });
});
