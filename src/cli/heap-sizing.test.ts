/**
 * Adaptive heap sizing — the decision, cgroup parsing, and user-heap detection
 * (change: make-analyze-scale-to-any-repo).
 *
 * The re-exec itself (spawnSync + process.exit) is an integration concern exercised end-to-end;
 * these unit tests pin the PURE decision surface, which is where every correctness rule lives:
 * at-most-once, respect-the-user, honor-the-opt-out, honor an explicit target, and the gain gate.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCgroupV2Max,
  parseCgroupV1Limit,
  cgroupV2MemoryMaxPaths,
  userHasSetHeap,
  planHeapReexec,
  commandFromArgv,
  HEAP_SIZED_COMMANDS,
  type HeapPlanInputs,
  MIN_TARGET_MB,
  MIN_GAIN_MB,
  DEFAULT_HEAP_FRACTION,
  NO_AUTO_HEAP_ENV,
  HEAP_MB_ENV,
} from './heap-sizing.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A baseline "would re-exec" input: small current heap, roomy budget, nothing set. */
function baseInputs(overrides: Partial<HeapPlanInputs> = {}): HeapPlanInputs {
  return {
    budgetBytes: 32 * GB,
    currentHeapLimitBytes: 2 * GB,
    userSetHeap: false,
    optOut: false,
    alreadyReexeced: false,
    explicitTargetMb: undefined,
    fraction: undefined,
    ...overrides,
  };
}

describe('parseCgroupV2Max', () => {
  it('parses a byte limit', () => {
    expect(parseCgroupV2Max('2147483648\n')).toBe(2147483648);
  });
  it('treats "max" and unlimited sentinels as no limit', () => {
    expect(parseCgroupV2Max('max')).toBeUndefined();
    expect(parseCgroupV2Max(String(2 ** 60))).toBeUndefined();
  });
  it('rejects empty, null, and unparseable values', () => {
    expect(parseCgroupV2Max('')).toBeUndefined();
    expect(parseCgroupV2Max(null)).toBeUndefined();
    expect(parseCgroupV2Max('nonsense')).toBeUndefined();
    expect(parseCgroupV2Max('0')).toBeUndefined();
  });
});

describe('parseCgroupV1Limit', () => {
  it('parses a byte limit', () => {
    expect(parseCgroupV1Limit('4294967296')).toBe(4294967296);
  });
  it('treats the near-INT64_MAX no-limit sentinel as no limit', () => {
    expect(parseCgroupV1Limit('9223372036854771712')).toBeUndefined();
  });
});

describe('cgroupV2MemoryMaxPaths — hierarchy walk', () => {
  it('returns just the root for a root-cgroup process (or missing proc file)', () => {
    expect(cgroupV2MemoryMaxPaths('0::/\n')).toEqual(['/sys/fs/cgroup/memory.max']);
    expect(cgroupV2MemoryMaxPaths(null)).toEqual(['/sys/fs/cgroup/memory.max']);
    expect(cgroupV2MemoryMaxPaths('')).toEqual(['/sys/fs/cgroup/memory.max']);
  });
  it('walks root → each ancestor → leaf for a nested cgroup', () => {
    expect(cgroupV2MemoryMaxPaths('0::/system.slice/app.service\n')).toEqual([
      '/sys/fs/cgroup/memory.max',
      '/sys/fs/cgroup/system.slice/memory.max',
      '/sys/fs/cgroup/system.slice/app.service/memory.max',
    ]);
  });
  it('ignores non-v2 controller lines (hybrid /proc/self/cgroup)', () => {
    const hybrid = '3:memory:/foo\n0::/system.slice/x.service\n';
    expect(cgroupV2MemoryMaxPaths(hybrid)).toEqual([
      '/sys/fs/cgroup/memory.max',
      '/sys/fs/cgroup/system.slice/memory.max',
      '/sys/fs/cgroup/system.slice/x.service/memory.max',
    ]);
  });
});

describe('userHasSetHeap', () => {
  it('detects a heap flag in execArgv (both spellings)', () => {
    expect(userHasSetHeap(['--max-old-space-size=4096'], undefined)).toBe(true);
    expect(userHasSetHeap(['--max_old_space_size=4096'], undefined)).toBe(true);
  });
  it('detects a heap flag in NODE_OPTIONS', () => {
    expect(userHasSetHeap([], '--max-old-space-size=8192')).toBe(true);
  });
  it('is false when no heap flag is present', () => {
    expect(userHasSetHeap(['--enable-source-maps'], '--no-warnings')).toBe(false);
    expect(userHasSetHeap([], undefined)).toBe(false);
  });
});

