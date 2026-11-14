#!/usr/bin/env node
/**
 * Launcher for the OpenLore Claude Code plugin. Every hook and the MCP server start here:
 *
 *   node ${CLAUDE_PLUGIN_ROOT}/runtime/openlore.mjs <openlore CLI arguments>
 *
 * The plugin folder holds no runtime. On first use this installs the pinned `openlore` npm
 * package into ${CLAUDE_PLUGIN_DATA}/runtime/<version>/ (one detached `npm install`, once per
 * version) and then runs the CLI from there, in this process.
 *
 * Why not the plugin's own package.json: Claude Code then installs every optional dependency
 * (1.6 GB) under a 60 s limit, which fails on Windows. Here the embeddings and viewer packages,
 * which the plugin never uses, are left out, and no time limit applies.
 *
 * Rules: a hook never fails and never waits for the install (it exits 0, silent or with one
 * line); only the MCP server waits. Node built-ins only; this file runs before any install.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_FLOOR = [22, 22];
/** openlore's optional packages the plugin never uses: local embeddings and the graph viewer. */
const NOT_INSTALLED = new Set(['@huggingface/transformers', '@vitejs/plugin-react', 'react', 'react-dom', 'vite']);
const LOCK_STALE_MS = 15 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const MCP_WAIT_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const isInstall = args[0] === '--install';
const isMcp = args[0] === 'mcp';
/** The two hooks whose plain stdout Claude Code adds to the agent's context. */
const speaksToAgent = args[0] === 'orient';

const pin = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).dependencies.openlore;
const dataDir = process.env.CLAUDE_PLUGIN_DATA;
const runtimeRoot = dataDir ? join(dataDir, 'runtime') : undefined;
const runtimeDir = runtimeRoot ? join(runtimeRoot, pin) : undefined;
const lockDir = runtimeDir ? `${runtimeDir}.lock` : undefined;
const failureFile = runtimeDir ? `${runtimeDir}.failed` : undefined;
const logFile = dataDir ? join(dataDir, 'install.log') : undefined;
const cliPath = runtimeDir ? join(runtimeDir, 'node_modules', 'openlore', 'dist', 'cli', 'index.js') : undefined;

const isReady = () => existsSync(join(runtimeDir, '.ready'));
const say = (line) => { if (speaksToAgent) process.stdout.write(`[OpenLore] ${line}\n`); };

function nodeTooOld() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major < NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor < NODE_FLOOR[1]);
}

/** Does a Claude settings file already carry hooks that `openlore install` wrote? */
function hasCliHooks(path) {
  try {
    const hooks = JSON.parse(readFileSync(path, 'utf8')).hooks ?? {};
    return Object.values(hooks).some((groups) => Array.isArray(groups)
      && groups.some((group) => group && (group._openlore || group._openloreHook)));
  } catch {
    return false;
  }
}

/** `openlore install` wired this user or project: its hooks run, so the plugin's stay silent. */
function cliWiringPresent() {
  const userDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const projectDir = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), '.claude');
  return [join(userDir, 'settings.json'), join(projectDir, 'settings.json'), join(projectDir, 'settings.local.json')]
    .some(hasCliHooks);
}

async function runCli() {
  process.argv = [process.argv[0], cliPath, ...args];
  await import(pathToFileURL(cliPath).href);
}

