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
export function writeStdout(text: string): Promise<void> {
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
