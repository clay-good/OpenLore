import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { formatProveGuidance, renderInstructionBlock, runInstall } from './index.js';
import { extractBlock, renderBlock } from './block.js';
import { TOOL_PRESETS } from '../commands/mcp.js';
import { FULL_PRESET } from '../../constants.js';
import { formatGuardedHookCommand, resolveOpenloreCommand } from '../../utils/platform-command.js';
import { logger } from '../../utils/logger.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the installer SHOULD wire on this host, derived from the same resolver it uses.
 *
 * These assertions used to spell the npx form out as a literal.
 * That is the POSIX answer. Since fix-windows-console-flash-from-npx-shim the Windows answer
 * is deliberately different — OpenLore's own CLI entry under an absolute node, never the npx
 * shim, because a .cmd can only start through cmd.exe and opens a console window per call.
 * A literal here therefore asserted one platform's output as if it were the contract, and
 * failed on the platform the change was FOR.
 */
function expectedHook(args: readonly string[]): string {
  return formatGuardedHookCommand(resolveOpenloreCommand(args), process.platform);
}

function expectedWiring(args: readonly string[]): { command: string; args: string[] } {
  const resolved = resolveOpenloreCommand(args);
  return { command: resolved.command, args: [...resolved.args] };
}

describe('openlore install (end-to-end)', () => {
  let dir: string;
  // Bare install now writes a USER-scope footprint too (change:
  // unify-onboarding-entrypoint). Every test in this file pins that scope to a
  // throwaway directory: without it the suite would edit the developer's real
  // ~/.claude.json, ~/.claude/settings.json, and ~/.claude/CLAUDE.md. OPENLORE_HOME
  // is the same override production honors, so this exercises the real path.
  let home: string;
  const previousHome = process.env.OPENLORE_HOME;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-install-'));
    home = await mkdtemp(join(tmpdir(), 'openlore-home-'));
    process.env.OPENLORE_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.OPENLORE_HOME;
    else process.env.OPENLORE_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('--dry-run writes nothing', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    const code = await runInstall({ cwd: dir, agent: 'claude-code', dryRun: true });
    expect(code).toBe(0);
    const md = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toBe('# project\n');
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(false);
  });

  it('--dry-run emits diff previews to stderr', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runInstall({ cwd: dir, agent: 'claude-code', dryRun: true });
    } finally {
      process.stderr.write = origWrite;
    }
    const combined = captured.join('');
    // Markdown block preview contains a diff hunk; settings.json preview shows new content.
    expect(combined).toMatch(/\+ <!-- BEGIN OPENLORE/);
    expect(combined).toMatch(/\(new file\).+settings\.json/);
  });

  // An `mcpServers.openlore` entry OpenLore did not write is someone's deliberate choice —
  // a wrapper script, a pinned preset, another checkout's path. It used to be replaced with
  // no warning at all. Matches what the Codex adapter already does for `mcp_servers.openlore`.
  it('preserves an mcpServers.openlore entry it did not write, and says so', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          openlore: { command: 'my-wrapper', args: ['--my-flag'] },
          other: { command: 'other-server' },
        },
      }, null, 2) + '\n',
    );

    const code = await runInstall({ cwd: dir, agent: 'claude-code', repoOnly: true, analyze: false });

    expect(code).toBe(1);
    const after = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(after.mcpServers.openlore).toEqual({ command: 'my-wrapper', args: ['--my-flag'] });
    expect(after._openlore).toBeUndefined();
  });

  // A conflict reachable on an otherwise successful install used to print THREE conclusions:
  // "OpenLore install complete.", a "Wired surface" line claiming the guidance matches a preset
  // no registration had been written for, and "Install did not complete"
  // (change: fix-install-conflict-verdict).
  it('states one verdict when a refusal happens, and never claims a wired surface', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { openlore: { command: 'my-wrapper' } } }, null, 2) + '\n',
    );
    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const origError = console.error;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    // The logger renders through console.error and console.log, so all sinks are captured.
    const origLog = console.log;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    let code: number;
    try {
      code = await runInstall({ cwd: dir, agent: 'claude-code', repoOnly: true, analyze: false });
    } finally {
      process.stderr.write = origWrite;
      console.error = origError;
      console.log = origLog;
    }
    const out = lines.join('\n');

    expect(code).toBe(1);
    expect(out).toContain('install incomplete');
    expect(out).toContain('Install did not complete');
    expect(out).not.toContain('OpenLore install complete.');
    expect(out, 'no registration was written, so no surface was wired').not.toContain('Wired surface');
  });

  it('--force takes over an mcpServers.openlore entry it did not write', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { openlore: { command: 'my-wrapper' } } }, null, 2) + '\n',
    );

    const code = await runInstall({ cwd: dir, agent: 'claude-code', repoOnly: true, analyze: false, force: true });

    expect(code).toBe(0);
    const after = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(after.mcpServers.openlore.command).not.toBe('my-wrapper');
  });

  it('agent-md install creates AGENTS.md with managed block', async () => {
    const code = await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    expect(code).toBe(0);
    const md = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('BEGIN OPENLORE');
    expect(md).toContain('the `orient` tool');
  });

  // skipIf(win32): the premise is a symlink, and creating one there needs elevated
  // privileges or Developer Mode — the test cannot build the escape it asserts is refused,
  // and would assert against a plain file instead. The confinement is platform-independent
  // and runs on Linux.
  it.skipIf(process.platform === 'win32')('rejects an outbound AGENTS.md symlink even with --force', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-install-outside-'));
    const target = join(outside, 'AGENTS.md');
    await writeFile(target, 'operator-owned\n', 'utf8');
    await symlink(target, join(dir, 'AGENTS.md'));
    try {
      await expect(runInstall({ cwd: dir, agent: 'agents-md', force: true, analyze: false }))
        .rejects.toThrow(/canonicalizes outside/);
      expect(await readFile(target, 'utf8')).toBe('operator-owned\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // skipIf(win32): the premise is a symlink, and creating one there needs elevated
  // privileges or Developer Mode — the test cannot build the escape it asserts is refused,
  // and would assert against a plain file instead. The confinement is platform-independent
  // and runs on Linux.
  it.skipIf(process.platform === 'win32')('preflights Cursor destinations before writing through an outbound parent symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-cursor-outside-'));
    await symlink(outside, join(dir, '.cursor'), 'dir');
    try {
      await expect(runInstall({ cwd: dir, agent: 'cursor', force: true, analyze: false }))
        .rejects.toThrow(/canonicalizes outside/);
      expect(await exists(join(dir, '.cursorrules'))).toBe(false);
      expect(await exists(join(outside, 'mcp.json'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('claude-code install writes mcpServers to .mcp.json and SessionStart to settings.json', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);

    // MCP server goes in .mcp.json — the file Claude Code actually reads.
    // change: default-to-lean-tool-surface / ADR-0023 — a default install (no
    // --preset) wires the lean default surface (substrate) explicitly, not the
    // bare full surface, via LEAN_DEFAULT_PRESET.
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore).toEqual(expectedWiring(['mcp', '--preset', 'substrate']));
    expect(mcp._openlore.managed).toBe(true);

    // settings.json carries only the SessionStart hook — never mcpServers.
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.mcpServers).toBeUndefined();
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      expectedHook(['orient', '--json'])
    );
  });

  it('claude-code install migrates a legacy mcpServers entry out of settings.json', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.claude'), { recursive: true });
    // Simulate a pre-2.0.9 install that wrote the server to the wrong file.
    const legacy = {
      mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } },
      _openlore: { managed: true, version: 1, fingerprint: 'x', paths: ['mcpServers.openlore'] },
    };
    await writeFile(join(dir, '.claude/settings.json'), JSON.stringify(legacy, null, 2), 'utf8');

    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.mcpServers).toBeUndefined();
    expect(settings._openlore).toBeUndefined();
    expect(settings.hooks.SessionStart[0]._openlore).toBe(true);
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore.command).toBe(expectedWiring(['mcp']).command);
  });

  // change: default-to-lean-tool-surface — install wires the lean default by default
  // and the full surface only on explicit --preset full.
  it('default install wires --preset substrate; --preset full wires the full surface', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');

    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    let mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'substrate']).args);

    // Re-install with --preset full restores the prior all-tools surface (idempotent merge).
    const code = await runInstall({ cwd: dir, agent: 'claude-code', preset: 'full', analyze: false, force: true });
    expect(code).toBe(0);
    mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'full']).args);
  });

  it('rejects an unknown --preset but accepts the full-surface selectors', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    expect(await runInstall({ cwd: dir, agent: 'claude-code', preset: 'nope', analyze: false })).toBe(2);
    expect(await runInstall({ cwd: dir, agent: 'claude-code', preset: 'full', analyze: false, force: true })).toBe(0);
    expect(await runInstall({ cwd: dir, agent: 'claude-code', preset: 'navigation', analyze: false, force: true })).toBe(0);
  });

  // change: default-to-lean-tool-surface — --all-tools is the convenience full
  // selector on install/connect (matching `openlore mcp --all-tools`), and the
  // `all` alias normalizes to the canonical `full` so the wired arg is never two
  // strings for one surface.
  it('--all-tools and --preset all both wire the canonical --preset full', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await runInstall({ cwd: dir, agent: 'claude-code', allTools: true, analyze: false });
    let mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'full']).args);

    await runInstall({ cwd: dir, agent: 'claude-code', preset: 'all', analyze: false, force: true });
    mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'full']).args); // 'all' normalized
  });

  // change: default-to-lean-tool-surface — REGRESSION: the cursor adapter
  // early-returned when its .mdc was unchanged, skipping the .cursor/mcp.json
  // registration and FREEZING the wired preset, so a re-install with a different
  // --preset was silently ignored. A preset switch must now take effect on cursor.
  it('cursor: switching --preset on re-install updates .cursor/mcp.json (not frozen by an unchanged .mdc)', async () => {
    const mcpPath = join(dir, '.cursor/mcp.json');
    await runInstall({ cwd: dir, agent: 'cursor', analyze: false });
    let mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'substrate']).args);

    // The .mdc body is preset-independent → unchanged on this re-install. The MCP
    // entry must STILL switch to full (the bug left it stale at navigation).
    await runInstall({ cwd: dir, agent: 'cursor', preset: 'full', analyze: false });
    mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'full']).args);

    // …and back to the lean default.
    await runInstall({ cwd: dir, agent: 'cursor', analyze: false });
    mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'substrate']).args);
  });

  it('re-running install is a no-op (no writes, exit 0)', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    const mdBefore = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    const settingsBefore = await readFile(join(dir, '.claude/settings.json'), 'utf8');
    const mcpBefore = await readFile(join(dir, '.mcp.json'), 'utf8');

    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(mdBefore);
    expect(await readFile(join(dir, '.claude/settings.json'), 'utf8')).toBe(settingsBefore);
    expect(await readFile(join(dir, '.mcp.json'), 'utf8')).toBe(mcpBefore);
  });

  it('refuses to overwrite hand-edited block without --force', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    const md = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    const tampered = md.replace('the `orient` tool', 'OOPS-EDITED');
    await writeFile(join(dir, 'AGENTS.md'), tampered, 'utf8');

    const code = await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    expect(code).toBe(1);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(tampered);
  });

  it('--force overwrites hand-edited block', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    const md = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    const tampered = md.replace('the `orient` tool', 'OOPS-EDITED');
    await writeFile(join(dir, 'AGENTS.md'), tampered, 'utf8');

    const code = await runInstall({ cwd: dir, agent: 'agents-md', force: true, analyze: false });
    expect(code).toBe(0);
    const after = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(after).not.toContain('OOPS-EDITED');
    expect(after).toContain('the `orient` tool');
  });

  it('--uninstall restores a pre-existing CLAUDE.md byte-for-byte', async () => {
    const original = '# my project\n\nsome notes\n';
    await writeFile(join(dir, 'CLAUDE.md'), original);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).not.toBe(original);

    const code = await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(original);
    // settings.json and .mcp.json were created by us, so both should be removed
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(false);
    expect(await exists(join(dir, '.mcp.json'))).toBe(false);
  });

  it('--uninstall names the retained .openlore data and its removal command', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    const info = vi.spyOn(logger, 'info');
    try {
      await runInstall({ cwd: dir, agent: 'agents-md', uninstall: true });
      const kept = info.mock.calls.find(([title]) => title === 'Kept data')?.[1];
      expect(String(kept)).toContain('.openlore/');
      expect(String(kept)).toContain('index, decisions, and memories');
      expect(String(kept)).toContain('From the repository root');
      expect(String(kept)).toContain('rm -rf -- ./.openlore/');
    } finally {
      info.mockRestore();
    }
  });

  it('--uninstall names each skill openlore setup copied as kept, with its removal command, and deletes none (8.4)', async () => {
    const { buildManifest } = await import('../commands/setup.js');
    const skill = buildManifest(dir).claude[0].dest;
    const workflow = buildManifest(dir).cline[0].dest;
    for (const f of [skill, workflow]) {
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, '# edited by the user\n');
    }
    await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    const info = vi.spyOn(logger, 'info');
    try {
      await runInstall({ cwd: dir, agent: 'agents-md', uninstall: true });
      const kept = String(info.mock.calls.find(([title]) => title === 'Kept skills')?.[1]);
      const skillDir = relative(dir, dirname(skill)).split(sep).join('/');
      const workflowFile = relative(dir, workflow).split(sep).join('/');
      expect(kept).toContain(skillDir);
      expect(kept).toContain(workflowFile);
      expect(kept).toContain(`rm -rf -- ./${skillDir}`);
      expect(await exists(skill)).toBe(true);
      expect(await exists(workflow)).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('--uninstall says nothing about skills when setup copied none', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    const info = vi.spyOn(logger, 'info');
    try {
      await runInstall({ cwd: dir, agent: 'agents-md', uninstall: true });
      expect(info.mock.calls.find(([title]) => title === 'Kept skills')).toBeUndefined();
    } finally {
      info.mockRestore();
    }
  });

  it('gates the install prove epilogue for sparse and dense graph measurements', () => {
    const sparse = formatProveGuidance({
      eligibleFunctions: 0,
      requiredEligibleFunctions: 1,
      minCallers: 2,
      eligible: false,
    });
    expect(sparse.title).toBe('Measured projection unavailable');
    expect(sparse.detail).not.toContain('openlore prove --estimate');
    expect(sparse.detail).toContain('0 functions have ≥2 callers');

    const dense = formatProveGuidance({
      eligibleFunctions: 1,
      requiredEligibleFunctions: 1,
      minCallers: 2,
      eligible: true,
    });
    expect(dense.title).toBe('Does it pay off?');
    expect(dense.detail).toContain('openlore prove --estimate');
  });

  it('--uninstall removes AGENTS.md when it was OpenLore-only', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md', analyze: false });
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(true);
    await runInstall({ cwd: dir, agent: 'agents-md', uninstall: true });
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('--uninstall removes CLAUDE.md when install created it (no stray empty file)', async () => {
    // No pre-existing CLAUDE.md → install creates it OpenLore-only.
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(await exists(join(dir, 'CLAUDE.md'))).toBe(true);
    await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    // Must be deleted, not left behind as an empty file.
    expect(await exists(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('preserves user-defined SessionStart hooks alongside ours', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.claude'), { recursive: true });
    const userHook = {
      matcher: 'shell',
      hooks: [{ type: 'command', command: 'echo hello' }],
    };
    await writeFile(
      join(dir, '.claude/settings.json'),
      JSON.stringify({ hooks: { SessionStart: [userHook] } }, null, 2),
      'utf8'
    );

    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    // The user's group, our session-start primer, and the after-compact handoff moment.
    expect(settings.hooks.SessionStart).toHaveLength(3);
    expect(settings.hooks.SessionStart[0]).toEqual(userHook);
    expect(settings.hooks.SessionStart[1]._openlore).toBe(true);
    expect(settings.hooks.SessionStart[1].hooks[0].command).toBe(
      expectedHook(['orient', '--json'])
    );
    expect(settings.hooks.SessionStart[2]).toMatchObject({ matcher: 'compact', _openloreHook: 'after-compact' });

    await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    const after = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(after.hooks.SessionStart).toEqual([userHook]);
    expect(after.mcpServers).toBeUndefined();
    expect(after._openlore).toBeUndefined();
  });

  it('claude-code install wires a marker-identified UserPromptSubmit injection hook', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    // Both managed hook groups are present, each marker-identified.
    expect(settings.hooks.SessionStart[0]._openlore).toBe(true);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0]._openlore).toBe(true);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      expectedHook(['orient', '--inject'])
    );
  });

  it('re-running install keeps a single UserPromptSubmit group (idempotent)', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.UserPromptSubmit.filter((e: { _openlore?: boolean }) => e._openlore)).toHaveLength(1);
  });

  it('uninstall removes both hook groups and preserves user-defined UserPromptSubmit hooks', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.claude'), { recursive: true });
    const userHook = { matcher: 'foo', hooks: [{ type: 'command', command: 'echo bar' }] };
    await writeFile(
      join(dir, '.claude/settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [userHook] } }, null, 2),
      'utf8'
    );

    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit[0]).toEqual(userHook);
    expect(settings.hooks.UserPromptSubmit[1]._openlore).toBe(true);

    await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    const after = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(after.hooks.UserPromptSubmit).toEqual([userHook]);
    expect(after.hooks.SessionStart).toBeUndefined();
  });

  it('claude-code install wires the agent-loop moments, each identified by its own marker', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.claude'), { recursive: true });
    // The opt-in check-edit hook is also an `_openlore` group on PostToolUse: it must survive.
    const checkEdit = { matcher: 'Edit|Write|MultiEdit|NotebookEdit', _openlore: true, hooks: [{ type: 'command', command: 'openlore check-edit --hook' }] };
    await writeFile(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [checkEdit] } }, null, 2), 'utf8');

    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false })).toBe(0);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false }); // idempotent
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toEqual([{
      matcher: 'Edit|Write|MultiEdit|NotebookEdit', _openlore: true, _openloreHook: 'before-edit',
      hooks: [{ type: 'command', command: expectedHook(['hook', 'before-edit']), timeout: 15 }],
    }, {
      matcher: 'Agent|Task', _openlore: true, _openloreHook: 'before-subagent',
      hooks: [{ type: 'command', command: expectedHook(['hook', 'before-subagent']), timeout: 10 }],
    }]);
    expect(settings.hooks.SubagentStart).toEqual([{ matcher: '', _openlore: true, _openloreHook: 'subagent-start', hooks: [{ type: 'command', command: expectedHook(['hook', 'subagent-start']), timeout: 30 }] }]);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0]).toEqual(checkEdit);
    expect(settings.hooks.PostToolUse[1]._openloreHook).toBe('after-tools');
    expect(settings.hooks.Stop[0]).toMatchObject({ _openloreHook: 'before-stop', hooks: [{ command: expectedHook(['hook', 'before-stop']), timeout: 90 }] });

    await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    const after = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(after.hooks).toEqual({ PostToolUse: [checkEdit] });
  });

  it('install and uninstall remove a group for a moment this version no longer has (hook-reliability 8.2)', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.claude'), { recursive: true });
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    const retired = { matcher: '', _openlore: true, _openloreHook: 'old-moment', hooks: [{ type: 'command', command: 'openlore hook old-moment' }] };
    const retiredAlone = { matcher: '', _openlore: true, _openloreHook: 'gone-moment', hooks: [{ type: 'command', command: 'openlore hook gone-moment' }] };
    const original = JSON.stringify({ hooks: { PostToolUse: [userHook, retired], Notification: [retiredAlone] } }, null, 2);
    await writeFile(join(dir, '.claude/settings.json'), original, 'utf8');

    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false })).toBe(0);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false }); // twice: still one group each
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8')) as { hooks: Record<string, Array<Record<string, unknown>>> };
    const all = Object.values(settings.hooks).flat();
    expect(all.filter(g => g._openloreHook === 'old-moment' || g._openloreHook === 'gone-moment')).toEqual([]);
    expect(settings.hooks.Notification).toBeUndefined();
    expect(settings.hooks.PostToolUse[0]).toEqual(userHook);
    // Exactly one OpenLore group per managed hook.
    const ours = Object.entries(settings.hooks).flatMap(([event, groups]) => groups
      .filter(g => g._openlore === true)
      .map(g => `${event}:${String(g._openloreHook ?? 'plain')}@${JSON.stringify((g.hooks as Array<{ command: string }>)[0].command)}`));
    expect(new Set(ours).size).toBe(ours.length);

    // Uninstall from a file that again carries a retired group leaves only the user's hook.
    settings.hooks.PostToolUse.push(retired);
    await writeFile(join(dir, '.claude/settings.json'), JSON.stringify(settings, null, 2), 'utf8');
    await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    const after = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8')) as { hooks: Record<string, unknown> };
    expect(after.hooks).toEqual({ PostToolUse: [userHook] });
  });

  it('cursor install writes .cursor/mcp.json with mcpServers.openlore', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const code = await runInstall({ cwd: dir, agent: 'cursor', analyze: false });
    expect(code).toBe(0);
    const mcp = JSON.parse(await readFile(join(dir, '.cursor/mcp.json'), 'utf8'));
    // change: default-to-lean-tool-surface / ADR-0023 — default wires the lean default surface (substrate).
    expect(mcp.mcpServers.openlore).toEqual(expectedWiring(['mcp', '--preset', 'substrate']));
    expect(mcp._openlore.managed).toBe(true);

    // Uninstall removes the file when it only had our entries.
    await runInstall({ cwd: dir, agent: 'cursor', uninstall: true });
    expect(await exists(join(dir, '.cursor/mcp.json'))).toBe(false);
  });

  it('cursor install preserves pre-existing non-OpenLore mcpServers', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const existing = { mcpServers: { other: { command: 'foo' } } };
    await writeFile(join(dir, '.cursor/mcp.json'), JSON.stringify(existing, null, 2));

    await runInstall({ cwd: dir, agent: 'cursor', analyze: false });
    const merged = JSON.parse(await readFile(join(dir, '.cursor/mcp.json'), 'utf8'));
    expect(merged.mcpServers.other).toEqual({ command: 'foo' });
    expect(merged.mcpServers.openlore.command).toBe(expectedWiring(['mcp']).command);

    await runInstall({ cwd: dir, agent: 'cursor', uninstall: true });
    const after = JSON.parse(await readFile(join(dir, '.cursor/mcp.json'), 'utf8'));
    expect(after.mcpServers.other).toEqual({ command: 'foo' });
    expect(after.mcpServers.openlore).toBeUndefined();
  });

  // change: default-to-lean-tool-surface (adversarial-review hardening) — a hostile
  // `.mcp.json` whose `mcpServers` is a non-object (string/number/null/array) used to
  // crash install: isJsonObjectText is true for the top-level object, so the
  // format-preserving editor ran `modify([...,'mcpServers','openlore'])` and threw on
  // the non-container parent, half-writing the install. Now it falls back to a clean
  // merged write (the in-memory merge already coerced the bad value).
  it.each([
    ['string', '{"mcpServers":"oops"}'],
    ['number', '{"mcpServers":123}'],
    ['null', '{"mcpServers":null}'],
    ['array', '{"mcpServers":["x"]}'],
  ])('install does not crash when existing .mcp.json has a %s mcpServers value', async (_label, body) => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await writeFile(join(dir, '.mcp.json'), body);
    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore.args).toEqual(expectedWiring(['mcp', '--preset', 'substrate']).args);
  });

  it('auto-detects multiple surfaces when no --agent passed', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const code = await runInstall({ cwd: dir, analyze: false });
    expect(code).toBe(0);
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true);
    expect(await exists(join(dir, '.cursor/rules/openlore.mdc'))).toBe(true);
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(true); // universal fallback
  });
});

