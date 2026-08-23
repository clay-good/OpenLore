/**
 * Dependency-light stdin reader for hook consumers.
 *
 * Lives in utils (no analyzer/LLM imports) so latency-sensitive hooks — `orient` and the
 * `panic-check` PreToolUse guard — can read the hook payload without pulling a heavy import graph
 * into process startup.
 */

/**
 * Read all of stdin (the hook payload). Resolves '' when stdin is a TTY (nothing piped).
 * Exported for testing; defaults to `process.stdin`.
 *
 * Load-bearing for the "a hook must never hang the user's turn" contract: when the fallback timer
 * fires (a writer that opened the pipe but never wrote/closed it), `done()` not only resolves but
 * TEARS DOWN the stream — pausing it, detaching listeners, and unref-ing the underlying handle — so
 * the process can exit immediately instead of waiting for an EOF that may never come. Resolving the
 * promise alone is not enough: a still-referenced, flowing stdin keeps the event loop alive until
 * the writer closes the pipe.
 */
export function readStdin(
  stream: NodeJS.ReadStream = process.stdin,
  timeoutMs = 1500,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (stream.isTTY) return resolve('');
    let data = '';
    let bytes = 0;
    let settled = false;
    const onData = (chunk: string): void => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        done(new Error(`Hook stdin exceeds the ${maxBytes}-byte safety limit.`));
        return;
      }
      data += chunk;
    };
    const done = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.pause();
      stream.unref?.();
      if (error) reject(error);
      else resolve(data);
    };
    const onEnd = (): void => done();
    const onError = (): void => done();
    // Arm before attaching data listeners: a stream may synchronously flush
    // already-buffered bytes as soon as it enters flowing mode.
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    // A hook must never hang the user's turn: if stdin neither closes nor errors,
    // proceed with whatever arrived (typically '') and detach.
  });
}
