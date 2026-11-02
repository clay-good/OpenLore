/**
 * Render an unexpected CLI failure as one legible stderr message instead of a V8 stack trace.
 *
 * `node-version-bootstrap.ts` already holds the line for an unsupported Node: "one legible
 * stderr line and a stable exit code, never a stack trace". Everything else had no such line.
 * A throw from any command action — Commander awaits them, so a rejection became an unhandled
 * rejection — printed the raw trace: the absolute path of a file inside `dist/`, the internal
 * frame list, and the Node version banner. The most common way a real user met it was a
 * path-confinement refusal during `install` (a `CLAUDE.md` symlinked out to a dotfiles
 * repository), where the trace named `path-confinement.js` and nothing a user could act on.
 *
 * This module stays pure so the rendering is unit-testable; `crash-reporter.ts` is the
 * bootstrap that binds it to the process.
 */

import { sanitizeForTerminal } from '../utils/misc.js';

/**
 * The actionable explanation for a failure shape we recognize, or null when there is nothing
 * honest to add. Deliberately short: a cause and the choices, never a guess at intent.
 */
export function explainFailure(message: string): string | null {
  if (/canonicalizes outside the project directory|Path escape blocked/.test(message)) {
    return 'That path, or one of its parent directories, is a symbolic link resolving outside '
      + 'this directory. OpenLore will not write through it. Point the link inside the '
      + 'repository, edit the file it points at directly, or wire the other surfaces with '
      + '`--agent <name>`.';
  }
  if (/EACCES|EPERM/.test(message)) {
    return 'The file or directory it needed is not writable by this user. Check its ownership '
      + 'and permissions, and whether it is managed by another tool.';
  }
  if (/ENOSPC/.test(message)) return 'The filesystem is full. Free some space and run it again.';
  if (/EMFILE|ENFILE/.test(message)) {
    return 'The process ran out of file descriptors. Raise the limit (`ulimit -n`) and run it again.';
  }
  return null;
}

/**
 * The stderr text for an unexpected failure. `verbose` adds the stack, which is the only place
 * it belongs: the message tells a user what happened, the stack tells us where.
 */
export function renderCrash(error: unknown, opts: { command?: string; verbose?: boolean } = {}): string {
  const err = error instanceof Error ? error : null;
  const raw = err ? err.message : typeof error === 'string' ? error : JSON.stringify(error);
  const message = sanitizeForTerminal(raw || 'an unknown error');
  const where = opts.command ? `openlore ${sanitizeForTerminal(opts.command)}` : 'openlore';
  const lines = [`error: ${where} stopped: ${message}`];
  const explanation = explainFailure(raw ?? '');
  if (explanation) lines.push(explanation);
  if (opts.verbose && err?.stack) lines.push('', sanitizeForTerminal(err.stack, { keepNewlines: true }));
  else lines.push('Re-run with --verbose for the stack trace.');
  return lines.join('\n');
}
