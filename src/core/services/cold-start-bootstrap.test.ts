import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootstrapAnalysisInBackground,
  buildIndexInChildProcess,
  enableChildProcessBuilds,
  stopChildProcessBuilds,
  _terminateBuildChildForTesting,
  repairInBackground,
  repairStatusFor,
  registerRepairBuilder,
  registerRepairHost,
  requestRepairFromHost,
  _resetRepairServiceForTesting,
} from './cold-start-bootstrap.js';
import { OPENLORE_ANALYSIS_REL_PATH, OPENLORE_CONFIG_REL_PATH } from '../../constants.js';

const dirs: string[] = [];
function freshDir(withAnalysis = false): string {
  const d = mkdtempSync(join(tmpdir(), 'openlore-cold-'));
  dirs.push(d);
  if (withAnalysis) {
    mkdirSync(join(d, OPENLORE_ANALYSIS_REL_PATH), { recursive: true });
    writeFileSync(join(d, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'), '{}');
  }
  return d;
}

afterEach(() => {
  delete process.env.OPENLORE_NO_AUTO_ANALYZE;
  _resetRepairServiceForTesting();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bootstrapAnalysisInBackground', () => {
  it('runs the analyzer once when no index exists', async () => {
    const dir = freshDir(false);
    let calls = 0;
    const seen = new Set<string>();
    const p = bootstrapAnalysisInBackground(dir, { seen, analyze: async () => { calls++; }, log: () => {} });
    expect(p).not.toBeNull();
    await p;
    expect(calls).toBe(1);
  });

  it('does nothing when an index already exists', () => {
    const dir = freshDir(true);
    const seen = new Set<string>();
    const p = bootstrapAnalysisInBackground(dir, { seen, analyze: async () => { throw new Error('should not run'); }, log: () => {} });
    expect(p).toBeNull();
  });

  it('builds at most once per directory', async () => {
    const dir = freshDir(false);
    let calls = 0;
    const seen = new Set<string>();
    const opts = { seen, analyze: async () => { calls++; }, log: () => {} };
    await bootstrapAnalysisInBackground(dir, opts);
    const second = bootstrapAnalysisInBackground(dir, opts);
    expect(second).toBeNull();
    expect(calls).toBe(1);
  });

  it('is disabled by the opt-out env var', () => {
    process.env.OPENLORE_NO_AUTO_ANALYZE = '1';
    const dir = freshDir(false);
    expect(bootstrapAnalysisInBackground(dir, { seen: new Set(), analyze: async () => {}, log: () => {} })).toBeNull();
  });

  it('is fail-soft and clears its guard so a later call can retry', async () => {
    const dir = freshDir(false);
    const seen = new Set<string>();
    const logs: string[] = [];
    await bootstrapAnalysisInBackground(dir, {
      seen,
      analyze: async () => { throw new Error('boom'); },
      log: (m) => logs.push(m),
    });
    expect(seen.has(dir)).toBe(false); // guard cleared on failure
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });

  it('ignores an empty directory', () => {
    expect(bootstrapAnalysisInBackground('', { seen: new Set(), analyze: async () => {} })).toBeNull();
  });

  it('runs exactly the injected builder and nothing else (no hidden default)', async () => {
    const dir = freshDir(false);
    const ran: string[] = [];
    await bootstrapAnalysisInBackground(dir, {
      seen: new Set(),
      analyze: async (d) => { ran.push(d); },
      log: () => {},
    });
    // The directory is built once, by the caller's builder — there is no
    // module-internal fallback that could run a different (e.g. BM25-less) build.
    expect(ran).toEqual([dir]);
  });

  // Architectural invariant: this module must stay dependency-light and never
  // pick an index builder itself. A wrong-by-default builder hidden here (e.g.
  // one that skips the BM25 search corpus) silently half-warms orient. The
  // builder is REQUIRED and injected by the caller; guard that it never sneaks
  // an analyzer/install import back in.
  it('never imports the analyzer or install layer (builder is injected, not chosen)', () => {
    const src = readFileSync(fileURLToPath(new URL('./cold-start-bootstrap.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/api\/(analyze|init|run)/);
    expect(src).not.toMatch(/install\/index/);
  });
});

describe('buildIndexInChildProcess', () => {
  function spawnHarness(calls: Array<{ command: string; args: readonly string[]; options: unknown }>): typeof spawn {
    return ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess;
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as typeof spawn;
  }

  it('initializes and analyzes an unconfigured repository in child processes', async () => {
    const dir = freshDir(false);
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    await buildIndexInChildProcess(dir, {
      cliPath: '/openlore/dist/cli/index.js',
      spawnProcess: spawnHarness(calls),
    });

    expect(calls.map(call => call.args)).toEqual([
      ['/openlore/dist/cli/index.js', 'init'],
      ['/openlore/dist/cli/index.js', 'analyze', '--embedded'],
    ]);
    expect(calls.every(call => call.command === process.execPath)).toBe(true);
    expect(calls.every(call => (call.options as { detached: boolean }).detached)).toBe(true);
    expect(calls.every(call => (call.options as { stdio: string }).stdio === 'ignore')).toBe(true);
  });

  it('runs a repair analyze without blocking on in-process analyzer work', async () => {
    const dir = freshDir(true);
    mkdirSync(join(dir, '.openlore'), { recursive: true });
    writeFileSync(join(dir, OPENLORE_CONFIG_REL_PATH), '{}');
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];

    await buildIndexInChildProcess(dir, {
      repair: true,
      cliPath: '/openlore/dist/cli/index.js',
      spawnProcess: spawnHarness(calls),
    });

    expect(calls.map(call => call.args)).toEqual([
      ['/openlore/dist/cli/index.js', 'analyze', '--reanalyze', '--embedded'],
    ]);
  });

  it('keeps the parent event loop responsive while the analyzer child is running', async () => {
    const dir = freshDir(true);
    writeFileSync(join(dir, OPENLORE_CONFIG_REL_PATH), '{}');
    let child!: ChildProcess;
    const build = buildIndexInChildProcess(dir, {
      cliPath: '/openlore/dist/cli/index.js',
      spawnProcess: ((() => {
        child = new EventEmitter() as ChildProcess;
        child.unref = vi.fn();
        return child;
      }) as typeof spawn),
    });

    let ticked = false;
    await new Promise<void>(resolve => setImmediate(() => { ticked = true; resolve(); }));
    expect(ticked).toBe(true);
    child.emit('close', 0);
    await expect(build).resolves.toBeUndefined();
  });

  it('terminates an analyzer child when the MCP transport shuts down', async () => {
    const dir = freshDir(true);
    writeFileSync(join(dir, OPENLORE_CONFIG_REL_PATH), '{}');
    enableChildProcessBuilds();
    let child!: ChildProcess;
    const build = buildIndexInChildProcess(dir, {
      cliPath: '/openlore/dist/cli/index.js',
      spawnProcess: ((() => {
        child = new EventEmitter() as ChildProcess;
        child.unref = vi.fn();
        child.kill = vi.fn(() => {
          queueMicrotask(() => child.emit('close', null));
          return true;
        });
        return child;
      }) as typeof spawn),
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    await stopChildProcessBuilds();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(build).rejects.toThrow(/exited with code unknown/);
  });

  it('terminates the detached POSIX process group so heap-reexec descendants cannot survive', async () => {
    if (process.platform === 'win32') return;
    const dir = freshDir(true);
    writeFileSync(join(dir, OPENLORE_CONFIG_REL_PATH), '{}');
    enableChildProcessBuilds();
    let child!: ChildProcess;
    const processKill = vi.spyOn(process, 'kill').mockImplementation((_pid, _signal) => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    });
    const build = buildIndexInChildProcess(dir, {
      cliPath: '/openlore/dist/cli/index.js',
      spawnProcess: ((() => {
        child = new EventEmitter() as ChildProcess;
        Object.defineProperty(child, 'pid', { value: 43_210 });
        child.unref = vi.fn();
        child.kill = vi.fn();
        return child;
      }) as typeof spawn),
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    await stopChildProcessBuilds();

    expect(processKill).toHaveBeenCalledWith(-43_210, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
    await expect(build).rejects.toThrow(/exited with code unknown/);
  });

  it('uses shell-free Windows process-tree termination with forced escalation', () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'pid', { value: 54_321 });
    child.kill = vi.fn();
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const spawnTreeKiller = ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options });
      const killer = new EventEmitter() as ChildProcess;
      killer.unref = vi.fn();
      return killer;
    }) as typeof spawn;

    _terminateBuildChildForTesting(child, 'SIGTERM', 'win32', spawnTreeKiller);
    _terminateBuildChildForTesting(child, 'SIGKILL', 'win32', spawnTreeKiller);

    expect(calls.map(call => call.args)).toEqual([
      ['/PID', '54321', '/T'],
      ['/PID', '54321', '/T', '/F'],
    ]);
    expect(calls.every(call => win32.isAbsolute(call.command))).toBe(true);
    expect(calls.every(call => call.command.toLowerCase().endsWith('\\system32\\taskkill.exe'))).toBe(true);
    expect(calls.every(call => (call.options as { stdio: string; windowsHide: boolean }).stdio === 'ignore')).toBe(true);
    expect(calls.every(call => (call.options as { windowsHide: boolean }).windowsHide)).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('repairInBackground (make-index-self-healing)', () => {
  afterEach(() => {
    _resetRepairServiceForTesting();
    delete process.env.OPENLORE_NO_AUTO_ANALYZE;
  });

  it('fires the injected builder for a staleness reason and records in-progress status', async () => {
    const dir = freshDir(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ran = 0;
    const p = repairInBackground(dir, 'integrity-mismatched', {
      analyze: async () => { ran++; await gate; },
      log: () => {},
    });
    expect(p).not.toBeNull();
    // While the build is gated, the repair is disclosed as in-progress with its reason.
    expect(repairStatusFor(dir)).toEqual({ inProgress: true, reason: 'integrity-mismatched' });
    release();
    await p;
    expect(ran).toBe(1);
    // Completed → no longer in-progress (a later call serves fresh, no marker).
    expect(repairStatusFor(dir)).toBeUndefined();
  });

  it('is at-most-once per process per repo — a persistent trigger never thrashes', async () => {
    const dir = freshDir(true);
    let calls = 0;
    const opts = { analyze: async () => { calls++; }, log: () => {} };
    await repairInBackground(dir, 'stale-region', opts);
    // Same (or any) trigger still observed after a completed repair → disclose and stop.
    expect(repairInBackground(dir, 'stale-region', opts)).toBeNull();
    expect(repairInBackground(dir, 'analysis-age', opts)).toBeNull();
    expect(calls).toBe(1);
  });

  it('clears its guard on failure so a genuine retry can run', async () => {
    const dir = freshDir(true);
    let calls = 0;
    await repairInBackground(dir, 'schema-reset', {
      analyze: async () => { calls++; throw new Error('boom'); },
      log: () => {},
    });
    const p2 = repairInBackground(dir, 'schema-reset', { analyze: async () => { calls++; }, log: () => {} });
    expect(p2).not.toBeNull();
    await p2;
    expect(calls).toBe(2);
  });

  it('uses the process-registered builder when none is injected', async () => {
    const dir = freshDir(true);
    let ran = 0;
    registerRepairBuilder(async () => { ran++; });
    const p = repairInBackground(dir, 'analysis-age', { log: () => {} });
    expect(p).not.toBeNull();
    await p;
    expect(ran).toBe(1);
  });

  it('is a silent no-op when no builder is registered or injected (CLI/tests)', () => {
    const dir = freshDir(true);
    expect(repairInBackground(dir, 'analysis-age', { log: () => {} })).toBeNull();
    expect(repairStatusFor(dir)).toBeUndefined();
  });

  it('respects the OPENLORE_NO_AUTO_ANALYZE opt-out', () => {
    process.env.OPENLORE_NO_AUTO_ANALYZE = '1';
    const dir = freshDir(true);
    expect(repairInBackground(dir, 'stale-region', { analyze: async () => {}, log: () => {} })).toBeNull();
  });

  it('respects the .openlore/config.json autoInit:false opt-out', () => {
    const dir = freshDir(true);
    writeFileSync(join(dir, OPENLORE_CONFIG_REL_PATH), JSON.stringify({ autoInit: false }));
    expect(repairInBackground(dir, 'stale-region', { analyze: async () => {}, log: () => {} })).toBeNull();
  });
});

describe('host-scoped cited-file repair handoff', () => {
  afterEach(() => {
    _resetRepairServiceForTesting();
  });

  it('hands stale cited files only to the host registered for that exact root', () => {
    const hosted = freshDir(true);
    const other = freshDir(true);
    const received: Array<readonly string[]> = [];
    registerRepairHost(hosted, (files) => {
      received.push(files);
      return true;
    });

    expect(requestRepairFromHost(other, ['src/other.ts'])).toBe(false);
    expect(requestRepairFromHost(hosted, ['src/payments.ts', 'src/refunds.ts'])).toBe(true);
    expect(received).toEqual([['src/payments.ts', 'src/refunds.ts']]);
  });

  it('canonicalizes aliases while keeping sibling roots isolated', () => {
    const hosted = freshDir(true);
    const sibling = freshDir(true);
    let calls = 0;
    registerRepairHost(join(hosted, '.'), () => {
      calls++;
      return true;
    });

    expect(requestRepairFromHost(hosted, ['src/a.ts'])).toBe(true);
    expect(requestRepairFromHost(sibling, ['src/a.ts'])).toBe(false);
    expect(calls).toBe(1);
  });

  it('reports acceptance exactly as the host returns and fails soft on exceptions', () => {
    const declined = freshDir(true);
    registerRepairHost(declined, () => false);
    expect(requestRepairFromHost(declined, ['src/a.ts'])).toBe(false);

    const broken = freshDir(true);
    registerRepairHost(broken, () => { throw new Error('host stopped'); });
    expect(requestRepairFromHost(broken, ['src/b.ts'])).toBe(false);
    expect(requestRepairFromHost(broken, [])).toBe(false);
  });

  it('uses an identity-safe disposer when a host is replaced for the same root', () => {
    const dir = freshDir(true);
    const disposeOld = registerRepairHost(dir, () => false);
    const disposeCurrent = registerRepairHost(dir, () => true);

    disposeOld();
    expect(requestRepairFromHost(dir, ['src/a.ts'])).toBe(true);

    disposeCurrent();
    expect(requestRepairFromHost(dir, ['src/a.ts'])).toBe(false);
  });

  it('restores the prior same-root host when the newest registration is disposed', () => {
    const dir = freshDir(true);
    const calls: string[] = [];
    const disposeOld = registerRepairHost(dir, () => {
      calls.push('old');
      return false;
    });
    const disposeCurrent = registerRepairHost(dir, () => {
      calls.push('current');
      return true;
    });

    expect(requestRepairFromHost(dir, ['src/a.ts'])).toBe(true);
    disposeCurrent();
    expect(requestRepairFromHost(dir, ['src/a.ts'])).toBe(false);
    expect(calls).toEqual(['current', 'old']);

    disposeOld();
    expect(requestRepairFromHost(dir, ['src/a.ts'])).toBe(false);
  });
});
