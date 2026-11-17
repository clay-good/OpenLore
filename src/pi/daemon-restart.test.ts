import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDaemonResult, isUsableDaemon, NAV_TOOLS, restartPiDaemon } from './extension.js';

// A real detached HTTP process with the 3.4-compatible health/shutdown contract.
// No analyzer or global CLI is needed, and /shutdown cannot exit the test worker.
const fixture = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const [root, toolsJson, wrongRoot, version] = process.argv.slice(1);
const tools = JSON.parse(toolsJson);
const descriptorPath = path.join(root, '.openlore', 'serve.json');
const token = 'fixture-private-token';
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-openlore-token'] !== token) {
    res.writeHead(401); res.end('{}'); return;
  }
  if (req.url === '/shutdown' && req.method === 'POST') {
    fs.unlinkSync(descriptorPath);
    res.writeHead(202); res.end(JSON.stringify({ ok: true }));
    server.close(() => process.exit(0)); return;
  }
  res.end(JSON.stringify({ ok: true, protocolVersion: 1, presetDispatchEnforced: true,
    root: wrongRoot || root, pid: process.pid, preset: 'full', tools,
    tokenProtected: true, tokenAuthenticated: true, draining: false,
    ...(version ? { version } : {}) }));
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(descriptorPath, JSON.stringify({ port: server.address().port,
    pid: process.pid, host: '127.0.0.1', token, protocolVersion: 1,
    startedAt: new Date().toISOString(), version: 'fixture' }));
});
`;

describe('Pi daemon upgrade recovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-pi-restart-'));
    vi.stubEnv('OPENLORE_GLOBAL_CONFIG', join(root, 'user.json'));
    vi.stubEnv('OPENLORE_PI_NO_SPAWN', '0');
  });
  afterEach(async () => {
    // Terminate only our fixture child, including when the test deliberately
    // poisons the identity proof. Never signal a PID read from a repository.
    try {
      const desc = JSON.parse(await readFile(join(root, '.openlore', 'serve.json'), 'utf8'));
      await fetch(`http://127.0.0.1:${desc.port}/shutdown`, {
        method: 'POST', headers: { 'x-openlore-token': 'fixture-private-token' },
        signal: AbortSignal.timeout(2000),
      });
    } catch { /* already stopped */ }
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const tools = NAV_TOOLS.map((tool) => tool.name);
  const launch = (root: string, available = tools, wrongRoot = '', version = '') => ({
    command: process.execPath, args: ['-e', fixture, root, JSON.stringify(available), wrongRoot, version],
  });
  const stop = (root: string) => ({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('../cli/index.ts', import.meta.url)),
      'serve', '--directory', root, '--stop'],
  });

  it('replaces a surviving 3.4 tool surface with the new extension surface on explicit restart', async () => {
    const addedIn35 = ['verify_change', 'certify_provenance', 'certify_merge', 'fleet_status'];
    const old = await ensureDaemonResult(root, {
      launch: launch(root, tools.filter((tool) => !addedIn35.includes(tool))), timeoutMs: 5000,
    });
    expect(old.daemon?.incompatibility).toContain('4 Pi tool(s)');
    const path = join(root, '.openlore', 'serve.json');
    const before = JSON.parse(await readFile(path, 'utf8'));
    const result = await restartPiDaemon(root, { stop: stop(root), launch: launch(root), timeoutMs: 5000 });
    expect(result.daemon).not.toBeNull();
    expect(isUsableDaemon(result.daemon!)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).pid).not.toBe(before.pid);
  });

  it('keeps a tool-complete older daemon usable while marking it for replacement', async () => {
    const result = await ensureDaemonResult(root, { launch: launch(root, tools, '', '0.0.1'), timeoutMs: 5000 });
    expect(result.daemon).toMatchObject({ autoRecoverable: true, restartPreset: 'full' });
    expect(isUsableDaemon(result.daemon!)).toBe(true);
  });

  it('names the older version when it also lacks Pi tools', async () => {
    const result = await ensureDaemonResult(root, {
      launch: launch(root, tools.slice(1), '', '0.0.1'), timeoutMs: 5000,
    });
    expect(result.daemon).toMatchObject({ autoRecoverable: true });
    expect(result.daemon?.incompatibility).toContain('version 0.0.1 is older');
  });

  it.each(['environment', 'config'])('does not stop or replace a supervised daemon (%s)', async (source) => {
    await ensureDaemonResult(root, { launch: launch(root), timeoutMs: 5000 });
    const path = join(root, '.openlore', 'serve.json');
    const before = await readFile(path, 'utf8');
    if (source === 'environment') vi.stubEnv('OPENLORE_PI_NO_SPAWN', '1');
    else await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({ pi: { spawnDaemon: false } }));
    const result = await restartPiDaemon(root, { stop: stop(root), launch: launch(root) });
    expect(result).toMatchObject({ daemon: null, failureKind: 'spawn-disabled' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('refuses to stop a daemon whose health belongs to another repository', async () => {
    await ensureDaemonResult(root, { launch: launch(root, tools, join(root, 'other')), timeoutMs: 5000 });
    const path = join(root, '.openlore', 'serve.json');
    const before = await readFile(path, 'utf8');
    const result = await restartPiDaemon(root, { stop: stop(root), launch: launch(root) });
    expect(result).toMatchObject({ daemon: null, failureKind: 'stop' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('does not stop the daemon when its reported preset is unknown to this release', async () => {
    await ensureDaemonResult(root, { launch: launch(root), timeoutMs: 5000 });
    const path = join(root, '.openlore', 'serve.json');
    const before = await readFile(path, 'utf8');
    const result = await restartPiDaemon(root, { stop: stop(root), launch: launch(root), preset: 'removed-preset' });
    expect(result).toMatchObject({ daemon: null, failureKind: 'unknown-preset' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('does not stop a daemon that changed since it was found to be older', async () => {
    await ensureDaemonResult(root, { launch: launch(root, tools, '', '0.0.1'), timeoutMs: 5000 });
    const path = join(root, '.openlore', 'serve.json');
    const before = await readFile(path, 'utf8');
    const { pid } = JSON.parse(before) as { pid: number };
    // Same PID but a different version stands in for "another session already replaced it".
    const result = await restartPiDaemon(root, {
      stop: stop(root), launch: launch(root), expect: { pid, version: '0.0.0' },
    });
    expect(result.daemon).not.toBeNull();
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('stops and replaces the daemon when it is still the expected older one', async () => {
    await ensureDaemonResult(root, { launch: launch(root, tools, '', '0.0.1'), timeoutMs: 5000 });
    const path = join(root, '.openlore', 'serve.json');
    const { pid } = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
    const result = await restartPiDaemon(root, {
      stop: stop(root), launch: launch(root), timeoutMs: 5000, expect: { pid, version: '0.0.1' },
    });
    expect(result.daemon && isUsableDaemon(result.daemon)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).pid).not.toBe(pid);
  });

  it('does not launch a replacement when the stop process fails', async () => {
    const result = await restartPiDaemon(root, {
      stop: { command: process.execPath, args: ['-e', 'process.exit(7)'] },
      launch: launch(root),
    });
    expect(result).toMatchObject({ daemon: null, failureKind: 'stop' });
    await expect(readFile(join(root, '.openlore', 'serve.json'))).rejects.toThrow();
  });
});
