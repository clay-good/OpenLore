#!/usr/bin/env node
/**
 * End-to-end smoke test of the Claude Code plugin on this OS, with a real `claude plugin install`.
 *
 * Usage: node scripts/plugin-smoke.mjs   (needs `claude` on PATH; no Claude login is needed)
 *
 * 1. Adds a throwaway marketplace whose `git-subdir` source is this checkout, in an isolated
 *    CLAUDE_CONFIG_DIR, and installs the plugin. The first prompt hook must return at once and
 *    start the launcher's one-time runtime install into CLAUDE_PLUGIN_DATA; the test waits for it.
 * 2. Runs every hook from plugin/hooks/hooks.json exactly as written (exec form, with
 *    ${CLAUDE_PLUGIN_ROOT} substituted) in a fresh git repo with no openspec/, and checks each
 *    exits 0 within its timeout.
 * 3. Starts the MCP server from plugin/.mcp.json and checks tools/list.
 * 4. Waits for the background index build, then checks the prompt hook returns a briefing.
 * 5. Checks the plugin's hooks stay silent when `openlore install` hooks exist.
 * The plugin must be committed: git-subdir clones HEAD of this checkout.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  check(!existsSync(join(pluginRoot, 'node_modules')), 'Claude Code installed no npm packages into the plugin folder');
  // Claude Code sets this for every hook and MCP server; the launcher installs the runtime there.
  env.CLAUDE_PLUGIN_DATA = join(work, 'plugin-data');
  env.CLAUDE_PROJECT_DIR = join(work, 'repo');

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
    session_id: 'plugin-smoke', cwd: repo, hook_event_name: event, prompt: 'change `total` to skip negative numbers',
    tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'math.ts'), old_string: 'a + b', new_string: 'a + b' },
    tool_response: { success: true }, source: 'startup', stop_hook_active: false,
  });

  // First use: the prompt hook returns at once and starts the one-time runtime install.
  const prompt = hooks.UserPromptSubmit[0].hooks[0];
  const first = await run(expand(prompt.command), prompt.args.map(expand), { cwd: repo, input: payload('UserPromptSubmit'), timeoutMs: 30_000 });
  check(first.code === 0 && first.seconds < 5 && first.stdout.includes('First use'),
    `first prompt hook returns in ${first.seconds.toFixed(1)} s and says the runtime is installing`);
  const ready = join(env.CLAUDE_PLUGIN_DATA, 'runtime', JSON.parse(readFileSync(join(pluginRoot, 'runtime', 'package.json'), 'utf8')).dependencies.openlore, '.ready');
  const installStarted = Date.now();
  while (!existsSync(ready) && Date.now() - installStarted < 600_000) await new Promise((r) => setTimeout(r, 2_000));
  const installLog = existsSync(join(env.CLAUDE_PLUGIN_DATA, 'install.log')) ? readFileSync(join(env.CLAUDE_PLUGIN_DATA, 'install.log'), 'utf8') : '';
  check(existsSync(ready), `runtime installed in ${((Date.now() - installStarted) / 1000).toFixed(1)} s\n${installLog.trim()}`);
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

  // 4. Once the background build publishes, the prompt hook returns a briefing. Since 3.7.0 it
  // briefs only code the prompt names exactly (a backticked name, a path, an identifier), so the
  // prompt names `total` in backticks; plain prose is silent by design.
  let briefed = false;
  for (let attempt = 0; attempt < 24 && !briefed; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const result = await run(expand(prompt.command), prompt.args.map(expand), { cwd: repo, input: payload('UserPromptSubmit'), timeoutMs: 30_000 });
    briefed = result.code === 0 && result.stdout.includes('total');
  }
  check(briefed, 'prompt hook returns a briefing that names `total` once the index is built');

  // 5. Hooks that `openlore install` wrote take over: the plugin's hooks stay silent, so nothing runs twice.
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [
    { _openlore: true, hooks: [{ type: 'command', command: 'openlore orient --inject' }] }] } }));
  const duplicate = await run(expand(prompt.command), prompt.args.map(expand), { cwd: repo, input: payload('UserPromptSubmit'), timeoutMs: 30_000 });
  check(duplicate.code === 0 && duplicate.stdout === '', 'prompt hook stays silent when CLI-installed hooks exist');
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failures += 1;
} finally {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may still hold a file */ }
}

console.log(failures === 0 ? 'plugin smoke: all checks passed' : `plugin smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
