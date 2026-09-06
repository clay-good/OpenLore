/**
 * `--watch-auto` end to end — the default that keeps an agent's index fresh.
 *
 * The server arms a file watcher lazily: the FIRST tool call carrying a `directory`
 * starts one for that repository (mcp.ts, the `options.watchAuto && !autoWatcher`
 * block). From then on the agent's edits reach the index with no further tool call.
 * It is on by default, so almost every real session depends on it.
 *
 * Nothing exercised it. Before this file, `--watch-auto` appeared in the suite three
 * ways, none of which run the mechanism:
 *
 *   - mcp.conformance.integration.test.ts passes `--no-watch-auto` to every spawn,
 *     deliberately (protocol conformance must not pay for a watcher), and its one
 *     probe that leaves the flag on asserts the NEGATIVE - that a rejected call does
 *     not bootstrap a watcher;
 *   - mcp-cold-start-scale.test.ts reads mcp.ts as a STRING and asserts the source
 *     does not contain `await autoWatcher.start()`. It never starts a server;
 *   - every McpWatcher test constructs the watcher directly, so it proves what the
 *     watcher does once it exists, never that a tool call brings one into existence.
 *
 * The gap that leaves is exact: if the arming block regressed - a renamed option, an
 * early return, a daemon probe that stopped failing soft - every one of those tests
 * would still pass while agents silently served a frozen index.
 *
 * The assertion here is the behaviour a user would notice: edit a file, and WITHOUT
 * touching the server again, the artifact gains the new symbol.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const MCP_BIN = join(REPO_ROOT, 'dist/cli/index.js');

/** A watcher start is asynchronous and chokidar's initial scan is not instant. */
const WATCHER_WARMUP_MS = 1_500;
/** How long a POSITIVE assertion waits for the edit to reach the artifact. */
const INDEXED_BUDGET_MS = 30_000;
/** How long a NEGATIVE assertion gives the server to prove it is NOT watching. */
const QUIET_WINDOW_MS = 6_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fixture { rootPath: string; contextPath: string; srcFile: string }

/**
 * A one-file repository with a REAL index — `init` then `analyze --no-embed`, ~3s.
 *
 * A hand-seeded llm-context.json is not enough, and the failure is silent enough to be
 * worth recording. With only that file present the watcher arms, sees no matching graph
 * store, and correctly refuses the edit:
 *
 *   [mcp-watcher] graph index not ready (schema-mismatch) — scheduling a background
 *   rebuild. Skipping incremental update to avoid a partial graph.
 *
 * A test built on that fixture fails while reporting nothing about `--watch-auto`, which
 * is exactly the sort of false signal this file exists to prevent.
 *
 * A real index also keeps the cold-start bootstrap out of the picture: with one present it
 * returns early instead of rebuilding this same artifact from a child process, which would
 * let the test pass on the bootstrap's output while the watcher did nothing.
 * OPENLORE_NO_AUTO_ANALYZE closes that path too — belt and braces, because the two are easy
 * to confuse and only one of them is under test.
 */
async function makeFixture(): Promise<Fixture> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), 'ol-watch-auto-')));
  const srcFile = join(rootPath, 'service.ts');
  await writeFile(srcFile, 'export function watchAutoBefore(): number { return 1; }\n', 'utf-8');

  const run = (args: string[]): void => {
    execFileSync('node', [MCP_BIN, ...args], { cwd: rootPath, stdio: 'ignore', windowsHide: true });
  };
  run(['init']);
  run(['analyze', '--no-embed']);

  const contextPath = join(rootPath, '.openlore', 'analysis', 'llm-context.json');
  return { rootPath, contextPath, srcFile };
}

/**
 * Poll the artifact for `needle`, reading only when its mtime has moved.
 *
 * Deliberately NOT a `readFile` loop. The watcher publishes this file by temp+rename,
 * and on Windows any open handle on the destination blocks that rename whatever share
 * mode the reader asked for (issue #457) - a tight read loop makes the test the cause
 * of the failure it then reports.
 */
async function indexed(contextPath: string, needle: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let lastMtimeMs = -1;
  let cached = '';
  for (;;) {
    try {
      const { mtimeMs } = await stat(contextPath);
      if (mtimeMs !== lastMtimeMs) {
        lastMtimeMs = mtimeMs;
        cached = await readFile(contextPath, 'utf-8');
      }
      if (cached.includes(needle)) return true;
    } catch { /* mid-rename: the next pass sees it */ }
    if (Date.now() >= deadline) return false;
    await wait(100);
  }
}

const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
const roots: string[] = [];

/** Start the real built server over stdio, exactly as an agent host does. */
async function startServer(extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_BIN, 'mcp', '--preset', 'navigation', '--watch-no-embed', '--watch-debounce', '100', ...extraArgs],
    cwd: REPO_ROOT,
    // Isolate the mechanism under test from the cold-start bootstrap, which writes
    // the same artifact from a child process.
    env: { ...process.env, OPENLORE_NO_AUTO_ANALYZE: '1' } as Record<string, string>,
  });
  const client = new Client({ name: 'watch-auto-e2e', version: '1.0.0' });
  await client.connect(transport);
  clients.push({ client, transport });
  return client;
}

afterEach(async () => {
  for (const { client } of clients.splice(0)) await client.close().catch(() => {});
  // The server owns a SQLite handle on call-graph.db inside the fixture, and its teardown
  // runs after stdin closes rather than before close() resolves. Removing the tree straight
  // away races that and throws EBUSY on the -shm file. Retry briefly, then let it go: a
  // leftover temp directory is the OS's problem, a failed afterEach would be ours.
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await rm(root, { recursive: true, force: true }); break; } catch { await wait(300); }
    }
  }
});

describe.skipIf(!existsSync(MCP_BIN))('--watch-auto arms on the first tool call', () => {
  it('indexes a later edit with no further tool call', async () => {
    const { rootPath, contextPath, srcFile } = await makeFixture();
    roots.push(rootPath);

    const client = await startServer([]);              // watch-auto left at its default

    // The call that arms it. What orient ANSWERS is irrelevant here - arming happens
    // before dispatch - so a fixture too small to orient well cannot mask the result.
    await client.callTool({ name: 'orient', arguments: { directory: rootPath, task: 'watch-auto e2e' } })
      .catch(() => { /* the answer is not under test; the arming is */ });

    await wait(WATCHER_WARMUP_MS);

    // The whole point: edit, and then DO NOT touch the server again.
    await writeFile(srcFile, 'export function watchAutoAfter(): string { return "x"; }\n', 'utf-8');

    expect(
      await indexed(contextPath, 'watchAutoAfter', INDEXED_BUDGET_MS),
      'a save must reach llm-context.json with no further tool call',
    ).toBe(true);
  }, 90_000);

  it('does not index the edit when --no-watch-auto is passed', async () => {
    const { rootPath, contextPath, srcFile } = await makeFixture();
    roots.push(rootPath);

    const client = await startServer(['--no-watch-auto']);

    await client.callTool({ name: 'orient', arguments: { directory: rootPath, task: 'watch-auto e2e' } })
      .catch(() => { /* as above */ });

    await wait(WATCHER_WARMUP_MS);
    await writeFile(srcFile, 'export function watchAutoNever(): string { return "x"; }\n', 'utf-8');

    // The control. Without it the positive test above could pass for the wrong reason -
    // a tool call that re-read the file, or a bootstrap that rebuilt the index - and
    // nothing would say so.
    expect(
      await indexed(contextPath, 'watchAutoNever', QUIET_WINDOW_MS),
      '--no-watch-auto must leave the index untouched',
    ).toBe(false);
  }, 90_000);
});
