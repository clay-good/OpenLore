/**
 * Stdout/stderr helpers for CLI commands.
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

/**
 * The stderr twin of `writeStdout`, sanitized identically.
 *
 * Several commands render the SAME human report to either stream depending on mode:
 * `--hook` and TTY branches send it to stderr so it never pollutes scripted stdout
 * (blast-radius, impact-certificate, review). Writing to `process.stderr` directly
 * bypassed the strip that `writeStdout` applies, so the exact string that is sanitized
 * on one branch went out raw on the other — and for `review` the raw branch is the one
 * that fires when a human terminal is attached, which is precisely where a forged
 * verdict lands. Making stderr a sanitized sink removes the choice from the call site.
 *
 * Drain semantics match `writeStdout`: stderr is also a pipe under capture, so a
 * caller that exits right after must await this.
 */
export function writeStderr(text: string): Promise<void> {
  text = stripTerminalControls(text);
  return new Promise<void>((resolve, reject) => {
    const acceptedWithoutBackpressure = process.stderr.write(text, (err) =>
      err ? reject(err) : resolve(),
    );
    if (acceptedWithoutBackpressure) resolve();
  });
}
