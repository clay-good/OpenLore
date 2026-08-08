/**
 * Scoped TLS relaxation for `--insecure` / `skipSslVerify`.
 *
 * WHY THIS EXISTS
 * Disabling certificate verification used to be done by setting
 * `NODE_TLS_REJECT_UNAUTHORIZED = '0'` at start-up and leaving it set. That is
 * process-global and permanent: from the first LLM call onward, EVERY https
 * connection in the process was unverified — the update check, a git helper, any
 * later request — not just the endpoint the user opted out for. In the long-lived
 * `openlore mcp` daemon that meant the rest of the session.
 *
 * WHY IT IS DONE THIS WAY
 * Node's built-in `fetch` accepts no per-request TLS options, and an `Agent` from
 * the npm `undici` package is rejected by it (`UND_ERR_INVALID_ARG`) because the
 * built-in fetch is a separate undici instance. Verified on Node 25. So the env var
 * is still the only lever available without either adding `undici` as a dependency
 * AND switching these call sites to its `fetch` export, or rewriting them onto
 * `https.request`. Both are real options; see the note at the bottom.
 *
 * What changed is the LIFETIME. The variable is now set immediately before a
 * request and restored immediately after, which is safe because:
 *   - certificate verification happens during the TLS handshake, inside `fetch()`,
 *     so restoring once `fetch()` resolves does not affect an in-flight body — a
 *     streamed response continues to read fine afterwards, and
 *   - deleting the variable genuinely re-enables verification; Node does not cache
 *     the previous value.
 * Both behaviours are asserted in `tls-scope.test.ts` rather than assumed.
 *
 * REMAINING EXPOSURE, stated plainly: the variable is still process-global while a
 * scope is open. An unrelated https request that happens to be in flight during
 * that window is also unverified. The window is now one request rather than the
 * process lifetime, which is a large reduction but not elimination. Eliminating it
 * requires per-request TLS options, i.e. one of the two migrations above.
 */

const ENV_KEY = 'NODE_TLS_REJECT_UNAUTHORIZED';

/** Set once the user has explicitly opted out of verification. */
let insecureAllowed = false;
/** The opt-out is announced once, not once per request. */
let warned = false;
/**
 * Open-scope count. Concurrent or nested relaxed requests must not restore
 * verification while a sibling request is still mid-handshake, so the value is
 * restored only when the last scope closes.
 */
let openScopes = 0;
/** The caller's original value, restored verbatim (including "was unset"). */
let savedValue: string | undefined;

/**
 * Record that the user opted out of TLS verification, and say so once.
 *
 * This deliberately does NOT disable anything by itself — it only grants
 * `withRelaxedTls` permission to relax verification around individual requests.
 *
 * `announce: false` is for callers that print their own (better) notice — the CLI
 * renders a colorized one and honours `--quiet`. Without that opt-out this would
 * both duplicate the message and write to stderr in quiet mode.
 */
export function allowInsecureTls(reason: string, opts: { announce?: boolean } = {}): void {
  insecureAllowed = true;
  announceInsecureTls(reason, opts);
}

/** Announce an instance-scoped TLS opt-out without granting a process-wide capability. */
export function announceInsecureTls(reason: string, opts: { announce?: boolean } = {}): void {
  // `announce: false` means the caller owns the message, so it counts as announced.
  // Without marking it, a later opt-in from deeper in the same run (generate.ts after
  // the CLI's `--insecure` hook) would print a second notice.
  if (opts.announce === false) {
    warned = true;
    return;
  }
  if (warned) return;
  warned = true;
  process.stderr.write(
    `[openlore] WARNING: TLS certificate verification is disabled for outbound requests (${reason}).\n` +
      `[openlore] Those requests are exposed to interception. Use this only on a trusted\n` +
      `[openlore] network with a self-signed certificate.\n`
  );
}

/** Whether the user has opted out of certificate verification. */
export function isInsecureTlsAllowed(): boolean {
  return insecureAllowed;
}

/**
 * Run `fn` with certificate verification relaxed when the caller's own capability
 * enables it. Callers without an instance capability may inherit the CLI-wide opt-in.
 *
 * Wrap the `await fetch(...)` itself — not the surrounding bookkeeping and not the
 * body read. That is the narrowest span that still covers the handshake.
 */
export async function withRelaxedTls<T>(fn: () => Promise<T>, enabled = insecureAllowed): Promise<T> {
  if (!enabled) return fn();

  if (openScopes === 0) {
    savedValue = process.env[ENV_KEY];
    process.env[ENV_KEY] = '0';
  }
  openScopes++;
  try {
    return await fn();
  } finally {
    openScopes--;
    if (openScopes === 0) {
      if (savedValue === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedValue;
      savedValue = undefined;
    }
  }
}

/** Test-only: clear module state between cases. */
export function resetTlsScopeForTests(): void {
  insecureAllowed = false;
  warned = false;
  openScopes = 0;
  savedValue = undefined;
  delete process.env[ENV_KEY];
}