/** Start the one-time install in a detached process. Returns false when one is already running. */
function startInstall() {
  mkdirSync(runtimeRoot, { recursive: true });
  try {
    if (Date.now() - statSync(failureFile).mtimeMs < RETRY_AFTER_FAILURE_MS) return false;
  } catch { /* no earlier failure */ }
  try {
    mkdirSync(lockDir);
  } catch {
    try {
      if (Date.now() - statSync(lockDir).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
    } catch {
      return false;
    }
  }
  const log = openSync(logFile, 'a');
  spawn(process.execPath, [fileURLToPath(import.meta.url), '--install'], {
    detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env,
  }).unref();
  closeSync(log);
  return true;
}

function lastFailure() {
  try { return readFileSync(failureFile, 'utf8').trim(); } catch { return undefined; }
}

/** The packages to add on top of `npm install --omit=optional`, at the lockfile's versions. */
function extraPackages() {
  const { packages } = JSON.parse(readFileSync(join(HERE, 'package-lock.json'), 'utf8'));
  const versionOf = (name) => (packages[`node_modules/openlore/node_modules/${name}`] ?? packages[`node_modules/${name}`])?.version;
  const extras = Object.keys(packages['node_modules/openlore'].optionalDependencies ?? {})
    .filter((name) => !NOT_INSTALLED.has(name) && versionOf(name))
    .map((name) => `${name}@${versionOf(name)}`);
  // LanceDB's native binding is an optional package per platform; take the one for this machine.
  const libc = process.platform === 'linux'
    ? (process.report?.getReport?.().header?.glibcVersionRuntime ? 'glibc' : 'musl')
    : undefined;
  for (const [path, entry] of Object.entries(packages)) {
    const name = path.slice('node_modules/'.length);
    if (!name.startsWith('@lancedb/lancedb-')) continue;
    if (!entry.os?.includes(process.platform) || !entry.cpu?.includes(process.arch)) continue;
    if (entry.libc && libc && !entry.libc.includes(libc)) continue;
    extras.push(`${name}@${entry.version}`);
  }
  return extras;
}

/** Run npm without a shell where possible: the npm that ships beside this node binary. */
function npmInstall(cwd, packages) {
  const npmArgs = ['install', '--omit=optional', '--ignore-scripts', '--no-save', '--legacy-peer-deps',
    '--no-audit', '--no-fund', '--loglevel=error', ...packages];
  const nodeDir = dirname(process.execPath);
  const npmCli = [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((path) => existsSync(path));
  const options = { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, npm_config_update_notifier: 'false' } };
  return npmCli
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], options)
    : spawnSync('npm', npmArgs, { ...options, shell: process.platform === 'win32' });
}

function install() {
  const staging = `${runtimeDir}.tmp-${process.pid}`;
  const started = Date.now();
  try {
    if (isReady()) return;
    console.log(`[${new Date().toISOString()}] installing openlore@${pin} into ${runtimeDir}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(HERE, file), join(staging, file));
    const result = npmInstall(staging, extraPackages());
    if (result.error) throw new Error(`npm did not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`npm install exited with ${result.status}`);
    if (!existsSync(join(staging, 'node_modules', 'openlore', 'dist', 'cli', 'index.js'))) {
      throw new Error('npm install finished without the openlore package');
    }
    writeFileSync(join(staging, '.ready'), `${new Date().toISOString()}\n`);
    // Windows can hold a new folder briefly (indexer, antivirus); a rename then fails with EPERM.
    for (let attempt = 0; ; attempt += 1) {
      try { renameSync(staging, runtimeDir); break; } catch (error) {
        if (isReady()) break;
        if (attempt >= 20) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    }
    rmSync(failureFile, { force: true });
    // Older runtime versions, and what a stopped install left behind.
    for (const entry of readdirSync(runtimeRoot)) {
      if (entry !== pin && entry !== `${pin}.lock`) rmSync(join(runtimeRoot, entry), { recursive: true, force: true });
    }
    console.log(`[${new Date().toISOString()}] installed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    console.log(`[${new Date().toISOString()}] install failed: ${error.message}`);
    try { writeFileSync(failureFile, `${error.message}\n`); } catch { /* the log has it */ }
    rmSync(staging, { recursive: true, force: true });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!runtimeDir) return; // Not started by Claude Code as a plugin: nothing to run from.
  if (isInstall) return install();
  if (!isMcp && cliWiringPresent()) return;
  if (isReady()) return runCli();

  if (nodeTooOld()) {
    return say(`Not running: Node.js ${process.versions.node} is older than ${NODE_FLOOR.join('.')}. Update Node.js to use OpenLore.`);
  }
  const started = startInstall();
  if (!isMcp) {
    const failure = started || existsSync(lockDir) ? undefined : lastFailure();
    return say(failure
      ? `Not running: its one-time runtime install failed (${failure}). It retries later; details in ${logFile}.`
      : 'First use: installing its runtime in the background (one or two minutes). Briefings start when it finishes.');
  }
  // The MCP server has no useful answer without the runtime, so it waits. It leaves stdin unread
  // (the client's first message must reach the real server) and stops if its parent is gone.
  const parent = process.ppid;
  const deadline = Date.now() + MCP_WAIT_MS;
  while (!isReady()) {
    if (process.ppid !== parent) process.exit(0);
    if (Date.now() > deadline || (lastFailure() && !existsSync(lockDir))) {
      process.stderr.write(`[OpenLore] runtime install did not finish: ${lastFailure() ?? 'timed out'}. See ${logFile}.\n`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return runCli();
}

try {
  await main();
} catch (error) {
  // A hook must never break the agent's turn. The MCP server may fail visibly.
  process.stderr.write(`[OpenLore] ${error?.message ?? error}\n`);
  if (isMcp) process.exit(1);
}
