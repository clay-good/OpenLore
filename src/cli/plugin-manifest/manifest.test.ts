/**
 * Guard: the shipped OpenSpec plugin manifest (the `"openspec"` key in
 * package.json) must stay valid and COHERENT with the package and the real CLI
 * surface. Mirrors the federation manifest's schema guard and the
 * mcp-tool-count-doc drift guard — it ties the manifest's prose to the code so a
 * silent divergence (a renamed bin, a dropped subcommand, a stale compat range)
 * fails CI instead of shipping a broken plugin. See the
 * project_mcp_tool_doc_count_drift failure mode this is modeled on.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPluginManifest, validatePluginManifest, type PluginManifest } from './manifest.js';

// Real, surfaced command objects — importing these constructs Command instances
// without running the CLI (only src/cli/index.ts calls .parse()). Their .name()
// is the live truth the manifest's help-only commands[] must match.
import { generateCommand } from '../commands/generate.js';
import { driftCommand } from '../commands/drift.js';
import { verifyCommand } from '../commands/verify.js';
import { analyzeCommand } from '../commands/analyze.js';
import { orientCommand } from '../commands/orient.js';
import { digestCommand } from '../commands/digest.js';
import { decisionsCommand } from '../commands/decisions.js';
import { changeStatusCommand } from '../commands/change-status.js';

// src/cli/plugin-manifest/<this> → repo root is three levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface PackageJson {
  name?: string;
  bin?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  openspec?: PluginManifest;
}
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as PackageJson;

// The live surface the manifest is allowed to declare as commands[].
const surfacedCommands = [
  generateCommand,
  driftCommand,
  verifyCommand,
  analyzeCommand,
  orientCommand,
  digestCommand,
  decisionsCommand,
  changeStatusCommand,
];
const realNames = new Set(surfacedCommands.map((c) => c.name()));

// Internal/experimental + host-owned-lifecycle commands that must NEVER be surfaced.
const EXCLUDED_FROM_MANIFEST = [
  'install',
  'connect',
  'setup',
  'mcp',
  'view',
  'serve',
  'telemetry',
  'panic-check',
  'gryph-watch',
];

describe('OpenSpec plugin manifest', () => {
  it('is published as the "openspec" key in package.json', () => {
    const manifest = readPluginManifest(repoRoot);
    expect(manifest, 'package.json must declare an "openspec" plugin manifest').not.toBeNull();
    expect(pkg.openspec).toBeDefined();
  });

  it('validates against the vendored plugin-manifest schema with no errors', () => {
    const errors = validatePluginManifest(pkg.openspec);
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
  });

  it('uses the reserved namespace "lore" and manifestVersion 1', () => {
    expect(pkg.openspec?.namespace).toBe('lore');
    expect(pkg.openspec?.manifestVersion).toBe(1);
  });

  it('declares a bin coherent with package.json#bin', () => {
    const bin = pkg.openspec?.bin;
    expect(bin, 'manifest must declare a bin').toBeTruthy();
    expect(Object.keys(pkg.bin ?? {}), `manifest bin "${bin}" must be a real package.json bin entry`).toContain(bin);
  });

  it('declares an id and displayName coherent with the package', () => {
    expect(pkg.openspec?.id).toBe(pkg.name);
    expect(pkg.openspec?.displayName).toBeTruthy();
    expect(pkg.openspec?.summary).toBeTruthy();
  });

  it('keeps openspecCompat coherent with the @fission-ai/openspec peer-dep range', () => {
    const peer = pkg.peerDependencies?.['@fission-ai/openspec'];
    expect(peer, '@fission-ai/openspec must be a declared peer dependency').toBeTruthy();
    expect(
      pkg.openspec?.openspecCompat,
      'openspecCompat must equal the @fission-ai/openspec peer-dep range (the canonical source)',
    ).toBe(peer);
  });

  it('surfaces only real OpenLore subcommands in commands[]', () => {
    for (const cmd of pkg.openspec?.commands ?? []) {
      expect(realNames.has(cmd.name), `manifest surfaces "${cmd.name}" which is not a real surfaced subcommand`).toBe(true);
      expect(cmd.summary, `commands[] entry "${cmd.name}" needs a summary`).toBeTruthy();
    }
  });

  it('does not surface internal/experimental or host-owned-lifecycle commands', () => {
    const surfaced = new Set((pkg.openspec?.commands ?? []).map((c) => c.name));
    for (const excluded of EXCLUDED_FROM_MANIFEST) {
      expect(surfaced.has(excluded), `manifest must not surface the excluded command "${excluded}"`).toBe(false);
    }
  });

  it('points every contributed skill at a real, package-relative source directory', () => {
    for (const skill of pkg.openspec?.skills ?? []) {
      // dir must be a single safe path segment (host containment rule).
      expect(skill.dir).not.toMatch(/[/\\]|\.\./);
      expect(skill.source).not.toMatch(/^([/\\]|\.\.)/);
      expect(existsSync(join(repoRoot, skill.source)), `skill source "${skill.source}" must exist in the package`).toBe(true);
    }
  });

  it('declares ownership of exactly the openlore config key', () => {
    expect(pkg.openspec?.ownsConfigKeys).toEqual(['openlore']);
  });
});

describe('validatePluginManifest containment + semantic rules', () => {
  const base = {
    manifestVersion: 1,
    id: 'x',
    namespace: 'x',
    bin: 'x',
    openspecCompat: '>=0.1.0',
  };

  it('rejects a traversing or multi-segment skill dir', () => {
    expect(validatePluginManifest({ ...base, skills: [{ dir: 'a/b', source: 'skills/x' }] }).some((e) => e.path === '/skills/0/dir')).toBe(true);
    expect(validatePluginManifest({ ...base, skills: [{ dir: '..', source: 'skills/x' }] }).some((e) => e.path === '/skills/0/dir')).toBe(true);
    expect(validatePluginManifest({ ...base, skills: [{ dir: 'a\\b', source: 'skills/x' }] }).some((e) => e.path === '/skills/0/dir')).toBe(true);
  });

  it('rejects an absolute or traversing skill source', () => {
    expect(validatePluginManifest({ ...base, skills: [{ dir: 'x', source: '/etc/passwd' }] }).some((e) => e.path === '/skills/0/source')).toBe(true);
    expect(validatePluginManifest({ ...base, skills: [{ dir: 'x', source: '../../x' }] }).some((e) => e.path === '/skills/0/source')).toBe(true);
    expect(validatePluginManifest({ ...base, skills: [{ dir: 'x', source: 'C:\\x' }] }).some((e) => e.path === '/skills/0/source')).toBe(true);
  });

  it('accepts a single-segment skill dir with a package-relative source', () => {
    expect(validatePluginManifest({ ...base, skills: [{ dir: 'openlore-orient', source: 'skills/openlore-orient' }] })).toEqual([]);
  });

  it('rejects a manifest with neither bin nor binArgs', () => {
    const noExec = { manifestVersion: 1, id: 'x', namespace: 'x', openspecCompat: '>=0.1.0' };
    expect(validatePluginManifest(noExec).some((e) => e.path === '/bin')).toBe(true);
    expect(validatePluginManifest({ ...noExec, binArgs: ['npx', 'openlore'] })).toEqual([]);
  });

  it('rejects a non-token namespace', () => {
    expect(validatePluginManifest({ ...base, namespace: 'Lore' }).some((e) => e.path === '/namespace')).toBe(true);
    expect(validatePluginManifest({ ...base, namespace: 'a/b' }).some((e) => e.path === '/namespace')).toBe(true);
    expect(validatePluginManifest({ ...base, namespace: '1lore' }).some((e) => e.path === '/namespace')).toBe(true);
  });
});
