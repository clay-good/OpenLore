# Enforcement baseline ratchet: a `frozen` class that blocks only NEW findings

> Status: IMPLEMENTED (2026-08-23). A fourth categorical enforcement class,
> `frozen`: an explicit non-hook bootstrap records existing violations into a plain-text,
> VCS-committable baseline;
> subsequent runs block only findings NOT in the baseline; a finding that disappears is
> auto-removed (the ratchet — fixed debt can't sneak back). Prior art: ArchUnit's
> FreezingArchRule (https://www.archunit.org/userguide/html/000_Index.html), the mechanism that
> made architecture rules adoptable on brownfield codebases. No new tuning constants — the class
> is categorical.

## The gap

Before this change, `enforcement.policy` maps a finding code to exactly
`blocking | advisory | off`
(`src/types/index.ts:97`; `ENFORCEMENT_CLASSES`,
`src/core/services/mcp-handlers/enforcement-policy.ts:35`), resolved per finding by
`resolveEnforcementClass` (`enforcement-policy.ts:186`) over the registered codes in
`FINDING_CODE_REGISTRY` (`enforcement-policy.ts:81`). The `openlore enforce` gate blocks when at
least one finding resolves to `blocking` (`src/cli/commands/enforce.ts:9`) — which on a
brownfield repo with hundreds of pre-existing findings means flipping a code to `blocking` blocks
the very next commit on ALL of them at once. So the practical steady state is the one the CLI
itself installs: "advisory (never blocks) until enforcement.policy … maps a finding code to
'blocking'" (`enforce.ts:97`) — everything stays advisory, and drift accumulates through a gate
that exists but cannot be turned on. Sibling `widen-architecture-rule-vocabulary` makes this
acute: its new rule findings (`architecture-cycle`, `architecture-orphan`, …) will fire in bulk
on day one of any real repo — exactly the findings that need a freeze-then-ratchet path to be
adoptable at all.

## What changes

- **A fourth enforcement class, `frozen`** — added to the `EnforcementClass` union,
  `ENFORCEMENT_CLASSES`, and the `resolveEnforcementClass` ladder. Categorical, like the other
  three: no threshold, no constant.
- **Baseline store, plain text, committed.** An ordinary `openlore enforce` run explicitly
  bootstraps successfully assessed frozen codes into a human-readable JSON-lines file under
  `.openlore/`. Per-code initialized records preserve the difference between "initialized at
  zero" and "never initialized." The managed ignore rules make both the policy config and
  baseline visible to normal Git staging. Hooks and review never bootstrap candidate debt.
- **Finding identity = `code` + `subject` (+ a stable discriminator** where one code can fire
  more than once per subject). The unified `GovernanceFinding` shape already carries stable
  `code` and `subject` fields (`enforcement-policy.ts:47-57` —
  `{ code, severity, source, subject, message }`); identity deliberately excludes `message` and
  any file:line, so baseline matching is **line-number-insensitive by construction** — moving a
  frozen violation within its file does not un-freeze it.
- **Gate semantics.** A `frozen`-classed finding present in the baseline reports as frozen
  (advisory, labeled); one absent from the baseline blocks like `blocking`. Output always
  discloses the ratchet state: "312 frozen, 2 new → blocked on the 2."
- **The ratchet is trusted and shrink-only.** Once a code is initialized, hook/review compare the
  candidate baseline with the trusted committed baseline. Removals are legal after a complete
  assessment; added identities or removed initialized markers fail integrity checking. Hooks
  require shrinkage to be staged. Partial or failed assessment never removes trusted entries.
- **Surfaces.** `openlore enforce` owns bootstrap and ratchet writes. `openlore review` and the
  bundled Action apply the same frozen/new semantics to the blast-radius orphan findings already
  computed for the briefing, read-only; they direct the operator to run enforce for shrinkage.
  A policy downgrade (`frozen` → `advisory`) preserves the store byte-for-byte, and re-upgrading
  resumes against it.

Deliberately NOT borrowed from ArchUnit: freezing by violation-message text (fragile — identity
here is the structural `code`+`subject`, so a reworded message or moved line never un-freezes),
its per-rule ViolationStore plumbing and JVM configuration surface, and any
`allowStoreUpdate`-style mutable-store toggle — the only writes are the explicit first freeze and
the automatic shrink-only ratchet removal, both visible as VCS diffs. Baseline growth for an
already initialized code is deliberately rejected even if it is staged or committed on the
candidate branch.

## Why this is in scope

The enforcement machinery is built (registry, resolver, gate, review action) and doctrinally
advisory-by-default; what is missing is the adoption path from advisory to blocking on a repo
with history. `frozen` is that path — a categorical class in the existing resolver, a plain-text
file, zero constants — and it is what lets the sibling's new architecture findings, and every
already-registered code, actually gate on brownfield repos.

## Impact

- Files: `src/types/index.ts` (union), `mcp-handlers/enforcement-policy.ts` (class, resolver,
  baseline match), a small baseline read/write module beside it, `src/cli/commands/enforce.ts`
  (gate semantics + disclosure), `src/cli/commands/review.ts` / review action (frozen rendering).
- Specs: `mcp-handlers` — 1 ADDED requirement (EnforcementBaselineRatchet) — matching the
  sibling's enforcement-delta domain.
- Tool surface: unchanged (no new tool; no payload-budget impact).
- Risk: baseline merge conflicts on busy repos (mitigated: one finding per line, sorted stable —
  conflicts are line-local and legible); identity collisions where one code fires repeatedly on
  one subject (mitigated: the stable discriminator, spelled out per source).
