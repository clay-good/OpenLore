/**
 * LanceDB's native (Rust) layer logs `WARN` lines (e.g. "No existing dataset …,
 * it will be created") to stderr, polluting otherwise-clean `analyze` output.
 * Its log level is read from the `LANCEDB_LOG` env var, NOT `RUST_LOG` — verified
 * empirically against @lancedb/lancedb (RUST_LOG=off has no effect; LANCEDB_LOG=error
 * drops the WARN lines while keeping genuine errors).
 *
 * Quiet it to errors only, but never override a level the user set on purpose so
 * anyone debugging LanceDB can turn it back up. Idempotent, and must run before
 * the FIRST `@lancedb/lancedb` import in the process initializes the native
 * logger — every dynamic import of the addon calls this first
 * (OutputContractsAreUniform, change: fix-cli-output-hygiene).
 */
export function quietNativeLoggingOnce(): void {
  if (process.env.LANCEDB_LOG === undefined) process.env.LANCEDB_LOG = 'error';
}
