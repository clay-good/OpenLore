/**
 * Stdout helpers for CLI commands.
 *
 * `process.stdout` is ASYNCHRONOUS when it points at a pipe (the normal case when an
 * agent or shell captures `openlore … --json`): a `process.stdout.write(big)` followed
 * by `process.exit()` truncates the output at the ~64KB pipe buffer because the write
 * has not drained when the process dies. (To a TTY/file the write is synchronous, so
 * the bug only shows up under a pipe — exactly how tools consume CLI output.)
 *
 * `writeStdout` resolves only once the write has been flushed to the OS (the write
 * callback fires on drain), so a caller can `await writeStdout(x)` before exiting and
 * the full payload is guaranteed delivered.
 */

import { sanitizeForTerminal } from '../utils/misc.js';
/**
 * Strip terminal control sequences, keeping newlines.
 *
 * Everything written through here is either JSON or a plain-text report built from
 * repository-derived values — paths, symbol names, extracted source. A file name may
 * legally contain ESC on Linux and macOS, so an analyzed repository can otherwise
 * smuggle cursor-movement or screen-clear sequences into OpenLore's own output and
 * forge a verdict. Newline is the one control these reports rely on for structure, so
 * it is preserved; ESC (and therefore every CSI/OSC sequence it introduces), CR, and
 * the rest of C0/C1 are removed.
 *
 * Safe to do centrally because no caller colorizes through this path: all 14 command
 * modules that use `writeStdout` build plain text, and colored output goes through the
 * logger / `src/utils/colors.ts` instead. A guard in `output-hygiene.test.ts` keeps
 * that true. On the JSON path this is a no-op, since `JSON.stringify` already escapes
 * control characters to `\uXXXX`.
 */
function stripTerminalControls(text: string): string {
  return sanitizeForTerminal(text, { keepNewlines: true });
}

export function writeStdout(text: string): Promise<void> {
  text = stripTerminalControls(text);
  return new Promise<void>((resolve, reject) => {
    // `write` returns false ONLY under backpressure — the case where data is buffered
    // internally and a racing process.exit() would truncate it; there we must await the
    // drain callback. When it returns true the chunk was accepted without backpressure,
    // so resolving eagerly is both correct and avoids hanging on a stubbed stdout that
    // doesn't invoke the callback. (A second resolve from the callback is a no-op.)
    const acceptedWithoutBackpressure = process.stdout.write(text, (err) =>
      err ? reject(err) : resolve(),
    );
    if (acceptedWithoutBackpressure) resolve();
  });
}
