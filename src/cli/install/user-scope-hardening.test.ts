/**
 * Hardening of the user-scope install footprint (change: unify-onboarding-entrypoint).
 *
 * Every case here is a defect found by adversarial review of the first draft, where
 * `~/.claude.json` — Claude Code's own live account state — was being edited by a
 * write path built for a file OpenLore owns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from './index.js';
import { claudeCodeAdapter, _publishManagedFileForTesting } from './adapters/claude-code.js';
import type { ApplyContext } from './adapters/types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('user-scope hardening', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-hard-repo-'));
    home = await mkdtemp(join(tmpdir(), 'openlore-hard-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const install = (extra: Record<string, unknown> = {}) =>
    runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home, ...extra });

  describe('a config it cannot parse is a config it does not touch', () => {
    it('refuses a byte-order-marked ~/.claude.json instead of replacing it', async () => {
      const original = '﻿' + JSON.stringify({ numStartups: 3, projects: { a: {} } }, null, 2);
      await writeFile(join(home, '.claude.json'), original);

      expect(await install()).toBe(0); // a user-scope refusal never fails the command

      expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(original);
      // Nothing else in the user scope was written either — a refusal must not
      // leave the scope half-wired.
      expect(await exists(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
      expect(await exists(join(home, '.claude', 'settings.json'))).toBe(false);
      // The repository was still wired.
      expect(await exists(join(dir, '.mcp.json'))).toBe(true);
    });

    it('refuses a JSONC ~/.claude/settings.json instead of replacing it', async () => {
      const original = '{\n  // my settings\n  "model": "opus"\n}\n';
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(join(home, '.claude', 'settings.json'), original);

      expect(await install()).toBe(0);

      expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe(original);
      expect(await exists(join(home, '.claude.json'))).toBe(false);
    });

    it('still refuses in the repo scope, and there it fails the command', async () => {
      await writeFile(join(dir, '.mcp.json'), '{ /* comment */ }');
      expect(await install({ repoOnly: true })).toBe(1);
      expect(await readFile(join(dir, '.mcp.json'), 'utf8')).toBe('{ /* comment */ }');
    });
  });

  describe('a user-scope problem never breaks install everywhere', () => {
    it('a hand-edited user block warns but still wires and exits 0', async () => {
      await install();
      const mdPath = join(home, '.claude', 'CLAUDE.md');
      const tampered = (await readFile(mdPath, 'utf8')).replace('OpenLore', 'OpenLore (mine)');
      await writeFile(mdPath, tampered);
      await rm(join(dir, 'CLAUDE.md'), { force: true });
      await rm(join(dir, '.mcp.json'), { force: true });

      expect(await install()).toBe(0);
      expect(await exists(join(dir, '.mcp.json'))).toBe(true);
    });

    it('a symlinked ~/.claude does not abort the command, and nothing escapes through it', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'openlore-outside-'));
      try {
        await symlink(outside, join(home, '.claude'), 'dir');

        expect(await install()).toBe(0);
        // The repository is wired regardless of what the user scope decided.
        expect(await exists(join(dir, '.mcp.json'))).toBe(true);
        // And whatever it decided, no OpenLore file landed outside the home root
        // by way of the symlink.
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('files OpenLore did not create are not OpenLore\'s to delete', () => {
    it('keeps ~/.claude/settings.json on uninstall', async () => {
      await install();
      await install({ uninstall: true });
      expect(await exists(join(home, '.claude', 'settings.json'))).toBe(true);
      expect(await exists(join(home, '.claude.json'))).toBe(true);
    });

    it('creates user-scope config readable only by its owner', async () => {
      await install();
      for (const p of [join(home, '.claude.json'), join(home, '.claude', 'settings.json')]) {
        expect((await stat(p)).mode & 0o077).toBe(0);
      }
    });
  });

  describe('uninstall does not depend on what happens to be in the current directory', () => {
    it('removes the user scope from a directory with no Claude marker', async () => {
      await install();
      const elsewhere = await mkdtemp(join(tmpdir(), 'openlore-elsewhere-'));
      try {
        await mkdir(join(elsewhere, '.cursor'), { recursive: true });
        expect(await runInstall({ cwd: elsewhere, analyze: false, home, uninstall: true })).toBe(0);
        const mcp = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
        expect(mcp.mcpServers?.openlore).toBeUndefined();
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });

    it('removes our MCP entry even after the managed marker is gone', async () => {
      await install();
      const path = join(home, '.claude.json');
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      delete parsed._openlore; // any tool that drops unknown top-level keys does this
      parsed.numStartups = 12;
      await writeFile(path, JSON.stringify(parsed, null, 2));

      await install({ uninstall: true });

      const after = JSON.parse(await readFile(path, 'utf8'));
      expect(after.mcpServers?.openlore).toBeUndefined();
      expect(after.numStartups).toBe(12);
    });

    it('leaves an MCP server that is not ours alone', async () => {
      await writeFile(
        join(home, '.claude.json'),
        JSON.stringify({ mcpServers: { openlore: { command: 'my-own-thing', args: ['serve'] } } }, null, 2),
      );
      await install({ uninstall: true });
      const after = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
      expect(after.mcpServers.openlore).toEqual({ command: 'my-own-thing', args: ['serve'] });
    });
  });

  describe('a concurrent writer wins; OpenLore refuses', () => {
    const ctxFor = (dryRun = false): ApplyContext => ({
      root: home,
      scope: 'user',
      platform: process.platform,
      platformCommandRuntime: {
        nodeExecutable: process.execPath,
        npmExecPath: undefined,
        pathValue: process.env.PATH,
        cwd: process.cwd(),
      },
      instructionTemplate: '# test\n',
      dryRun,
      force: false,
    });

    it('refuses when the file changed between being read and being written', async () => {
      const path = join(home, '.claude.json');
      const observed = JSON.stringify({ numStartups: 1 }, null, 2);
      await writeFile(path, observed);

      // The concurrent write lands after we captured `observed` — precisely the
      // window a running Claude Code writes in.
      const live = JSON.stringify({ numStartups: 2, sessionId: 'live' }, null, 2);
      await writeFile(path, live);

      const result = await _publishManagedFileForTesting(
        ctxFor(),
        path,
        JSON.stringify({ mcpServers: { openlore: {} } }, null, 2),
        observed,
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/another process changed it/);
      // The concurrent write survives intact — that is the whole point.
      expect(await readFile(path, 'utf8')).toBe(live);
    });

    it('publishes when nothing changed under it', async () => {
      const path = join(home, '.claude.json');
      const observed = JSON.stringify({ numStartups: 1 }, null, 2);
      await writeFile(path, observed);

      const next = JSON.stringify({ numStartups: 1, mcpServers: {} }, null, 2);
      const result = await _publishManagedFileForTesting(ctxFor(), path, next, observed);

      expect(result.ok).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(next);
    });

    it('refuses a symlink that points outside the scope root, and does not write through it', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'openlore-symlink-target-'));
      try {
        const victim = join(outside, 'real.json');
        await writeFile(victim, JSON.stringify({ notOurs: true }, null, 2));
        await symlink(victim, join(home, '.claude.json'));

        // Confinement catches this before any write: the link canonicalizes out of
        // the scope root. The adapter throws; `runInstall` contains it for the user
        // scope (asserted separately above) rather than writing through the link.
        await expect(claudeCodeAdapter.apply(ctxFor())).rejects.toThrow(/canonicalizes outside/);
        expect(JSON.parse(await readFile(victim, 'utf8'))).toEqual({ notOurs: true });
        expect(await exists(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses a symlink that stays inside the scope root, naming it as a link', async () => {
      const victim = join(home, 'real.json');
      await writeFile(victim, JSON.stringify({ notOurs: true }, null, 2));
      await symlink(victim, join(home, '.claude.json'));

      const result = await claudeCodeAdapter.apply(ctxFor());

      expect(result.conflict).toBe(true);
      expect(result.warnings.join(' ')).toMatch(/symbolic link|non-regular file/);
      expect(JSON.parse(await readFile(victim, 'utf8'))).toEqual({ notOurs: true });
      expect(await exists(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    });

    it('leaves no instruction block behind when a registration is refused', async () => {
      // The block tells an agent to call tools the MCP registration would have
      // wired. A refusal must not leave that claim on disk.
      await writeFile(join(home, '.claude.json'), '\uFEFF{}');
      const result = await claudeCodeAdapter.apply(ctxFor());
      expect(result.conflict).toBe(true);
      expect(await exists(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    });
  });
});
