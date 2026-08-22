# LLM logs persist full source always-on and unrotated; telemetry's kill-switch is inverted and its disclosure is narrower than what it records

> Status: **BUILT** (2026-08-22). OpenLore's local diagnostics
> persisted source-bearing LLM prompts and responses by default, without a retention bound or
> user-facing disclosure. Telemetry's documented opt-in and event description also diverged from
> its implementation. Later hardening had already landed shared whole-entry redaction, the exact
> telemetry gate, and the corrected cache label; this change re-verifies those guarantees and
> closes the remaining consent, retention, and disclosure gaps.

## Why

- **LLM logs were default-on and unbounded.** Six CLI and five API construction paths enabled
  prompt/response persistence unconditionally. Each run created another source-bearing JSON file
  under `.openlore/logs/`, with no count or byte cap and no disclosure.
- **Telemetry's contract had drifted.** Its gate previously accepted non-empty false-looking values,
  while the README described only lease measurement even though the local stream also contains tool
  calls, agent identity, latency, error messages, decision titles, and lease events.

## What Changes

1. **LLM logging: opt-in, redacted on both sides, retained within a fixed bound.** OpenLore's
   CLI/API paths enable it only for `OPENLORE_LLM_LOGS=1`; explicit `LLMService` consumers retain
   their option when paired with an explicit trusted directory or confinement root. The shared redactor covers request, response, and error content, each entry carries
   its redaction count, writes are owner-only and collision-safe, and retention keeps at most six
   matching files or 300 MB without touching unrelated files.
2. **Fix the telemetry gate to match its contract:** enable only when the value is exactly
   `1` (or a documented truthy set that excludes `0`/`false`). A test pins that `=0` disables.
3. **Widen the telemetry disclosure** in the README/docs to enumerate the recorded domains
   (tool calls + agent id + latency, error strings, decision titles, lease events) and note
   the local-only, gitignored, rotated bound. Fix the `cache_read` hit/miss label.

The shared response/error redaction, exact telemetry gate, and cache hit/miss correction landed
through later hardening before this change was implemented. They were re-verified and retained;
this change closes the remaining opt-in, retention, collision, and disclosure obligations.

## Scope

The substrate writes source-derived content to disk on the user's behalf; doing it always-on,
half-redacted, and undisclosed — and shipping an opt-out flag that opts in — is a
straightforward honesty-and-consent gap, exactly the class this audit arc closes, and cheap
to fix.

## Impact

- Files: `src/core/services/llm-service.ts` (bounded, collision-safe persistence), the 11
  OpenLore-owned CLI/API construction paths (exact opt-in and confinement root), telemetry
  documentation, README, configuration and architecture docs, tests, and synchronized specs.
- Specs: `mcp-security` — 1 ADDED (LlmLogPersistenceIsDisclosedRedactedAndBounded); `cli`
  — 1 ADDED (TelemetryGateAndDisclosureAreHonest).
- No new tool. Risk: low — logging becomes explicit opt-in and retained logs are capped at six
  files or 300 MB. Verification covers exact gate values, redaction receipts, oldest-first
  pruning, unrelated-file preservation, bounded contention, collisions, permissions, and docs.
