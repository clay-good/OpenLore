# Add resource-lifecycle conclusions: which path leaves the handle open

> Status: PROPOSED (2026-07-27, substrate-whitespace sweep). The exceptional-control-flow half of
> this question already ships (`analyze_error_propagation`); the resource half reuses the same CFG
> knowledge and answers the question that actually costs production incidents.

## The gap

`analyze_error_propagation` computes which exceptions escape a function and which are caught
inside it, from the CFG overlay's throw/try node knowledge. It stops one question short of the
consequence: **when that exception escapes, what was still held?** A file handle, a database
connection, a transaction, a lock, a spawned child — acquired on line 4, released on line 30, with
a `throw` on line 12 in between and no `finally`.

This is decidable from facts already stored. The CFG (`src/core/analyzer/cfg.ts:35`, `:41`) gives
the blocks and edges, including the exit paths; def-use (`cfg.ts:52`) tracks the acquired value
from its definition to its uses; the language-scoped throw/try knowledge is already extracted.
What is missing is the pairing rule and the traversal — no new grammar, no new artifact, no new
parse pass. Today an agent asked "is it safe to add an early return here" gets a caller list and
no way to learn that the early return skips a `release()`.

## What changes

**`analyze_resource_lifecycle`** (`--preset full`; CLI `openlore resource-lifecycle [--symbol
<name>]`): for each acquisition site inside a function, report the paths from acquisition to
function exit and whether each releases.

- **A closed, per-language pairing table.** Acquire/release pairs are a fixed vocabulary
  (`open`/`close`, `connect`/`end`, `acquire`/`release`, `begin`/`commit`|`rollback`,
  `createReadStream`/`destroy`, and the language equivalents), plus the **scope forms that release
  automatically** — Python `with`, Go `defer`, TypeScript `using`/`await using`, `try/finally`.
  A scope form is recognized as a release on every path, which is what makes the common correct
  code quiet.
- **Per-path verdicts**: `released-on-all-paths`, `unreleased-on-path` (with the exact escaping
  path: the branch or throw line, and the exit it reaches), or `undecidable`.
- **Joined to the error graph**: an `unreleased-on-path` whose escaping path is an exception path
  names the exception type from `analyze_error_propagation`, so the two conclusions compose into
  "this connection leaks when `QueryError` escapes" — computed, not narrated.
- **Callers and tests**: the upstream callers of a leaking function and the tests that reach it,
  from the shipped traversals.

Honesty: `undecidable` is the default outcome whenever the analysis cannot ground a verdict — a
release through an alias or a helper the resolver refused to guess, a pairing outside the closed
table, an unsupported language (explicit `unsupported`, never an empty result), or a truncated
traversal. The tool reports **paths it can prove lack a release**, and never claims a resource is
correctly released; the absence of an `unreleased-on-path` verdict is not a safety claim, and the
result says so. Language scope is the CFG-overlay set with the required node knowledge:
TypeScript/JavaScript, Python, Go.

Deliberately NOT built: alias/points-to analysis, ownership transfer inference across function
boundaries (a resource returned to the caller is `undecidable`, never "leaked"), user-defined
pairing rules (the table is closed until demand shows otherwise), runtime leak detection, and any
default-blocking behavior — one registered finding code, advisory, gateable only by explicit
policy.

## Why this is in scope

Same substrate, same doctrine, one more question the stored overlay can already answer and no call
graph can. It composes with two shipped conclusions rather than duplicating them — the sibling
cross-references are `analyze_error_propagation` (which exception escapes; this says what was
held when it did) and, if it ships, `add-shared-state-hazard-conclusions` (which shares the
overlay-join architecture but answers about data coupling, not acquisition lifetime).

## Impact

- Touches: a new handler over the persisted CFG/def-use overlay; the closed pairing table as a new
  constant module; reuse of the error-propagation evaluator (exported, not forked); one finding
  code in `FINDING_CODE_REGISTRY`.
- Tool surface: +1 tool in `--preset full` only; family `navigate`; `conclusion` class.
- Specs: `mcp-handlers` — 1 ADDED (ResourceLifecycleVerdictsAreProvenLeakPathsOnly).
- Risk: pairing-table blind spots (mitigated: an unmatched pairing is `undecidable` and disclosed,
  so a gap reads as a gap); false leaks from ownership transfer (mitigated: returned/stored
  resources are `undecidable` by rule, tested first).
