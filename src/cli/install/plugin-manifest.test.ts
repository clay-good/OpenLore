/**
 * The Claude Code plugin in plugin/ is static JSON, so nothing else fails when it drifts from the
 * CLI it launches. These checks keep it consistent with itself, with the hooks `openlore install`
 * wires, and with the plugin directory's review rules that a test can see without the network.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MANAGED_HOOKS } from './adapters/claude-code.js';
import { LEAN_DEFAULT_PRESET } from '../../constants.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PLUGIN = join(ROOT, 'plugin');
const LAUNCHER = '${CLAUDE_PLUGIN_ROOT}/runtime/openlore.mjs';

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

interface PluginHook { type: string; command: string; args: string[]; timeout?: number }

function pluginHooks(): Array<{ event: string; matcher?: string; hook: PluginHook }> {
  const { hooks } = readJson(join(PLUGIN, 'hooks', 'hooks.json'));
  return Object.entries(hooks as Record<string, Array<{ matcher?: string; hooks: PluginHook[] }>>)
    .flatMap(([event, groups]) => groups.flatMap((group) =>
      group.hooks.map((hook) => ({ event, matcher: group.matcher, hook }))));
}

describe('Claude Code plugin manifest', () => {
  it('pins one exact openlore version in plugin.json, package.json, and the lockfile', () => {
    const manifest = readJson(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    const pin = readJson(join(PLUGIN, 'runtime', 'package.json')).dependencies.openlore;
    const lock = readJson(join(PLUGIN, 'runtime', 'package-lock.json'));

    expect(pin).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(manifest.version).toBe(pin);
    expect(lock.packages[''].dependencies.openlore).toBe(pin);
    expect(lock.packages['node_modules/openlore'].version).toBe(pin);
  });

  it('runs every hook in exec form through the launcher, with no shell and no other variable', () => {
    const hooks = pluginHooks();
    expect(hooks.length).toBeGreaterThan(0);
    for (const { hook } of hooks) {
      expect(hook.type).toBe('command');
      expect(hook.command).toBe('node');
      expect(hook.args[0]).toBe(LAUNCHER);
      for (const arg of hook.args.slice(1)) expect(arg).toMatch(/^[a-z-]+$/);
      // The hook timeout must leave room under Claude Code's own cap for UserPromptSubmit (30 s).
      expect(hook.timeout).toBeLessThanOrEqual(90);
    }
  });

  it('wires only hook moments that `openlore install` also wires', () => {
    const installed = MANAGED_HOOKS.map((def) => `${def.key} ${def.args.join(' ')} ${def.matcher ?? ''}`);
    for (const { event, matcher, hook } of pluginHooks()) {
      const args = hook.args.slice(1).join(' ');
      const def = MANAGED_HOOKS.find((d) => d.key === event && d.args.join(' ') === args);
      expect(def, `${event} ${args} is not an install-wired moment (${installed.join('; ')})`).toBeDefined();
      if (def?.matcher) expect(matcher).toBe(def.matcher);
    }
    const userPrompt = pluginHooks().find(({ event }) => event === 'UserPromptSubmit');
    expect(userPrompt?.hook.timeout).toBeLessThan(30);
  });

  it('starts the MCP server on the default preset through the launcher', () => {
    const { mcpServers } = readJson(join(PLUGIN, '.mcp.json'));
    expect(mcpServers.openlore).toEqual({ command: 'node', args: [LAUNCHER, 'mcp', '--preset', LEAN_DEFAULT_PRESET] });
  });

  it('keeps package.json out of the plugin root, so Claude Code does not install 1.6 GB under its 60 s limit', () => {
    // The launcher installs a lean runtime into ${CLAUDE_PLUGIN_DATA} instead (plugin/runtime/openlore.mjs).
    expect(() => statSync(join(PLUGIN, 'package.json'))).toThrow();
    expect(() => statSync(join(PLUGIN, 'package-lock.json'))).toThrow();
  });

  it('is listed by the self-hosted marketplace', () => {
    const marketplace = readJson(join(ROOT, '.claude-plugin', 'marketplace.json'));
    const entry = marketplace.plugins.find((p: { name: string }) => p.name === 'openlore');
    expect(entry.source).toBe('./plugin');
    expect(readJson(join(PLUGIN, '.claude-plugin', 'plugin.json')).name).toBe(entry.name);
  });

  it('meets the plugin directory file rules: README, license, icon, and no file a reviewer must hold', () => {
    const words = readFileSync(join(PLUGIN, 'README.md'), 'utf8').split(/\s+/).filter(Boolean);
    expect(words.length).toBeGreaterThanOrEqual(40);
    expect(statSync(join(PLUGIN, 'LICENSE')).isFile()).toBe(true);
    // The directory takes a square PNG of 512 to 2048 px, under 2 MB. Images are exempt from the 256 KiB hold.
    expect(statSync(join(PLUGIN, '.claude-plugin', 'icon.png')).size).toBeLessThan(2 * 1024 * 1024);
    for (const file of filesUnder(PLUGIN)) {
      if (file.endsWith('.png')) continue;
      expect(statSync(file).size, relative(PLUGIN, file)).toBeLessThan(256 * 1024);
    }
  });

  it('is committed in full: no plugin file is ignored by git', () => {
    // The root .gitignore ignores `.mcp.json` everywhere; a git-hosted install would ship without the MCP server.
    const files = filesUnder(PLUGIN).map((file) => relative(ROOT, file));
    const ignored = spawnSync('git', ['check-ignore', '--no-index', ...files], { cwd: ROOT, encoding: 'utf8' });
    expect(ignored.stdout.trim()).toBe('');
  });
});
