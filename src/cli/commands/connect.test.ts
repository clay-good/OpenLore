/**
 * `openlore connect` + the install-engine enhancements it relies on.
 * (change: add-agent-onboarding-connect)
 *
 * Guards the cli-spec requirements: PresetAwareConnect, CapabilityGatedWiring
 * (permission), OneCommandAgentConnect (delegation + status). Plain .test.ts so
 * CI runs it. No interactive prompt is exercised (non-TTY → detection fallback).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, surfaceStatus } from '../install/index.js';
import { runConnect } from './connect.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openlore-connect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (rel: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, rel), 'utf8'));
const exists = async (rel: string): Promise<boolean> => {
  try { await access(join(dir, rel)); return true; } catch { return false; }
};

describe('install --preset (PresetAwareConnect)', () => {
  it('wires `openlore mcp --preset <name>` into .mcp.json when a preset is given', async () => {
    const code = await runInstall({ agent: 'claude-code', preset: 'memory', analyze: false, cwd: dir });
    expect(code).toBe(0);
    const mcp = await readJson('.mcp.json');
    expect((mcp.mcpServers as Record<string, { args: string[] }>).openlore.args).toEqual([
      '--yes', 'openlore', 'mcp', '--preset', 'memory',
    ]);
  });

  // change: default-to-lean-tool-surface — no preset now wires the lean navigation
  // default surface explicitly, not the bare (formerly full) server.
  it('wires the lean navigation default when no preset is given', async () => {
    await runInstall({ agent: 'claude-code', analyze: false, cwd: dir });
    const mcp = await readJson('.mcp.json');
    expect((mcp.mcpServers as Record<string, { args: string[] }>).openlore.args).toEqual([
      '--yes', 'openlore', 'mcp', '--preset', 'navigation',
    ]);
  });

  it('wires the full surface on explicit --preset full', async () => {
    await runInstall({ agent: 'claude-code', preset: 'full', analyze: false, cwd: dir });
    const mcp = await readJson('.mcp.json');
    expect((mcp.mcpServers as Record<string, { args: string[] }>).openlore.args).toEqual([
      '--yes', 'openlore', 'mcp', '--preset', 'full',
    ]);
  });

  // change: default-to-lean-tool-surface — connect accepts --all-tools (alias of
  // --preset full), matching `openlore mcp --all-tools`; it was previously an
  // unknown-option error on connect/install while mcp accepted it.
  it('wires the full surface on --all-tools (alias of --preset full)', async () => {
    await runInstall({ agent: 'claude-code', allTools: true, analyze: false, cwd: dir });
    const mcp = await readJson('.mcp.json');
    expect((mcp.mcpServers as Record<string, { args: string[] }>).openlore.args).toEqual([
      '--yes', 'openlore', 'mcp', '--preset', 'full',
    ]);
  });

  it('rejects an unknown preset with exit 2 and writes nothing', async () => {
    const code = await runInstall({ agent: 'claude-code', preset: 'bogus', analyze: false, cwd: dir });
    expect(code).toBe(2);
    expect(await exists('.mcp.json')).toBe(false);
  });
});

describe('connect --yes (zero-interaction)', () => {
  it('wires detected agents with no prompt when --yes is passed', async () => {
    // A claude-code marker so detection has something to find.
    await mkdir(join(dir, '.claude'), { recursive: true });
    const code = await runConnect(undefined, { yes: true, analyze: false, cwd: dir });
    expect(code).toBe(0);
    // The MCP server was wired without any interactive picker.
    expect(await exists('.mcp.json')).toBe(true);
    const mcp = await readJson('.mcp.json');
    expect((mcp.mcpServers as Record<string, { args: string[] }>).openlore.args).toEqual([
      '--yes', 'openlore', 'mcp', '--preset', 'navigation',
    ]);
  });
});

describe('claude-code permission wiring (CapabilityGatedWiring)', () => {
  it('adds Bash(openlore:*) to settings.local.json, idempotently', async () => {
    await runConnect('claude-code', { analyze: false, cwd: dir });
    let local = await readJson('.claude/settings.local.json');
    let allow = (local.permissions as { allow: string[] }).allow;
    expect(allow).toContain('Bash(openlore:*)');

    // Re-run: still exactly one — no duplicate.
    await runConnect('claude-code', { analyze: false, cwd: dir });
    local = await readJson('.claude/settings.local.json');
    allow = (local.permissions as { allow: string[] }).allow;
    expect(allow.filter((p) => p === 'Bash(openlore:*)')).toHaveLength(1);
  });

  it('preserves a permission the user already had', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, '.claude/settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2),
      'utf8',
    );
    await runConnect('claude-code', { analyze: false, cwd: dir });
    const allow = ((await readJson('.claude/settings.local.json')).permissions as { allow: string[] }).allow;
    expect(allow).toContain('Read');
    expect(allow).toContain('Bash(openlore:*)');
  });

  it('removes the permission on uninstall (deleting the now-empty file)', async () => {
    await runConnect('claude-code', { analyze: false, cwd: dir });
    expect(await exists('.claude/settings.local.json')).toBe(true);
    await runInstall({ agent: 'claude-code', uninstall: true, analyze: false, cwd: dir });
    // File was OpenLore-only ⇒ removed; permission is gone either way.
    let allow: string[] = [];
    if (await exists('.claude/settings.local.json')) {
      const perms = (await readJson('.claude/settings.local.json')).permissions as { allow?: string[] } | undefined;
      allow = perms?.allow ?? [];
    }
    expect(allow).not.toContain('Bash(openlore:*)');
  });

  it('keeps the user permission file when uninstall strips only our entry', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, '.claude/settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2),
      'utf8',
    );
    await runConnect('claude-code', { analyze: false, cwd: dir });
    await runInstall({ agent: 'claude-code', uninstall: true, analyze: false, cwd: dir });
    const allow = ((await readJson('.claude/settings.local.json')).permissions as { allow: string[] }).allow;
    expect(allow).toEqual(['Read']);
  });
});

describe('connect delegation + status (OneCommandAgentConnect)', () => {
  it('connect <agent> delegates to the install engine (markdown agent gets the managed block)', async () => {
    const code = await runConnect('cursor', { analyze: false, cwd: dir });
    expect(code).toBe(0);
    const rules = await readFile(join(dir, '.cursorrules'), 'utf8');
    expect(rules).toContain('BEGIN OPENLORE');
    expect(rules).toMatch(/openlore/i);
  });

  it('surfaceStatus reports connected only after wiring', async () => {
    const before = await surfaceStatus(dir);
    expect(before.find((s) => s.agent === 'claude-code')!.connected).toBe(false);

    await runConnect('claude-code', { analyze: false, cwd: dir });
    const after = await surfaceStatus(dir);
    expect(after.find((s) => s.agent === 'claude-code')!.connected).toBe(true);
  });

  it('connect remove disconnects (block stripped, server entry removed)', async () => {
    await runConnect('claude-code', { analyze: false, cwd: dir });
    expect(await exists('.mcp.json')).toBe(true);
    await runInstall({ agent: 'claude-code', uninstall: true, analyze: false, cwd: dir });
    expect(await exists('.mcp.json')).toBe(false); // was OpenLore-only
    const status = await surfaceStatus(dir);
    expect(status.find((s) => s.agent === 'claude-code')!.connected).toBe(false);
  });
});
