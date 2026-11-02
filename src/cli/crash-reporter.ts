/**
 * Bootstrap that binds the crash renderer to the process.
 *
 * Imported for its side effect, like `node-version-bootstrap.ts`: an unexpected throw or
 * rejection anywhere in a command action becomes one legible stderr message and exit code 1,
 * never a V8 stack trace. The renderer itself lives in `crash-report.ts` and stays pure.
 */

import { renderCrash } from './crash-report.js';

function report(error: unknown): never {
  // Read the flag off argv rather than Commander: a crash can precede option parsing.
  const verbose = process.argv.includes('--verbose') || process.env.OPENLORE_DEBUG === '1';
  const command = process.argv[2]?.startsWith('-') ? undefined : process.argv[2];
  process.stderr.write(renderCrash(error, { command, verbose }) + '\n');
  process.exit(1);
}

process.on('uncaughtException', report);
process.on('unhandledRejection', report);
