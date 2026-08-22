#!/usr/bin/env node
/**
 * Drive the existing `openlore mcp` server over stdio JSON-RPC to call the
 * `orient` tool, then print its JSON output to stdout. Used by orient.sh /
 * orient.ps1 so the skill works today, against the currently shipped CLI
 * surface (no new subcommand required — see TODO(spec-02-followup) in
 * SKILL.md for context).
 *
 * Pure Node built-ins only. Spawns `npx --yes openlore mcp`, performs the
 * MCP initialize handshake, calls tools/call("orient", {task, directory}),
 * prints the result, and exits.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const task = process.argv[2];
const directory = process.argv[3] ?? process.cwd();

if (!task) {
  process.stderr.write('usage: orient-via-mcp.mjs "<task description>" [directory]\n');
  process.exit(2);
}

// This is a one-shot call (initialize → orient → exit), so the MCP server must
// NOT start its file watcher: auto-watch recursively watches the whole repo —
// including huge build dirs like Rust's target/ — and EMFILEs before we ever
// get a response. Pass --no-watch-auto, but only if this openlore build
// supports it: older versions error on unknown options. Detect via `mcp --help`.
const mcpArgs = ['--yes', 'openlore', 'mcp'];
const npxCommand = process.platform === 'win32' ? process.execPath : 'npx';
let npxArgs = [];
if (process.platform === 'win32') {
  const candidates = [];
  if (process.env.npm_execpath && isAbsolute(process.env.npm_execpath)) {
    candidates.push(join(dirname(process.env.npm_execpath), 'npx-cli.js'));
  }
  const cwd = resolve(process.cwd()).toLowerCase();
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir) || resolve(dir).toLowerCase() === cwd) continue;
    candidates.push(join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  const npxCli = [...new Set(candidates)].find((candidate) => existsSync(candidate));
  if (!npxCli) {
    process.stderr.write('orient-via-mcp: could not locate npx-cli.js in the Windows npm installation\n');
    process.exit(1);
  }
  npxArgs = [npxCli];
}
try {
  const help = spawnSync(npxCommand, [...npxArgs, '--yes', 'openlore', 'mcp', '--help'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if ((help.stdout ?? '').includes('--no-watch-auto')) {
    mcpArgs.push('--no-watch-auto');
  }
} catch {
  // If detection fails, fall through without the flag (safe default).
}

const child = spawn(npxCommand, [...npxArgs, ...mcpArgs], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = createInterface({ input: child.stdout });

let nextId = 1;
const pending = new Map(); // id → { resolve, reject }

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // MCP server occasionally logs non-JSON to stdout during boot; ignore.
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message ?? 'MCP error'));
    else resolve(msg.result);
  }
});

function send(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const SHUTDOWN_TIMEOUT_MS = 30_000;
const timeout = setTimeout(() => {
  process.stderr.write('orient-via-mcp: timed out waiting for MCP server\n');
  child.kill('SIGTERM');
  process.exit(124);
}, SHUTDOWN_TIMEOUT_MS);

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'openlore-orient-skill', version: '1.0.0' },
  });
  notify('notifications/initialized', {});

  const result = await send('tools/call', {
    name: 'orient',
    arguments: { directory, task },
  });

  clearTimeout(timeout);

  // Tool responses come back as { content: [{ type: 'text', text: '<json>' }] }
  const textBlock = result?.content?.find?.((c) => c.type === 'text');
  if (textBlock?.text) {
    // Try to parse + reformat; if not JSON, emit raw.
    try {
      const parsed = JSON.parse(textBlock.text);
      process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    } catch {
      process.stdout.write(textBlock.text + '\n');
    }
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (err) {
  clearTimeout(timeout);
  process.stderr.write(`orient-via-mcp: ${err.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
