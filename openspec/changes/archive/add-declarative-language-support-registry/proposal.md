# Declarative language-support registry: adding a language is a data row, and coverage is observable

> Status: IMPLEMENTED (2026-06-25) on PR #203. Part of the `STRUCTURAL-CONTEXT-PATTERNS.md` set.
> Consolidates the per-language knowledge OpenLore already encodes (call-graph extractor, CFG `SPECS`
> table, signature extractor, type-inference engine, IaC projector) behind one declarative
> **capability registry** (`src/core/analyzer/language-support.ts`), DERIVED from the live extractor
> structures so it can't drift, and makes per-language coverage queryable two ways: a **Language
> coverage** section in `CODEBASE.md` and the opt-in `get_language_support` MCP conclusion tool.
> No graph-schema change, no new dependency, no extraction-output change, no LLM. Dogfooded on this
> repo (25 detected languages; the dogfood caught and fixed an under-claim for CDK/CDKTF/Pulumi).
> See `tasks.md` for the shipped checklist; canonical reference: `docs/language-support.md`.

## Why

OpenLore's reach is its languages. The single most effective way to make the substrate more useful to
more agents is to cover more of the code they actually edit — and to do it without each new language
being a bespoke integration. Today, adding or extending a language touches several places that each
hold a *fragment* of "what we know about language L":

- the call-graph extractor's per-language node-type handling (`src/core/analyzer/call-graph.ts`),
- the spec-driven CFG builder's `SPECS` table (`src/core/analyzer/cfg.ts`) — already a good
  data-driven precedent, covering 11 of ~18 languages with the rest fail-soft,
- the signature extractor's per-language cases (`src/core/analyzer/signature-extractor.ts`),
- the type-inference engine's language list (`src/core/analyzer/type-inference-engine.ts`, "7
  languages"), and
- the IaC language set for the infra ecosystems (`src/core/analyzer/iac/`).

Because these fragments live apart, three problems recur. **(1)** Adding a language means finding and
editing every fragment, with no single checklist — easy to wire calls but forget signatures, or CFG
but forget type inference. **(2)** *Coverage is invisible.* Nothing answers "for language L, does
OpenLore extract calls? imports? signatures? a CFG overlay? type inference?" — so an agent (or a
user evaluating the tool) cannot tell whether a quiet result means "no matches" or "this language is
only half-supported." **(3)** The honest fail-soft behavior the CFG builder already practices (no
spec → no overlay, never an unsound one) is a per-fragment convention rather than a guaranteed,
uniform contract.

A peer system that spans an order of magnitude more languages does so precisely because each language
is **one declarative capability record** — arrays of the grammar's node-type names for definitions,
calls, imports, branches, decorators — consumed by generic extractors. Adding a language is a data row
plus fixtures, not new orchestration code. We adopt that shape, generalized over the capabilities
OpenLore already has, and we make the resulting coverage matrix a first-class, queryable fact.

## What changes

1. **One `LanguageSupport` registry.** A single declarative table keyed by language. Each record
   names the capabilities OpenLore supports for that language and *how* — as data the generic
   extractors consume, not as control flow. The record references (does not duplicate) the existing
   per-capability data where it already exists in good form (e.g. the CFG `SPECS` entry, the IaC
   projector), and adds the still-implicit pieces (which AST node types are definitions, calls,
   imports; which scopes are compiler-enforced for the style fingerprint; whether type inference
   applies). The registry is the single source of truth for "what we know about language L."

2. **A declared capability set per language.** Each record declares a fixed, closed set of capability
   flags with their backing data, e.g.: `signatures`, `callGraph`, `imports`, `cfgOverlay`,
   `typeInference`, `styleFingerprint`, and (for infra DSLs) `iacProjection`. A flag is either backed
   by data (supported) or absent (fail-soft). There is no partial-credit fiction: a capability is
   present and exercised, or it is not claimed.

3. **A guaranteed uniform fail-soft contract.** A language with no record, or a record that does not
   back capability C, SHALL yield *nothing* for C — never an unsound or guessed result — exactly as
   the CFG builder returns `undefined` for an unspecced language today. The registry makes that
   behavior the contract for every capability, not a per-extractor habit.

4. **An observable coverage report.** A deterministic **coverage matrix** (language × capability) is
   derivable from the registry and surfaced two ways: as a generated section in the codebase/analysis
   artifact (so a human or agent can see exactly what is and isn't covered for the repo's languages),
   and through an opt-in `get_language_support` MCP conclusion tool that returns, for the repo's
   detected languages (or a named language), the supported-capability set. This turns "is L
   supported?" from tribal knowledge into a queryable, honest answer — and turns a quiet tool result
   into an interpretable one ("calls unsupported for L" vs. "no callers").

5. **A documented "add a language" path.** The registry record + its fixtures become the canonical,
   minimal checklist for adding or widening a language: declare the node-type arrays and capability
   flags, drop in fixtures, and the generic extractors and the coverage matrix pick it up. No new
   per-language orchestration code for the capabilities the generic extractors already implement.

## Decision

**A declarative capability registry over the generic extractors — refactor toward data, do not rewrite
the extractors.** This change is a *consolidation and exposure* of knowledge OpenLore already has, plus
the registry seam and the coverage surface. It deliberately does not rewrite the call-graph or CFG
engines, change extraction results for any currently-supported language, or add a parser. The bar is:
the same languages extract the same nodes and edges as before, but "what we know about language L" now
lives in one declarative place, fail-soft is a uniform contract, and coverage is queryable. Languages
already fully handled by bespoke code may be migrated incrementally; the registry must represent them
faithfully from day one even if their extraction path is not yet fully data-driven.

## Scope contract — do not break these things

This change must NOT:
- Change extraction output for any currently-supported language. Same nodes, same edges, byte-stable.
- Add a parsing dependency or a new grammar. This is about *organizing and exposing* existing support.
- Claim a capability for a language the generic extractors do not actually back — the coverage matrix
  must be true, or it is worse than nothing.
- Turn fail-soft into fail-hard. An unsupported capability yields nothing, never an error or a guess.
- Enter the minimal/first-run tool surface. `get_language_support` is opt-in.

## Out of scope (deferred)

Adding any *specific* new language (this change is the seam; new languages land on top of it,
including widening the style fingerprint and the cross-service topology to more languages); a
fully-data-driven rewrite of the call-graph extractor (migration is incremental); user-supplied or
plugin language records at runtime (the registry is in-tree and reviewed); and grammar vendoring
strategy (unchanged).

## Implementation status

Tracked in `tasks.md`. Verified by a registry-completeness test (every currently-supported language
has a record whose declared capabilities match what the extractors actually produce on a fixture), a
fail-soft test (an unspecced capability yields nothing, not an error), and a coverage-matrix
determinism test.
