#!/usr/bin/env node
/**
 * End-to-end smoke test of the Claude Code plugin on this OS, with a real `claude plugin install`.
 *
 * Usage: node scripts/plugin-smoke.mjs   (needs `claude` on PATH; no Claude login is needed)
 *
 * 1. Adds a throwaway marketplace whose `git-subdir` source is this checkout, in an isolated
 *    CLAUDE_CONFIG_DIR, and installs the plugin. Claude Code runs its own npm install (60 s limit).
 * 2. Runs every hook from plugin/hooks/hooks.json exactly as written (exec form, with
 *    ${CLAUDE_PLUGIN_ROOT} substituted) in a fresh git repo with no openspec/, and checks each
 *    exits 0 within its timeout.
 * 3. Starts the MCP server from plugin/.mcp.json and checks tools/list.
 * 4. Waits for the background index build, then checks the prompt hook returns a briefing.
 * The plugin must be committed: git-subdir clones HEAD of this checkout.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'openlore-plugin-smoke-'));
const configDir = join(work, 'claude-config');
mkdirSync(configDir);
const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
const isWin = process.platform === 'win32';
let failures = 0;

const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  if (!ok) failures += 1;
};

function claude(args) {
  const started = Date.now();
  const result = spawnSync('claude', args, { env, encoding: 'utf8', shell: isWin, timeout: 180_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) throw new Error(`claude ${args.join(' ')} failed (${result.status}):\n${output}`);
  return { output, seconds: (Date.now() - started) / 1000 };
}

/** Run one exec-form command with stdin; resolve with exit code, output, and seconds. */
function run(command, args, { cwd, input = '', timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, seconds: (Date.now() - started) / 1000 });
    });
    child.stdin.end(input);
  });
}

try {
  // 1. Install through Claude Code itself.
  const marketplace = join(work, 'marketplace');
  mkdirSync(join(marketplace, '.claude-plugin'), { recursive: true });
  writeFileSync(join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'openlore-smoke',
    owner: { name: 'ci' },
    plugins: [{ name: 'openlore', source: { source: 'git-subdir', url: pathToFileURL(repoRoot).href, path: 'plugin' } }],
  }));
  claude(['plugin', 'marketplace', 'add', marketplace]);
  const install = claude(['plugin', 'install', 'openlore@openlore-smoke']);
  check(install.seconds < 60, `plugin install finished in ${install.seconds.toFixed(1)} s (limit 60 s)`);

  const installed = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  const pluginRoot = installed.plugins['openlore@openlore-smoke'][0].installPath;
  const expand = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  const cli = join(pluginRoot, 'node_modules', 'openlore', 'dist', 'cli', 'index.js');
  check(spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).status === 0, 'installed openlore CLI starts');

  // A fresh repository: some code and a test, no openspec/, no spec framework.
  const repo = join(work, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n'
    + 'export function total(xs: number[]) { return xs.reduce(add, 0); }\n');
  writeFileSync(join(repo, 'src', 'report.ts'), 'import { total } from "./math";\nexport function report() { return total([1, 2]); }\n');
  writeFileSync(join(repo, 'src', 'math.test.ts'), 'import { test, expect } from "vitest";\nimport { total } from "./math";\n'
    + 'test("total", () => expect(total([1])).toBe(1));\n');
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=ci@example.com', '-c', 'user.name=ci', 'commit', '-qm', 'init');

  // 2. Every hook, exactly as the plugin declares it.
  const { hooks } = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const payload = (event) => JSON.stringify({
    session_id: 'plugin-smoke', cwd: repo, hook_event_name: event, prompt: 'change total to skip negative numbers',
    tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'math.ts'), old_string: 'a + b', new_string: 'a + b' },
    tool_response: { success: true }, source: 'startup', stop_hook_active: false,
  });
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const args = hook.args.map(expand);
        const result = await run(expand(hook.command), args, { cwd: repo, input: payload(event), timeoutMs: hook.timeout * 1000 });
        check(result.code === 0 && result.seconds < hook.timeout,
          `${event} ${args.slice(1).join(' ')}: exit ${result.code} in ${result.seconds.toFixed(1)} s (timeout ${hook.timeout} s)`
          + (result.code === 0 ? '' : `\n${result.stderr.slice(0, 2000)}`));
        check(result.stdout.length <= 10_000, `${event} ${args.slice(1).join(' ')}: output ${result.stdout.length} chars (cap 10,000)`);
      }
    }
  }

  // 3. The MCP server, exactly as the plugin declares it.
  const { mcpServers } = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = mcpServers.openlore;
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];
  const tools = await new Promise((resolve) => {
    const child = spawn(expand(server.command), server.args.map(expand), { cwd: repo, env, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 60_000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        try {
          const message = JSON.parse(line);
          if (message.id === 2) { clearTimeout(timer); child.kill(); resolve(message.result.tools); }
        } catch { /* partial line */ }
      }
    });
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  });
  check(Array.isArray(tools) && tools.length > 0, `MCP server lists ${tools?.length ?? 0} tools`);
  const unannotated = (tools ?? []).filter((t) => !t.annotations?.title || !('readOnlyHint' in t.annotations)).map((t) => t.name);
  check(unannotated.length === 0, `every MCP tool has a title and readOnlyHint${unannotated.length ? `: missing on ${unannotated.join(', ')}` : ''}`);

  // 4. Once the background build publishes, the prompt hook returns a briefing.
  const prompt = hooks.UserPromptSubmit[0].hooks[0];
  let briefed = false;
  for (let attempt = 0; attempt < 24 && !briefed; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const result = await run(expand(prompt.command), prompt.args.map(expand), { cwd: repo, input: payload('UserPromptSubmit'), timeoutMs: 30_000 });
    briefed = result.code === 0 && result.stdout.includes('total');
  }
  check(briefed, 'prompt hook returns a briefing that names `total` once the index is built');
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failures += 1;
} finally {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may still hold a file */ }
}

console.log(failures === 0 ? 'plugin smoke: all checks passed' : `plugin smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
