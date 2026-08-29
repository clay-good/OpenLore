## Context

See proposal.md — Why. Two constraints shape the approach.

The relaxation mechanism itself is already settled and must not be reopened: Node's built-in
`fetch` accepts no per-request TLS options, so `tls-scope.ts` sets
`NODE_TLS_REJECT_UNAUTHORIZED` around each individual `fetch` and restores it immediately,
turning a process-lifetime opt-out into a per-request one. That module already exists and is
tested; this change adds a *source of the decision*, not a new mechanism.

The trust boundary is also already settled, in `repo-config-trust.ts`: `.openlore/config.json`
is committed in the analyzed repository and is therefore attacker-authored on a clone, so it
may not choose credential sinks nor waive verification. This change must not widen that.

Finally, the `api` spec already requires (`ApiGenerateDoesNotMutateProcessTls`) that the
embedding TLS setting must not weaken the LLM path. Surface-scoped keys are the general form
of that rule rather than an exception to it.

## Goals / Non-Goals

**Goals:**
- Give the operator a lever on every surface, including where no command line exists.
- Keep each lever's blast radius to the one surface that needs it.
- Make the diagnostic agree with the real request path.

**Non-Goals:**
- Changing what the repository config is allowed to do. It stays refused.
- Replacing the `NODE_TLS_REJECT_UNAUTHORIZED` mechanism with `undici`/`https.request`
  per-request options. That migration is noted in `tls-scope.ts` and stays out of scope.
- Adding a lever to CLI-backed providers (`claude-code`, `codex-cli`, …). Those are separate
  processes with their own TLS stacks; they inherit the environment but honour it only if
  they happen to run on Node.

## Decisions

**One reader, keyed by surface, over one variable per surface written inline.**
`envTlsOptOut(scopeKey)` in `tls-scope.ts` is the single place that decides what counts as an
affirmative value. The alternative — each call site testing `=== '1' || === 'true'` itself —
is what the codebase had, and it is how `EMBED_SKIP_SSL_VERIFY` came to be honoured in exactly
one place while `doctor` silently ignored it.

**No global union key.** Considered and rejected: `OPENLORE_INSECURE_TLS` covering both
surfaces. It buys only the typing of one variable instead of two, and costs the broadest
ambient lever in the codebase, live for the lifetime of an `openlore mcp` daemon. Needing to
relax one surface and not the other is the ordinary case — an internal embedding server beside
an LLM vendor with a valid certificate — so a union switch would routinely relax more than the
problem requires. The case it would serve, every endpoint behind one internal CA, is served
properly by `NODE_EXTRA_CA_CERTS`, which validates instead of skipping. Verified empirically
that Node's built-in `fetch` honours it (Node 24.15.0).

**The environment ranks with the flag, not with the config.** In `resolveTrustedSslVerify` the
order is: explicit flag, then operator environment, then the (refused) repository value. Both
of the first two come from the person running the command; only the third comes from the
clone. `createLLMService` applies the same environment default for callers that pass no
`sslVerify` at all — the daemon and the embedded API — since those never reach the resolver.

**`doctor` mirrors `fromEnv` rather than merging sources.** When `EMBED_BASE_URL` is set the
real path is environment-only (`resolveEmbedder` returns `fromEnv`'s service and never consults
the config), so doctor preferring config values tested a setup nobody runs. Mirroring is
duplication, but the alternative — exporting the resolved configuration from the embedding
module for doctor to reuse — would hand doctor a live `EmbeddingService` whose construction
announces an opt-out, changing observable output for a check that is supposed to be read-only.

## Risks / Trade-offs

- **Two spellings to keep in sync as surfaces are added** → the constants live beside the
  reader in `tls-scope.ts`, and a new surface adds one exported constant rather than a new
  parsing rule.
- **`doctor` mirroring `fromEnv`'s precedence can drift from it** → the mirrored rule is stated
  in a comment at both sites; the spec requirement
  `DiagnosticsReflectTheOptOutTheRealPathUses` is what actually pins it.
- **An ambient environment variable is easier to leave set than a flag is to retype** → this is
  the real cost of reaching the daemon and the git hook at all, and it is why the keys stay
  surface-scoped and why the docs lead with `NODE_EXTRA_CA_CERTS`.
- **The relaxation window is still process-global while one request is in flight** →
  pre-existing and documented in `tls-scope.ts`; unchanged by this design.

## Migration Plan

None required. `EMBED_SKIP_SSL_VERIFY` keeps its spelling and meaning; `LLM_SKIP_SSL_VERIFY`
and the disclosure of a half-configured environment are additive. No configuration file
changes, no stored artifact changes.
