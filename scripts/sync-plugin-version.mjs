#!/usr/bin/env node
/**
 * Pin the Claude Code plugin (plugin/) to a published openlore version.
 *
 * Usage: node scripts/sync-plugin-version.mjs [version]   (default: package.json's version)
 *
 * Run it AFTER that version is on npm: the plugin's lockfile records the published tarball's
 * integrity, so it cannot be written before the publish. It sets the exact `openlore` pin in
 * plugin/runtime/package.json, the same `version` in plugin/.claude-plugin/plugin.json (Claude Code
 * updates a plugin only when that string changes), and regenerates plugin/runtime/package-lock.json.
 * plugin-manifest.test.ts checks that the three agree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugin');
const runtimeDir = join(pluginDir, 'runtime');
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not an exact version: ${version}`);
  process.exit(1);
}

const editJson = (path, edit) => {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  edit(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
};

editJson(join(runtimeDir, 'package.json'), (pkg) => { pkg.dependencies.openlore = version; });
editJson(join(pluginDir, '.claude-plugin', 'plugin.json'), (manifest) => { manifest.version = version; });
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: runtimeDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
console.log(`plugin/ pinned to openlore@${version}`);
