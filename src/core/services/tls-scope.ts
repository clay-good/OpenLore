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

/**
 * The operator's TLS opt-out, read from the environment.
 *
 * WHY AN ENV VAR AT ALL, given `--insecure` already exists: `--insecure` is a CLI
 * flag, and the paths that most often face an internal self-signed endpoint never
 * see a command line — the long-lived `openlore mcp` daemon, and the decisions gate
 * spawned by the git pre-commit hook. Those had NO operator lever for the LLM path;
 * embeddings had one (`EMBED_SKIP_SSL_VERIFY`) and the LLM did not.
 *
 * WHY EVERY KEY IS SURFACE-SCOPED, and there is deliberately NO global one: needing
 * to relax verification for one surface and not the other is the ordinary case — an
 * internal self-signed embedding server alongside an LLM vendor with a perfectly
 * valid certificate. A single switch would force the operator to relax BOTH to fix
 * one, a strictly larger exposure than the problem requires, and it would be the
 * broadest ambient lever in the codebase while an `openlore mcp` daemon is running.
 * The case it would serve — every outbound endpoint behind one internal CA — is
 * exactly what `NODE_EXTRA_CA_CERTS` handles properly, by making the certificates
 * VERIFY rather than skipping the check. So two scoped keys, and no union:
 *
 *   - `EMBED_SKIP_SSL_VERIFY` — embedding requests only
 *   - `LLM_SKIP_SSL_VERIFY`   — LLM provider requests only
 *
 * The trust boundary is unchanged: this reads the OPERATOR's environment, never the
 * analyzed repository's `.openlore/config.json` (see `repo-config-trust.ts`). A clone
 * still cannot disable verification on the machine analyzing it.
 *
 * Prefer `NODE_EXTRA_CA_CERTS` over either key wherever the signing CA is available.
 */

/** Env spelling that relaxes embedding requests only. */
export const EMBED_TLS_ENV = 'EMBED_SKIP_SSL_VERIFY';
/** Env spelling that relaxes LLM provider requests only. */
export const LLM_TLS_ENV = 'LLM_SKIP_SSL_VERIFY';

/** True when the operator set `scopeKey` to an affirmative value. */
export function envTlsOptOut(scopeKey: string): boolean {
  const value = process.env[scopeKey];
  return value === '1' || value === 'true';
}

/**
 * Whether verification is relaxed for a surface right now: the operator's scoped env key,
 * OR the process-wide `--insecure` capability.
 *
 * Every relaxable request site MUST go through one of these rather than deciding for itself.
 * Passing an explicit `false` to `withRelaxedTls` silently opts a site OUT of the CLI flag,
 * and omitting the argument silently opts it out of the env key — the codebase had one of
 * each, so `--insecure` did not reach embeddings and `LLM_SKIP_SSL_VERIFY` did not reach the
 * viewer's chat and model-listing requests.
 */
export function llmTlsRelaxed(): boolean {
  return envTlsOptOut(LLM_TLS_ENV) || insecureAllowed;
}

export function embeddingTlsRelaxed(): boolean {
  return envTlsOptOut(EMBED_TLS_ENV) || insecureAllowed;
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
  delete process.env[EMBED_TLS_ENV];
  delete process.env[LLM_TLS_ENV];
}
