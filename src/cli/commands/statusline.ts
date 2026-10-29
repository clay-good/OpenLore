/**
 * `openlore statusline` — a compact, color-coded index status for Claude Code's
 * custom status line. The command consumes Claude's session JSON from stdin and
 * uses its current working directory, falling back to the process cwd for manual
 * use.
 */

import { Command } from 'commander';
import { colorForCapturedStdout } from '../../utils/colors.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { collectIndexStatus, type IndexStatus } from './status.js';

type StatusColor = 'green' | 'yellow' | 'red';

function statusLabel(status: IndexStatus): { color: StatusColor; text: string } {
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

async function workingDirectoryFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return process.cwd();
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const data = JSON.parse(input) as {
      cwd?: unknown;
      workspace?: { current_dir?: unknown };
    };
    const cwd = data.workspace?.current_dir ?? data.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  } catch {
    return process.cwd();
  }
}

export const statuslineCommand = new Command('statusline')
  .description('Print a compact color-coded index status for Claude Code status lines')
  .option('--installed-by-openlore', 'Mark the command installed by Claude Code integration')
  .action(async () => {
    try {
      const status = await collectIndexStatus(await workingDirectoryFromStdin());
      const { color, text } = statusLabel(status);
      const c = colorForCapturedStdout();
      const safeText = safe(text);
      const rendered = color === 'green' ? c.green(safeText)
        : color === 'yellow' ? c.yellow(safeText)
          : c.red(safeText);
      process.stdout.write(rendered + '\n');
    } catch {
      // A status-line command must fail soft: Claude Code hides output from commands
      // that exit non-zero, while a yellow unknown state is still useful and honest.
      process.stdout.write(colorForCapturedStdout().yellow('OpenLore: status unknown') + '\n');
    }
  });