// ============================================================================
// settings.json format preservation (decision df27e8ef)
// Regression guard for the dogfood finding: install/uninstall reparsed +
// JSON.stringify'd the user's settings.json, reformatting untouched sections
// (e.g. a multi-line empty array collapsed; a 4-space/tab file forced to 2-space).
// ============================================================================

describe('openlore install — settings.json format preservation', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'openlore-fmt-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function writeSettings(text: string) {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude/settings.json'), text, 'utf8');
  }
  const read = () => readFile(join(dir, '.claude/settings.json'), 'utf8');

  it('preserves a 4-space-indented untouched section and indents the added hook to match', async () => {
    const orig = '{\n    "permissions": {\n        "allow": [\n            "Read"\n        ]\n    }\n}\n';
    await writeSettings(orig);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    const after = await read();
    // the user's block is preserved verbatim
    expect(after).toContain('    "permissions": {\n        "allow": [\n            "Read"\n        ]\n    }');
    // the added hook uses the user's 4-space unit, not a forced 2-space
    expect(after).toMatch(/\n {4}"hooks": \{\n {8}"SessionStart"/);
    expect(after).toContain('SessionStart');
  });

  it('preserves a tab-indented file', async () => {
    const orig = '{\n\t"permissions": {\n\t\t"allow": [\n\t\t\t"Read"\n\t\t]\n\t}\n}\n';
    await writeSettings(orig);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    const after = await read();
    expect(after).toContain('\n\t"permissions": {\n\t\t"allow": [');
    expect(after).toMatch(/\n\t"hooks": \{\n\t\t"SessionStart"/);
  });

  it('does not normalize an untouched multi-line empty array', async () => {
    const orig = '{\n  "permissions": {\n    "deny": [\n    ]\n  }\n}\n';
    await writeSettings(orig);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    const after = await read();
    // the user's hand-formatted empty array survives (would collapse to [] under JSON.stringify)
    expect(after).toContain('"deny": [\n    ]');
  });

  it('install then uninstall round-trips a user settings.json byte-for-byte', async () => {
    const orig = '{\n  "permissions": {\n    "allow": [\n      "Read",\n      "Bash(*)"\n    ],\n    "deny": [\n    ]\n  }\n}\n';
    await writeSettings(orig);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(await read()).not.toBe(orig); // hook was added
    await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    expect(await read()).toBe(orig); // byte-identical after removal
  });
});