describe('commandFromArgv + HEAP_SIZED_COMMANDS — the command gate', () => {
  it('extracts the first non-flag token as the command', () => {
    expect(commandFromArgv(['node', '/cli.js', 'analyze', '--force'])).toBe('analyze');
    expect(commandFromArgv(['node', '/cli.js', '--quiet', 'install'])).toBe('install');
  });
  it('is undefined for a bare invocation or global-flag-only', () => {
    expect(commandFromArgv(['node', '/cli.js'])).toBeUndefined();
    expect(commandFromArgv(['node', '/cli.js', '--version'])).toBeUndefined();
  });
  it('skips the VALUE of a space-separated global value-option (does not read it as the command)', () => {
    // The bug this guards: `openlore --config prod.json analyze` must detect `analyze`, not the path.
    expect(commandFromArgv(['node', '/cli.js', '--config', 'prod.json', 'analyze'])).toBe('analyze');
    expect(commandFromArgv(['node', '/cli.js', '--timeout', '120000', 'run'])).toBe('run');
    expect(commandFromArgv(['node', '/cli.js', '--api-base', 'http://x', 'prove'])).toBe('prove');
    // A config path literally named like a command must not misfire either.
    expect(commandFromArgv(['node', '/cli.js', '--config', 'run', 'orient'])).toBe('orient');
    // The `=`-joined form already starts with `-`, so it needs no special handling.
    expect(commandFromArgv(['node', '/cli.js', '--config=prod.json', 'analyze'])).toBe('analyze');
  });
  it('sizes the finite graph-building commands but NOT the query hot paths or daemons', () => {
    expect(HEAP_SIZED_COMMANDS.has('analyze')).toBe(true);
    expect(HEAP_SIZED_COMMANDS.has('install')).toBe(true);
    expect(HEAP_SIZED_COMMANDS.has('run')).toBe(true);
    // The agent hot path must never pay an extra process spawn.
    expect(HEAP_SIZED_COMMANDS.has('orient')).toBe(false);
    expect(HEAP_SIZED_COMMANDS.has('search')).toBe(false);
    expect(HEAP_SIZED_COMMANDS.has('doctor')).toBe(false);
    // The long-lived daemons are excluded: a blocking spawnSync supervisor can't forward a directed
    // signal, which would orphan the server. They size via --max-old-space-size / OPENLORE_HEAP_MB.
    expect(HEAP_SIZED_COMMANDS.has('mcp')).toBe(false);
    expect(HEAP_SIZED_COMMANDS.has('serve')).toBe(false);
  });
});

describe('planHeapReexec — safety rules', () => {
  it('never re-execs a process that already re-executed (at-most-once), even if everything else says go', () => {
    const plan = planHeapReexec(baseInputs({ alreadyReexeced: true }));
    expect(plan.action).toBe('skip');
    expect(plan.reason).toMatch(/already re-executed/);
  });

  it('the marker wins over an explicit target too — no loop under any input', () => {
    const plan = planHeapReexec(baseInputs({ alreadyReexeced: true, explicitTargetMb: 65536 }));
    expect(plan.action).toBe('skip');
  });

  it('skips when the opt-out is set', () => {
    const plan = planHeapReexec(baseInputs({ optOut: true }));
    expect(plan.action).toBe('skip');
    expect(plan.reason).toContain(NO_AUTO_HEAP_ENV);
  });

  it('respects a user-set heap', () => {
    const plan = planHeapReexec(baseInputs({ userSetHeap: true }));
    expect(plan.action).toBe('skip');
    expect(plan.reason).toMatch(/user set the heap/);
  });

  it('user-set heap wins over an explicit OPENLORE_HEAP_MB', () => {
    const plan = planHeapReexec(baseInputs({ userSetHeap: true, explicitTargetMb: 65536 }));
    expect(plan.action).toBe('skip');
  });
});

describe('planHeapReexec — auto sizing', () => {
  it('re-execs to the fraction of the budget when it beats the current heap', () => {
    const plan = planHeapReexec(baseInputs()); // 32 GB budget, 2 GB current
    expect(plan.action).toBe('reexec');
    expect(plan.targetMb).toBe(Math.floor((32 * GB * DEFAULT_HEAP_FRACTION) / MB));
  });

  it('skips when the current heap is already adequate (gain below the margin)', () => {
    // Budget so small the 75% target barely exceeds the current heap.
    const current = 3 * GB;
    const budget = Math.floor((current + (MIN_GAIN_MB - 100) * MB) / DEFAULT_HEAP_FRACTION);
    const plan = planHeapReexec(baseInputs({ budgetBytes: budget, currentHeapLimitBytes: current }));
    expect(plan.action).toBe('skip');
    expect(plan.reason).toMatch(/already adequate/);
  });

  it('skips when the budget is unknown', () => {
    expect(planHeapReexec(baseInputs({ budgetBytes: 0 })).action).toBe('skip');
    expect(planHeapReexec(baseInputs({ budgetBytes: Number.NaN })).action).toBe('skip');
  });

  it('honors a custom fraction', () => {
    const plan = planHeapReexec(baseInputs({ fraction: 0.5 }));
    expect(plan.targetMb).toBe(Math.floor((32 * GB * 0.5) / MB));
  });

  it('clamps a bad fraction back to the default', () => {
    const plan = planHeapReexec(baseInputs({ fraction: -1 }));
    expect(plan.targetMb).toBe(Math.floor((32 * GB * DEFAULT_HEAP_FRACTION) / MB));
  });
});

describe('planHeapReexec — explicit target', () => {
  it('re-execs to OPENLORE_HEAP_MB when larger than current', () => {
    const plan = planHeapReexec(baseInputs({ explicitTargetMb: 16384 }));
    expect(plan.action).toBe('reexec');
    expect(plan.targetMb).toBe(16384);
    expect(plan.reason).toContain(HEAP_MB_ENV);
  });

  it('skips an explicit target that is not larger than the current heap', () => {
    const plan = planHeapReexec(baseInputs({ explicitTargetMb: 1024, currentHeapLimitBytes: 2 * GB }));
    expect(plan.action).toBe('skip');
  });

  it('floors an explicit target at MIN_TARGET_MB', () => {
    const plan = planHeapReexec(baseInputs({ explicitTargetMb: 1, currentHeapLimitBytes: 100 * MB }));
    expect(plan.action).toBe('reexec');
    expect(plan.targetMb).toBe(MIN_TARGET_MB);
  });
});
