# Add refactoring-aware churn: history that follows a symbol across renames

> Status: PROPOSED (2026-07-27, ecosystem research sweep). Detect a small, high-confidence
> catalog of refactoring operations (rename, move, extract-with-clone-evidence) across commit
> ranges, so churn, coupling, and the surprising-change signal follow the symbol instead of the
> path. Prior art: commit-range AST refactoring detection
> (https://github.com/tsantalis/RefactoringMiner; benchmark:
> https://arxiv.org/pdf/2403.05939).

## The gap

OpenLore's history signals are path-exact, and they say so. `briefing_since` carries a standing
caveat that git churn "does not follow renames, so a just-renamed file may read as low-churn and
be over-flagged surprising" (`src/core/services/mcp-handlers/briefing-since.ts:208-211`);
`get_change_coupling` co-change groups break at every file move; the volatility classifier
resets on rename. Meanwhile the machinery that *can* recognize a rename already exists —
symbol-identity continuity (`src/core/analyzer/continuity.ts`) verifies renames by
sentinel-substituted content hash — but it runs only between two adjacent analyze baselines, so
history queries spanning many commits get no benefit.

## What changes

- **A commit-range identity walk**: for a queried range (the same base-ref inputs
  `briefing_since` takes), apply the continuity matcher pair-wise across the commits that touch
  the involved files, producing per-symbol identity chains: `file A:foo → file A:bar (rename @
  c1) → file B:bar (move @ c7)`. Same matcher, same thresholds, no new similarity constant.
- **A closed operation catalog, refusal beyond it**: `rename` and `move` come from the
  continuity matcher's existing verify semantics; `extract` is reported only with clone
  evidence (the extracted body matches a prior span via the shipped duplicate detector). The
  long tail of refactoring types the prior art distinguishes is deliberately not claimed — an
  unmatched disappearance stays "removed", never a guessed "inline/extract-and-move".
- **Consumers re-key on chains**: `briefing_since`'s churn join and surprising-change tier,
  `get_change_coupling`, and the volatility classifier aggregate over the identity chain instead
  of the raw path, each disclosing when a chain was applied ("churn follows 1 rename"). The
  existing caveat text downgrades from a blanket warning to a per-symbol disclosure on the
  ambiguous cases only.
- **Ambiguity is disclosed, not resolved**: where the matcher declines (the same ambiguity rule
  continuity already applies — no first-match binding), the chain ends and the consumer falls
  back to path-exact behavior with the break disclosed.

Deliberately NOT borrowed from the prior-art lineage: its statement-level mapping and ~100-type
refactoring taxonomy (built on fifteen years of single-language machinery; a tree-sitter
approximation of it would guess), and any use as a diff *viewer* — output is re-keyed history
signals, not edit scripts.

## Why this is in scope

It closes a boundary the substrate already discloses, using only shipped machinery (continuity
matcher, duplicate detector, git walk) — the definition of an honest widening. Deterministic and
local; history signals gain recall with no new claim class: every chain link carries the same
verify-semantics receipt continuity already produces.

## Impact

- Touches: a range-walk module over `continuity.ts`, consumers (`briefing-since.ts`,
  `change-coupling`, volatility classifier) re-keyed with disclosure; no new tool (this upgrades
  existing conclusions), no new artifact (chains computed per query, memoized per content hash
  like the Pass-1 cache).
- Specs: `analyzer` — 1 ADDED requirement.
- Risk: walk cost on wide ranges (mitigated: scoped to files the query already touches, memoized;
  the briefing already walks this history for churn); chain errors polluting history (mitigated:
  matcher-declined ambiguity ends the chain — the failure mode is the status quo, path-exact).