// ============================================================================
// StandingInstructionsStayShort (cli spec, change: trim-standing-agent-instructions).
// The managed block is loaded on every turn, once per scope, so it stays short.
// ============================================================================
const MAX_BLOCK_LINES = 8;
const MAX_BLOCK_BYTES = 700;

function blockSizeProblems(block: string): string[] {
  const body = block.trimEnd();
  const problems: string[] = [];
  const lines = body.split('\n').length;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (lines > MAX_BLOCK_LINES) problems.push(`${lines} lines (max ${MAX_BLOCK_LINES})`);
  if (bytes > MAX_BLOCK_BYTES) problems.push(`${bytes} bytes (max ${MAX_BLOCK_BYTES})`);
  return problems;
}

/** The text between the managed markers, without the fingerprint line. */
function managedBody(file: string): string {
  const block = extractBlock(file);
  expect(block, 'file holds a managed block').not.toBeNull();
  return block!.inner.replace(/^\n?<!-- openlore-fingerprint: [0-9a-f]+ -->\n/, '').trimEnd();
}

describe('the managed instruction block stays short', () => {
  const template = () => readFile(join(process.cwd(), 'src/cli/install/templates/agent-instructions.md'), 'utf8');
  const presets: Array<[string, ReadonlySet<string> | null]> = [
    ...Object.entries(TOOL_PRESETS) as Array<[string, ReadonlySet<string>]>,
    [FULL_PRESET, null],
  ];

  it('is 8 lines and 700 bytes or fewer for every preset', async () => {
    const tpl = await template();
    for (const [preset, tools] of presets) {
      expect(blockSizeProblems(renderInstructionBlock(tpl, preset, tools)), preset).toEqual([]);
    }
  });

  it('fails the guard when the block gains one more line', async () => {
    const atLimit = Array.from({ length: MAX_BLOCK_LINES }, () => 'x').join('\n');
    expect(blockSizeProblems(atLimit)).toEqual([]);
    expect(blockSizeProblems(`${atLimit}\nx`)).toEqual([`${MAX_BLOCK_LINES + 1} lines (max ${MAX_BLOCK_LINES})`]);
    expect(blockSizeProblems('x'.repeat(MAX_BLOCK_BYTES + 1))).toEqual([`${MAX_BLOCK_BYTES + 1} bytes (max ${MAX_BLOCK_BYTES})`]);
  });

  it('writes the same LF block from a CRLF checkout', async () => {
    const tpl = await template();
    const crlf = tpl.split('\n').join('\r\n');
    expect(crlf).toContain('\r\n');
    const block = renderInstructionBlock(crlf, 'substrate', TOOL_PRESETS.substrate);
    expect(block).not.toContain('\r');
    expect(block).toBe(renderInstructionBlock(tpl, 'substrate', TOOL_PRESETS.substrate));
  });

  it('names the orient tool only where the wired preset exposes it', async () => {
    const tpl = await template();
    for (const [preset, tools] of presets) {
      const block = renderInstructionBlock(tpl, preset, tools);
      expect(block, preset).not.toContain('{{orient}}');
      expect(block.includes('the `orient` tool'), preset).toBe(tools === null || tools.has('orient'));
      expect(block, preset).toContain('`openlore orient "<task>"`');
      expect(block, preset).toContain(`Wired MCP surface: \`${preset}\``);
    }
    // `configuration` is the one preset without orient: the block names the CLI only.
    expect(TOOL_PRESETS.configuration.has('orient')).toBe(false);
  });

  it('says what the proposal requires and nothing about the old tool tour', async () => {
    const block = renderInstructionBlock(await template(), 'substrate', TOOL_PRESETS.substrate);
    expect(block).toContain('stay silent when they have nothing new');
    expect(block).toContain('openlore decisions record');
    expect(block).toContain('.openlore/analysis/CODEBASE.md');
    expect(block).not.toContain('@.openlore');
    expect(block).not.toMatch(/Decision autopilot|governance.*autopilot/);
  });
});

