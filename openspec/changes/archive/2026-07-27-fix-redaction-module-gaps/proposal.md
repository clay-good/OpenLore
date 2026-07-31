# Fix redaction-module gaps: Basic-auth credentials survive, cycles return the unredacted original

> Status: PROPOSED (2026-07-08, e2e audit fifth pass). Two defects INSIDE the shipped
> secret-redaction module (`src/core/services/secret-redaction.ts`) — the single source of
> truth every output channel scrubs through. Distinct from `add-secret-redaction-boundary`
> (pass 1), which wires the boundary at the channels; these are bugs in the module both the
> shipped channels and that change rely on (extends-relationship; that change's files are
> not modified).

## The defect(s)

- **(a) Basic-auth credentials survive redaction.** The Authorization pattern
  (`secret-redaction.ts:28`) is `[/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]']`
  — `\S+` consumes only the FIRST token after the header name, i.e. the scheme. So
  `Authorization: Basic dXNlcjpzZWNyZXQ=` becomes
  `Authorization: [REDACTED] dXNlcjpzZWNyZXQ=` — the base64 credential pair remains in the
  output. `Bearer` tokens are saved only by the preceding Bearer-specific pattern (`:27`);
  Basic, Digest, and any scheme-with-a-space credential passes through the module labeled
  as redacted. A "redacted" string that still contains the secret is worse than an
  unredacted one: downstream channels trust the module's output wholesale.
- **(b) A cyclic payload returns the unredacted original.** `redactSecrets`' cycle guard
  (`:53`) is `if (seen.has(value as object)) return value; // break cycles` — on
  re-encountering a visited object it returns the ORIGINAL, UN-SCRUBBED object into the
  "redacted copy". The function's own contract comment (`:46`, "Returns a redacted copy;
  the input is not mutated. Cycle-safe.") is violated on exactly the input the guard
  exists for: the output graph embeds the un-scrubbed subtree, secrets and all. Any
  structured payload with a back-reference (config objects, error objects with `cause`
  cycles, graph-shaped telemetry) defeats redaction entirely for that subtree.

## What changes

1. **Consume the full header value.** The Authorization pattern consumes the remainder of
   the header value after the name — scheme plus credential, to end-of-line/value — e.g.
   `/Authorization:[^\n\r]*/gi → 'Authorization: [REDACTED]'`. Basic/Digest/custom schemes
   redact identically to Bearer; the Bearer-specific pattern (`:27`) stays for bare
   `Bearer <token>` occurrences outside a header context.
2. **Cycles map to the redacted twin.** The walker keeps an original→copy map (WeakMap):
   re-encountering a visited object returns its already-created redacted twin, preserving
   the input's shape (including the cycle) with zero unredacted leakage. Where a twin is
   not yet complete (a cycle closing on an in-progress ancestor), the reference is wired to
   the in-progress copy — standard cycle-preserving deep-copy — or, if shape preservation
   is not needed by any consumer, a `'[CYCLE]'` placeholder; the spec fixes only the
   invariant (no unredacted object in the output), the shape choice is implementation.

## Why this is in scope

The module IS the honest boundary: mcp-security's "Secret Confinement Across All Output
Paths" requires that a key read for an LLM call never appears in any output channel, and
every channel discharges that requirement by calling this module (`secret-redaction.ts:5-9`
doc comment). A redactor that lets Basic credentials and cyclic subtrees through makes the
confinement claim false everywhere at once — deterministic, local, two-line-class fixes
(decision `c6d1ad07`; no LLM, no new patterns beyond widening one and honoring a stated
contract).

## Impact

- Files: `src/core/services/secret-redaction.ts` (one pattern, one cycle branch); tests in
  the module's test file.
- Specs: `mcp-security` — 2 ADDED requirements
  (AuthorizationHeaderRedactionConsumesTheFullValue,
  CycleSafeRedactionNeverReturnsUnredactedInput).
- Tool surface: unchanged (no new tool; behavior of every channel that already calls the
  module improves silently).
- Risk: low. The widened pattern can over-redact a same-line trailing comment after an
  Authorization header (acceptable: over-redaction is the safe direction for a secret
  channel); the cycle fix only changes outputs for cyclic inputs, which today leak.
