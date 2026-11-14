/**
 * `openlore statusline` — a compact, color-coded index status for Claude Code's
 * custom status line. The command consumes Claude's session JSON from stdin and
 * reports the OpenLore project that contains its project or current directory, falling back
 * to the process cwd for manual use.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { OPENLORE_CONFIG_REL_PATH } from '../../constants.js';
import { globalOpenLoreConfigPath } from '../../utils/config-layers.js';
import { colorForCapturedStdout } from '../../utils/colors.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { collectIndexStatus, type IndexStatus } from './status.js';
import { countUnreviewedDecisions } from '../../core/decisions/autopilot.js';

type StatusColor = 'green' | 'yellow' | 'red';

/**
 * Upper bound on waiting for stdin. Claude Code writes its JSON and closes the pipe at once;
 * a caller that leaves a pipe open (an IDE task, a wrapper script) must not hang the status line.
 */
const STDIN_TIMEOUT_MS = 1000;

export function statusLabel(
  status: IndexStatus,
  // Auto-accepted decisions no human has looked at (change: default-decision-autopilot-with-visible-trace).
  unreviewed = status.governance?.unreviewed ?? 0,
): { color: StatusColor; text: string } {
  const label = indexLabel(status);
  return unreviewed > 0 ? { ...label, text: `${label.text} · ${unreviewed} to review` } : label;
}

function indexLabel(status: IndexStatus): { color: StatusColor; text: string } {
  if (!status.indexPresent) return { color: 'yellow', text: 'OpenLore: no index' };
  if (status.degraded.length > 0) return { color: 'red', text: 'OpenLore: index degraded' };
  if (status.configUnreadable || status.embedFailure) {
    return { color: 'yellow', text: 'OpenLore: check index status' };
  }
  if (status.staleFilesUnknown) return { color: 'yellow', text: 'OpenLore: freshness unknown' };
  if (status.staleFiles.length > 0) {
    const count = `${status.staleFiles.length}${status.staleFilesTruncated ? '+' : ''}`;
    return { color: 'yellow', text: `OpenLore: index stale (${count})` };
  }
  return { color: 'green', text: 'OpenLore: index ready' };
}

/**
 * The nearest directory at or above `start` that holds a project `.openlore/config.json`, or
 * undefined. The user-level config (`~/.openlore/config.json`) shares that relative path but
 * marks no project, so it never counts. A bare `.openlore/` (telemetry or logs a tool left in
 * a subdirectory) is not a project either.
 */
export function openloreProjectRoot(start: string): string | undefined {
  const globalConfig = globalOpenLoreConfigPath();
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const config = join(dir, OPENLORE_CONFIG_REL_PATH);
    if (config !== globalConfig && existsSync(config)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The directory whose index to report, from Claude Code's status-line JSON. Candidates, in
 * order: the project directory (where the session started, the root the hooks and MCP server
 * use), the current directory, then `cwd`. The first one inside an OpenLore project resolves to
 * that project's root. A session resumed from one started elsewhere (for example in `/`) keeps
 * that stale project directory, so it must not hide the project the session now works in. When
 * no candidate is inside a project, the first candidate is reported as it is ("no index").
 */
export function workingDirectoryFromInput(input: string, fallback: string): string {
  let candidates: string[] = [];
  try {
    const data = JSON.parse(input) as {
      cwd?: unknown;
      workspace?: { project_dir?: unknown; current_dir?: unknown };
    };
    candidates = [data?.workspace?.project_dir, data?.workspace?.current_dir, data?.cwd]
      .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  } catch { /* no or invalid JSON — manual use */ }
  if (candidates.length === 0) candidates = [fallback];
  for (const candidate of candidates) {
    try {
      const root = openloreProjectRoot(candidate);
      if (root) return root;
    } catch { /* an unreadable candidate is skipped */ }
  }
  return candidates[0];
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let input = '';
  let timer: NodeJS.Timeout | undefined;
  const read = (async () => {
    for await (const chunk of process.stdin) input += chunk;
  })().catch(() => { /* an unreadable stdin is the same as an empty one */ });
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, STDIN_TIMEOUT_MS); });
  await Promise.race([read, timeout]);
  clearTimeout(timer);
  process.stdin.destroy();
  return input;
}

/** Render one status line. Never throws: a status-line command must fail soft. */
export async function renderStatusLine(input: string, fallbackCwd: string): Promise<string> {
  const c = colorForCapturedStdout();
  try {
    const directory = workingDirectoryFromInput(input, fallbackCwd);
    // The count alone: one small file read, no git process, no ledger scan — this renders often.
    const [status, unreviewed] = await Promise.all([collectIndexStatus(directory), countUnreviewedDecisions(directory)]);
    const { color, text } = statusLabel(status, unreviewed);
    return c[color](safe(text));
  } catch {
    // Claude Code hides output from commands that exit non-zero, while a yellow
    // unknown state is still useful and honest.
    return c.yellow('OpenLore: status unknown');
  }
}

export const statuslineCommand = new Command('statusline')
  .description('Print a compact color-coded index status for Claude Code status lines')
  .option('--installed-by-openlore', 'Marks the status line `openlore install` owns (uninstall removes only that one)')
  .action(async () => {
    let input = '';
    try { input = await readStdin(); } catch { /* manual use */ }
    process.stdout.write(await renderStatusLine(input, process.cwd()) + '\n');
  });