describe('install writes the short block in both scopes', () => {
  let dir: string;
  let home: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-short-block-'));
    home = await mkdtemp(join(tmpdir(), 'openlore-short-block-home-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('writes the same short block to the project and the user CLAUDE.md', async () => {
    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);
    const tpl = await readFile(join(process.cwd(), 'src/cli/install/templates/agent-instructions.md'), 'utf8');
    const expected = renderInstructionBlock(tpl, 'substrate', TOOL_PRESETS.substrate).trimEnd();
    for (const file of [join(dir, 'CLAUDE.md'), join(home, '.claude', 'CLAUDE.md')]) {
      const body = managedBody(await readFile(file, 'utf8'));
      expect(body, file).toBe(expected);
      expect(blockSizeProblems(body), file).toEqual([]);
    }
  });

  it('a re-install replaces an old long block inside its markers and keeps the text around it', async () => {
    // The block an older version wrote: its own fingerprint, so it is not a hand edit.
    const oldBody = [
      'This project uses OpenLore for persistent architectural memory.',
      '',
      'Call `orient "<task description>"` (via the openlore MCP server, or',
      '`npx openlore orient --json`) **before touching a module you have not yet read in',
      'this session**, and when a task spans several modules.',
      '',
      'Wired MCP surface: `substrate`. This guidance is written for that surface; re-run `openlore install --preset <name>` to change it and regenerate these instructions.',
    ].join('\n');
    const userAbove = '# My project\n\n@.openlore/analysis/CODEBASE.md\n\n';
    const userBelow = '\n\n## My notes\nkeep me\n';
    await writeFile(join(dir, 'CLAUDE.md'), `${userAbove}${renderBlock(oldBody)}${userBelow}`);

    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home, repoOnly: true })).toBe(0);
    const after = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).not.toContain('persistent architectural memory');
    expect(after.startsWith(userAbove)).toBe(true);
    expect(after.endsWith(userBelow)).toBe(true);
    expect(blockSizeProblems(managedBody(after))).toEqual([]);
    expect(managedBody(after)).toContain('stay silent when they have nothing new');
    expect(after).not.toContain('This project uses OpenLore for');
  });
});
