/**
 * `openlore statusline` — a compact, color-coded index status for Claude Code's
 * custom status line. The command consumes Claude's session JSON from stdin and
 * uses its project directory, falling back to the process cwd for manual use.
 */

import { Command } from 'commander';
import { colorForCapturedStdout } from '../../utils/colors.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { collectIndexStatus, type IndexStatus } from './status.js';

type StatusColor = 'green' | 'yellow' | 'red';

/**
 * Upper bound on waiting for stdin. Claude Code writes its JSON and closes the pipe at once;
 * a caller that leaves a pipe open (an IDE task, a wrapper script) must not hang the status line.
 */
const STDIN_TIMEOUT_MS = 1000;

export function statusLabel(status: IndexStatus): { color: StatusColor; text: string } {
  const label = indexLabel(status);
  // Auto-accepted decisions no human has looked at (change: default-decision-autopilot-with-visible-trace).
  const unreviewed = status.governance?.unreviewed ?? 0;
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
 * The directory whose index to report, from Claude Code's status-line JSON. The project
 * directory (where the session started, the root the hooks and MCP server use) wins over the
 * current directory, which moves into subdirectories that carry no `.openlore/` of their own.
 */
export function workingDirectoryFromInput(input: string, fallback: string): string {
  try {
    const data = JSON.parse(input) as {
      cwd?: unknown;
      workspace?: { project_dir?: unknown; current_dir?: unknown };
    };
    for (const candidate of [data?.workspace?.project_dir, data?.workspace?.current_dir, data?.cwd]) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  } catch { /* no or invalid JSON — manual use */ }
  return fallback;
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
    const status = await collectIndexStatus(workingDirectoryFromInput(input, fallbackCwd));
    const { color, text } = statusLabel(status);
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
