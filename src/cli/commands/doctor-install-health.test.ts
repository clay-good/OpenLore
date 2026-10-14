import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkInstallHealth } from './doctor.js';

// The PATH fixtures are POSIX executables named `openlore`.
describe.skipIf(process.platform === 'win32')('doctor: install health', () => {
  let root: string;
  const binDir = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openlore'), '#!/bin/sh\n');
    chmodSync(join(dir, 'openlore'), 0o755);
    return dir;
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-install-health-')));
    mkdirSync(join(root, 'home'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is ok with one install and no user-scope wiring', async () => {
    const result = await checkInstallHealth(join(root, 'home'), binDir('a'), 'linux');
    expect(result.status).toBe('ok');
  });

  it('warns, without a remediation, when two installs are on PATH', async () => {
    const a = binDir('a');
    const b = binDir('b');
    const result = await checkInstallHealth(join(root, 'home'), `${a}:${b}:${a}`, 'linux');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('2 openlore installs');
    expect(result.detail.indexOf(join(a, 'openlore'))).toBeLessThan(result.detail.indexOf(join(b, 'openlore')));
    expect(result.remediation).toBeUndefined();
  });

  it('offers the re-wire remediation when the user-scope launcher is gone', async () => {
    const gone = join(root, 'Cellar', 'node', '1.0.0', 'bin', 'node');
    writeFileSync(
      join(root, 'home', '.claude.json'),
      JSON.stringify({ mcpServers: { openlore: { command: gone, args: [join(root, 'gone.js'), 'mcp'] } } }),
    );
    const result = await checkInstallHealth(join(root, 'home'), binDir('a'), 'linux');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(gone);
    expect(result.remediation).toEqual({
      kind: 'rewire-mcp',
      label: 'openlore install --agent claude-code --force',
    });
  });
});
