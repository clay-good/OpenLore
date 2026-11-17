/**
 * Bootstrap that binds the crash renderer to the process.
 *
 * Imported for its side effect, like `node-version-bootstrap.ts`: an unexpected throw or
 * rejection anywhere in a command action becomes one legible stderr message and exit code 1,
 * never a V8 stack trace. The renderer itself lives in `crash-report.ts` and stays pure.
 */

import { renderCrash } from './crash-report.js';

function report(event: 'uncaughtException' | 'unhandledRejection', error: unknown): void {
  // Read the flag off argv rather than Commander: a crash can precede option parsing.
  const verbose = process.argv.includes('--verbose') || process.env.OPENLORE_DEBUG === '1';
  const command = process.argv[2]?.startsWith('-') ? undefined : process.argv[2];
  process.stderr.write(renderCrash(error, { command, verbose }) + '\n');

  // This module is imported before the command modules, so its handler runs FIRST. Exiting
  // here pre-empted `ShutdownManager`, whose own `uncaughtException` handler saves resume state
  // and runs registered teardown (the `generate --preview` temp workspace is removed there) —
  // so a crash leaked that workspace and lost the resume file. When another handler is
  // registered, render the message and hand off: `handleShutdown` exits the process itself.
  // With no other handler, exiting here is what keeps the exit code at 1
  // (change: fix-crash-reporter-shutdown-order).
  if (process.listenerCount(event) > 1) {
    process.exitCode = 1;
    return;
  }
  process.exit(1);
}

process.on('uncaughtException', error => report('uncaughtException', error));
process.on('unhandledRejection', reason => report('unhandledRejection', reason));
