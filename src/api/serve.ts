/**
 * Programmatic daemon lifecycle (change: extend-api-for-supervising-hosts).
 *
 * A supervising host holds one OpenLore daemon per working tree and releases it at shutdown. Today
 * that means spawning the CLI binary and managing a PID — in a single-file distribution, an extra
 * re-entry path built solely to exec that binary. This makes the daemon a call that returns a
 * handle the host closes.
 *
 * Two properties separate this from a wrapper over the CLI entry point:
 *
 *  1. It never touches the host's process. `runServe` returns every outcome as a value, so a
 *     refusal — static configuration OR a runtime one such as lock contention or a posture
 *     mismatch — is thrown, never logged-and-exited. A library that set the exit code of a process
 *     it does not own would already have failed the contract by the time it threw.
 *  2. A handle says whether closing it stops anything. The CLI's reuse path deliberately returns a
 *     no-op `close()` — "never tear down a daemon this process didn't start" — and passing that
 *     off as an owned handle would let a host believe it released a daemon that is still live.
 *     So the default here is to REFUSE an already-running daemon and name it; adopting one is an
 *     explicit opt-in that yields `owned: false`.
 */
import { runServe, type ServeHandle } from '../cli/commands/serve.js';
import { OpenLoreError } from '../utils/errors.js';
import { withLoggerOptions } from '../utils/logger.js';
import type { BaseOptions } from './types.js';

/** Thrown by {@link openloreServe} when a compatible daemon already serves the working tree. */
export class ServeAlreadyRunningError extends OpenLoreError {
  constructor(readonly host: string, readonly port: number, readonly baseUrl: string) {
    super(
      `A compatible openlore daemon is already serving this working tree at ${baseUrl}.`,
      'SERVE_ALREADY_RUNNING',
      'Address it directly, or pass ifRunning: "adopt" to receive a handle onto it (its close() detaches rather than stopping it).',
    );
    this.name = 'ServeAlreadyRunningError';
  }
}

export interface ServeApiOptions extends BaseOptions {
  /** Bind host. Default 127.0.0.1. A non-loopback bind without a token is refused. */
  host?: string;
  /** Bind port as a number; 0 requests an ephemeral port, reported back on the handle. */
  port?: number;
  /** Shared secret required on every tool request. Generated when omitted. */
  token?: string;
  /** Tool surface to advertise. Default: the lean serve preset. */
  preset?: string;
  /** false disables the freshness watcher and its re-analyze lane. Default true. */
  watch?: boolean;
  /** Idle milliseconds before the daemon self-terminates. 0 disables. Default: the CLI default. */
  idleTimeoutMs?: number;
  /**
   * What to do when a compatible daemon already serves this tree.
   * `'reject'` (default) throws {@link ServeAlreadyRunningError} and returns no handle.
   * `'adopt'` returns a handle with `owned: false` whose `close()` detaches without stopping it.
   */
  ifRunning?: 'reject' | 'adopt';
}

/**
 * Convert milliseconds to the `--idle-timeout <minutes>` string the startup core parses.
 * 0 stays 0 (disabled); undefined stays undefined (the CLI default applies).
 */
function idleTimeoutOption(idleTimeoutMs: number | undefined): string | undefined {
  if (idleTimeoutMs === undefined) return undefined;
  if (idleTimeoutMs <= 0) return '0';
  return String(idleTimeoutMs / 60_000);
}

/**
 * Start (or deliberately adopt) the local daemon for a working tree.
 *
 * Resolves to a live handle, or throws. It never writes to the console, never sets
 * `process.exitCode`, and never returns undefined to signal failure.
 */
export async function openloreServe(options: ServeApiOptions = {}): Promise<ServeHandle> {
  const { quiet = true, rootPath, port, idleTimeoutMs, ifRunning = 'reject', ...rest } = options;
  return withLoggerOptions({ quiet }, async () => {
    const outcome = await runServe({
      ...(rootPath !== undefined ? { directory: rootPath } : {}),
      ...(rest.host !== undefined ? { host: rest.host } : {}),
      ...(port !== undefined ? { port: String(port) } : {}),
      ...(rest.token !== undefined ? { token: rest.token } : {}),
      ...(rest.preset !== undefined ? { preset: rest.preset } : {}),
      ...(rest.watch !== undefined ? { watch: rest.watch } : {}),
      ...(idleTimeoutOption(idleTimeoutMs) !== undefined
        ? { idleTimeout: idleTimeoutOption(idleTimeoutMs) as string }
        : {}),
    });

    switch (outcome.kind) {
      case 'started':
        return outcome.handle;
      case 'reusing':
        if (ifRunning === 'adopt') return outcome.handle;
        throw new ServeAlreadyRunningError(
          outcome.handle.host,
          outcome.handle.port,
          outcome.handle.baseUrl,
        );
      case 'refused':
        throw new OpenLoreError(outcome.message, 'SERVE_REFUSED', `Refusal code: ${outcome.code}`);
      // `--stop` is not exposed on this call, so neither of these is reachable through it. They are
      // still handled rather than assumed away: an unhandled outcome would surface as `undefined`,
      // which is exactly the failure signal this function exists to remove.
      case 'stopped':
      case 'no-daemon':
        throw new OpenLoreError(
          'openloreServe did not start a daemon.',
          'SERVE_REFUSED',
          'This call does not support stopping a daemon; use the handle returned by a start.',
        );
    }
  });
}

export type { ServeHandle };
