/**
 * Lifecycle tests for the opt-in panic hooks (install ↔ uninstall symmetry,
 * format-update on re-run, and user-hook preservation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installPanicCheckHook, installGryphWatchHook, uninstallPanicHooks, installCheckEditHook, uninstallCheckEditHook, panicCheckHookCommand, evaluatePanicActivation, PANIC_DISABLED_SENTINEL } from './setup.js';
import { validatePanicSignal } from '../../core/services/mcp-handlers/panic-validation.js';
import type { PanicTelemetryEvent } from '../../core/services/mcp-handlers/panic-validation.js';
import { PANIC_GATE } from '../../core/services/mcp-handlers/panic-validation.js';

interface Settings {
  hooks?: {
    PreToolUse?: Array<{ command?: string }>;
    PostToolUse?: Array<{ matcher?: string; _openlore?: boolean; hooks?: Array<{ command?: string }> }>;
    UserPromptSubmit?: Array<{ command?: string }>;
  };
}

async function readSettings(dir: string): Promise<Settings> {
  return JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf-8')) as Settings;
}

describe('panic hook lifecycle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-hooks-test-'));
    // silence logger output
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('installs panic-check (PreToolUse) and gryph-watch (UserPromptSubmit)', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installGryphWatchHook(dir);
    const s = await readSettings(dir);
    expect(s.hooks?.PreToolUse).toHaveLength(1);
    expect(s.hooks?.PreToolUse?.[0].command).toContain('--format claude');
    expect(s.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it('is idempotent — re-running the same format does not duplicate', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installPanicCheckHook(dir, 'claude');
    const s = await readSettings(dir);
    expect(s.hooks?.PreToolUse).toHaveLength(1);
  });

  it('updates the command in place when the format changes (no stale duplicate)', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installPanicCheckHook(dir, 'codex');
    const s = await readSettings(dir);
    expect(s.hooks?.PreToolUse).toHaveLength(1);
    expect(s.hooks?.PreToolUse?.[0].command).toContain('--format codex');
    expect(s.hooks?.PreToolUse?.[0].command).not.toContain('--format claude');
  });

  it('uninstall removes openlore hooks but preserves user-authored hooks', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installGryphWatchHook(dir);
    // Inject a user hook that must survive.
    const s = await readSettings(dir);
    s.hooks!.PreToolUse!.push({ command: 'my-own-tool --check' });
    await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(s, null, 2), 'utf-8');

    await uninstallPanicHooks(dir);
    const after = await readSettings(dir);
    expect(after.hooks?.PreToolUse).toHaveLength(1);
    expect(after.hooks?.PreToolUse?.[0].command).toBe('my-own-tool --check');
    expect(after.hooks?.UserPromptSubmit).toBeUndefined(); // only ours was there → key dropped
  });

  it('uninstall is a no-op (never throws) when no settings file exists', async () => {
    await expect(uninstallPanicHooks(dir)).resolves.toBeUndefined();
  });
});

describe('check-edit PostToolUse hook lifecycle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-check-edit-hook-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('installs a read-only, edit-scoped Claude PostToolUse hook', async () => {
    await installCheckEditHook(dir);
    const settings = await readSettings(dir);
    expect(settings.hooks?.PostToolUse).toEqual([{
      matcher: 'Edit|Write|MultiEdit|NotebookEdit',
      _openlore: true,
      hooks: [{ type: 'command', command: 'openlore check-edit --hook' }],
    }]);
    const serialized = JSON.stringify(settings.hooks?.PostToolUse);
    expect(serialized).not.toContain('analyze');
    expect(serialized).not.toContain('structural_diff');
  });

  it('is idempotent and repairs a stale marker-matched entry', async () => {
    await installCheckEditHook(dir);
    await installCheckEditHook(dir);
    let settings = await readSettings(dir);
    expect(settings.hooks?.PostToolUse).toHaveLength(1);

    settings.hooks!.PostToolUse![0].matcher = '';
    await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
    await installCheckEditHook(dir);
    settings = await readSettings(dir);
    expect(settings.hooks?.PostToolUse).toHaveLength(1);
    expect(settings.hooks?.PostToolUse?.[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
  });

  it('uninstalls only the OpenLore entry and preserves user-authored PostToolUse hooks', async () => {
    await installCheckEditHook(dir);
    const settings = await readSettings(dir);
    settings.hooks!.PostToolUse!.push({ matcher: 'Edit', hooks: [{ command: 'my-check' }] });
    await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

    await uninstallCheckEditHook(dir);
    const after = await readSettings(dir);
    expect(after.hooks?.PostToolUse).toEqual([{ matcher: 'Edit', hooks: [{ command: 'my-check' }] }]);
  });

  it('refuses to overwrite corrupt settings', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const path = join(dir, '.claude', 'settings.json');
    await writeFile(path, '{broken', 'utf-8');
    await installCheckEditHook(dir);
    expect(await readFile(path, 'utf-8')).toBe('{broken');
  });

  it('refuses malformed-but-parseable hook containers without changing bytes', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const path = join(dir, '.claude', 'settings.json');
    const original = '{\n  "hooks": { "PostToolUse": "user-value" }\n}\n';
    await writeFile(path, original, 'utf-8');
    expect(await installCheckEditHook(dir)).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe(original);
  });

  it('refuses a parseable non-object settings root without changing bytes', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const path = join(dir, '.claude', 'settings.json');
    const original = 'null\n';
    await writeFile(path, original, 'utf-8');
    expect(await installCheckEditHook(dir)).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe(original);
  });

  it('rejects a symlinked .claude directory without mutating its outside target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-hook-outside-'));
    const outsideSettings = join(outside, 'settings.json');
    const original = '{"outside":true}\n';
    await writeFile(outsideSettings, original, 'utf-8');
    await symlink(outside, join(dir, '.claude'), 'dir');
    try {
      expect(await installCheckEditHook(dir)).toBe(false);
      expect(await uninstallCheckEditHook(dir)).toBe(false);
      expect(await readFile(outsideSettings, 'utf-8')).toBe(original);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked settings file without mutating its outside target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-hook-outside-file-'));
    const outsideSettings = join(outside, 'settings.json');
    const original = '{"outside":true}\n';
    await writeFile(outsideSettings, original, 'utf-8');
    await mkdir(join(dir, '.claude'));
    await symlink(outsideSettings, join(dir, '.claude', 'settings.json'));
    try {
      expect(await installCheckEditHook(dir)).toBe(false);
      expect(await uninstallCheckEditHook(dir)).toBe(false);
      expect(await readFile(outsideSettings, 'utf-8')).toBe(original);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('atomically installs and uninstalls without leaving a torn temp sibling', async () => {
    expect(await installCheckEditHook(dir)).toBe(true);
    const installed = await readFile(join(dir, '.claude', 'settings.json'), 'utf-8');
    expect(() => JSON.parse(installed)).not.toThrow();
    expect((await readdir(join(dir, '.claude'))).filter(name => name.includes('.tmp-'))).toEqual([]);

    expect(await uninstallCheckEditHook(dir)).toBe(true);
    const uninstalled = await readFile(join(dir, '.claude', 'settings.json'), 'utf-8');
    expect(() => JSON.parse(uninstalled)).not.toThrow();
    expect((await readdir(join(dir, '.claude'))).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
});

// ============================================================================
// Off-mode cheapness — the guarded PreToolUse command (skips spawning Node)
// ============================================================================

describe('panicCheckHookCommand (sentinel-guarded, exit-0)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-hooks-guard-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it('runs panic-check only when the disabled sentinel is absent, and always exits 0', () => {
    const cmd = panicCheckHookCommand('claude');
    // The sentinel guard short-circuits the spawn; the trailing `|| true` guarantees exit 0
    // (a non-zero PreToolUse exit could be read as a denial by the hook runtime).
    expect(cmd).toContain(PANIC_DISABLED_SENTINEL);
    expect(cmd).toContain('test -f');
    expect(cmd).toContain('openlore panic-check');
    expect(cmd).toContain('--format claude');
    expect(cmd.trimEnd().endsWith('|| true')).toBe(true);
  });

  it('installs the guarded command (still marker-matchable and idempotent)', async () => {
    await installPanicCheckHook(dir, 'claude');
    const s = await readSettings(dir);
    const cmd = s.hooks?.PreToolUse?.[0].command ?? '';
    expect(cmd).toContain('openlore panic-check'); // marker still present
    expect(cmd).toContain(PANIC_DISABLED_SENTINEL);
    await installPanicCheckHook(dir, 'claude'); // idempotent
    const s2 = await readSettings(dir);
    expect(s2.hooks?.PreToolUse).toHaveLength(1);
  });
});

// ============================================================================
// Interventional activation gate — never silent (evaluatePanicActivation)
// ============================================================================

describe('evaluatePanicActivation', () => {
  const clearedReport = () => {
    const events: PanicTelemetryEvent[] = [];
    for (let i = 0; i < PANIC_GATE.MIN_EPISODES; i++) {
      events.push(
        { ts: new Date(1_700_000_000_000 + i * 10_000).toISOString(), event: 'panic_level_change', from_level: 0, to_level: 2 },
        { ts: new Date(1_700_000_000_000 + i * 10_000 + 2).toISOString(), event: 'panic_orient_reset', delta: -40 },
        { ts: new Date(1_700_000_000_000 + i * 10_000 + 1000).toISOString(), event: 'panic_level_change', from_level: 2, to_level: 0 },
        { ts: new Date(1_700_000_000_000 + i * 10_000 + 3).toISOString(), event: 'hook_intervention' },
        { ts: new Date(1_700_000_000_000 + i * 10_000 + 4).toISOString(), event: 'panic_intervention_outcome', outcome: 'responded', delta: 3000 },
      );
    }
    return validatePanicSignal(events);
  };
  const emptyReport = () => validatePanicSignal([]);

  it('non-interventional modes always pass (off/observe)', () => {
    expect(evaluatePanicActivation('off', emptyReport(), false).allow).toBe(true);
    expect(evaluatePanicActivation('observe', emptyReport(), false).interventional).toBe(false);
  });

  it('refuses an interventional mode when the gate has not CLEARED, naming unmet criteria', () => {
    const d = evaluatePanicActivation('experimental_blocking', emptyReport(), false);
    expect(d.interventional).toBe(true);
    expect(d.allow).toBe(false);
    expect(d.unmet.join(' ')).toContain('insufficient data');
  });

  it('allows an interventional mode once the gate has CLEARED (no acknowledgement needed)', () => {
    const r = clearedReport();
    expect(r.verdict).toBe('CLEARED');
    expect(evaluatePanicActivation('advisory', r, false).allow).toBe(true);
  });

  it('allows an un-CLEARED interventional mode ONLY with the explicit acknowledgement flag', () => {
    expect(evaluatePanicActivation('experimental_blocking', emptyReport(), true).allow).toBe(true);
  });
});
