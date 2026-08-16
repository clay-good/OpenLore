/**
 * Capability Declaration and Accepted-Risk Register (spec: openspec/specs/mcp-security/spec.md).
 *
 * Validates schemas/security-capabilities.json — the machine-readable declaration
 * of the server's security-relevant capabilities — for shape, and keeps it in
 * sync with the code: every declared capability must be exercised by real code,
 * and no undeclared security-relevant capability (shell execution, novel egress)
 * may exist on the scanned server surface.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');
const DECL_PATH = join(REPO_ROOT, 'schemas', 'security-capabilities.json');

const decl = JSON.parse(readFileSync(DECL_PATH, 'utf-8'));

function surfaceSources(): string[] {
  const out: string[] = [];
  for (const d of ['core', 'cli'].map(x => join(SRC, x))) {
    for (const f of readdirSync(d, { recursive: true, encoding: 'utf-8' })) {
      if (extname(f) === '.ts' && !f.includes('.test.')) out.push(join(d, f));
    }
  }
  return out;
}
const SURFACE = surfaceSources();
function surfaceText(): string {
  return SURFACE.map(f => readFileSync(f, 'utf-8')).join('\n');
}

describe('Capability declaration — shape (mcp-security)', () => {
  it('declares the required security-relevant capability categories', () => {
    expect(decl.tool).toBe('openlore');
    expect(decl.capabilities).toBeTruthy();
    for (const k of ['filesystem', 'subprocess', 'network', 'credentials', 'localDaemon']) {
      expect(decl.capabilities[k], `missing capabilities.${k}`).toBeTruthy();
    }
    expect(Array.isArray(decl.capabilities.filesystem.reads)).toBe(true);
    expect(Array.isArray(decl.capabilities.filesystem.writes)).toBe(true);
    expect(Array.isArray(decl.capabilities.network.allowedHosts)).toBe(true);
  });

  it('every accepted-risk entry names a source->sink pattern and justifies it', () => {
    expect(Array.isArray(decl.acceptedRisks)).toBe(true);
    expect(decl.acceptedRisks.length).toBeGreaterThan(0);
    for (const r of decl.acceptedRisks) {
      expect(r.id, 'risk entry needs an id').toBeTruthy();
      expect(r.pattern, `risk ${r.id} needs a source->sink pattern`).toMatch(/->/);
      expect(typeof r.why === 'string' && r.why.length > 20, `risk ${r.id} needs a real justification`).toBe(true);
    }
  });
});

describe('Capability declaration — matches observed behavior (mcp-security)', () => {
  it('declared subprocess spawns are exercised by real code (git)', () => {
    const bins = decl.capabilities.subprocess.spawns.map((s: { bin: string }) => s.bin);
    expect(bins.some((b: string) => b === 'git')).toBe(true);
    // git is genuinely spawned somewhere on the surface.
    expect(surfaceText()).toMatch(/(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"`]git['"`]/);
  });

  it('declared egress hosts include the real configured-provider defaults', () => {
    const chatAgent = readFileSync(join(SRC, 'core', 'services', 'chat-agent.ts'), 'utf-8');
    const declared: string[] = decl.capabilities.network.allowedHosts;
    for (const host of ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com']) {
      expect(chatAgent, `provider default ${host} should exist in code`).toContain(host);
      expect(declared, `declaration must list provider host ${host}`).toContain(host);
    }
    // Loopback is declared (the local serve transport).
    expect(declared).toContain('127.0.0.1');
  });

  it('the no-shell claim holds: no shell:true / shell-binary on the core+cli surface', () => {
    // The declaration asserts argv-only subprocess on the server surface; verify it.
    const offenders: string[] = [];
    const SHELL_INVOKE = /(?:exec|execFile|execFileSync|spawn|spawnSync)\(\s*['"`](?:\/bin\/)?(?:sh|bash|zsh|dash)['"`]\s*,\s*\[\s*['"`]-c['"`]/;
    for (const f of SURFACE) {
      const src = readFileSync(f, 'utf-8');
      if (/shell\s*:\s*true/.test(src) || SHELL_INVOKE.test(src)) offenders.push(f.replace(SRC, 'src'));
    }
    expect(offenders, `declaration claims no shell on surface, but found: ${offenders.join(', ')}`).toEqual([]);
  });

  it('does not retain the removed Windows shell-launcher accepted risk', () => {
    const entry = decl.acceptedRisks.find((r: { id: string }) => r.id === 'windows-extension-launcher-shell');
    expect(entry).toBeUndefined();
    const piExt = readFileSync(join(SRC, 'pi', 'extension.ts'), 'utf-8');
    expect(piExt).not.toMatch(/shell\s*:\s*true/);
  });
});
