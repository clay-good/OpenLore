# Codebase style fingerprint: a deterministic, per-language idiom profile an agent reads before editing

> Status: IMPLEMENTED (2026-06-26, branch feat/codebase-style-fingerprint). Part of the
> `STRUCTURAL-CONTEXT-PATTERNS.md` set (proposal 1). Adds one analyzer artifact (an idiom-frequency
> profile computed in the existing call-graph parse pass — no second parse) persisted as
> `style-fingerprint.json`, one opt-in MCP conclusion tool `get_style_fingerprint` (+ `openlore
> style-fingerprint` CLI), an `orient` `regionStyle` summary, and watcher incremental refresh. The
> language-support registry now derives the `styleFingerprint` capability from
> `STYLE_FINGERPRINT_LANGUAGES` (TypeScript/JavaScript/Python/Go); all others fail-soft. No
> graph-schema change, no new dependency, no LLM. Dogfooded on this repo (TS: declaration-form 0.70,
> const 0.93, await 0.99, camelCase 0.998; Go `functionNaming` → `enforced` null; thin Python →
> `below_floor`). Tool surface 67 → 68.

## Why

A coding agent asked to add a function writes it the way its *training distribution* writes
functions — arrow vs. `function` declaration, ternary vs. `if`, `const` vs. `let`, `await` vs.
`.then`, early-return vs. nested branch, the project's naming case. When the surrounding codebase
has a strong, consistent house style, the agent's default frequently fights it, and the diff reads as
foreign even when it is correct. Today OpenLore can tell an agent *where* to make a change (`orient`,
`suggest_insertion_points`) and *what* it will affect (`analyze_impact`, `blast_radius`), but nothing
tells it *how this codebase actually writes code* — so style conformance is left to the model's prior
or to an out-of-date, hand-maintained style guide that no tool can see.

This is recoverable deterministically and for almost free. OpenLore already parses every file to a
tree-sitter AST and already walks it to extract functions, calls, and signatures. The same walk can
tally a small set of **idiom counters** — descriptive frequencies of the syntactic choices a codebase
makes — and roll them up per file, per community/region, and per repository. The result is an
**empirical** style profile: not a linter's prescription of what *should* be, but a measurement of
what the code *is*. An agent reads it before editing and matches the dominant idiom; a reviewer reads
it to spot a diff that diverges from the local norm. Because it is recomputed on every analyze, it
never goes stale the way a checked-in `STYLE.md` does.

The peer system this borrows from computes the profile cheaply alongside its other per-file work,
slices it per language, rolls it up to the community level, and — crucially — **withholds a signal
when there is not enough evidence or when the choice is not the author's to make**. We adopt all
three properties. (Cost note, measured 2026-06: our tally is a second linear AST pass over the
already-parsed tree — no re-parse — using the allocation-free `namedChild(i)` accessors. On a dense
synthetic corpus it adds a single-digit-percent to the per-file extraction phase, negligible against
the full analyze pipeline; it is NOT literally "<1% of the parse." If that cost ever matters, the
pass can be reframed as a tree-sitter query so the native engine, not a JS walk, finds the idiom
nodes.)

## What changes

1. **A new analyzer artifact: `StyleFingerprint`.** During the existing AST walk (the
   signature/call-graph pass, not a second parse), the analyzer tallies a fixed, closed set of
   **idiom counters** per language. Each counter is a pair (or small histogram) of mutually exclusive
   syntactic choices, e.g.:
   - function form: arrow expression vs. `function` declaration vs. method shorthand
   - conditional form: ternary vs. `if`/`else`
   - binding: `const` vs. `let` (where the language has the choice)
   - async form: `await` vs. `.then` chaining
   - early-return vs. nested-branch (return-before-block ratio)
   - string form: template literal vs. concatenation
   - **naming case per scope** (functions, types, constants, locals) — e.g. `camelCase` vs.
     `snake_case` vs. `PascalCase` share
   The counter set is defined per language and is data, not prose, so it tracks the
   `add-declarative-language-support-registry` table as languages land.

2. **Roll-ups at three granularities.** Counters aggregate to (a) the repository, (b) each
   community/region the map already computes, and (c) on request, a single file. A profile is reported
   as **ratios with their sample sizes**, never as bare percentages, so the consumer can see how much
   evidence backs each ratio.

3. **An evidence floor and an enforcement-awareness rule (honesty).**
   - **Sample floor.** A counter whose total observations fall below a fixed threshold reports its
     ratio as `null` ("no signal"), not `0.5` or a misleading extreme. The threshold is a fixed
     constant, not a tuning knob exposed to callers.
   - **Enforcement-awareness.** When a choice is *not the author's to make* — the language or its
     standard compiler/formatter enforces it (e.g. a language that mandates a single naming case for a
     given scope, or a gofmt-style canonical form) — the counter reports `null` rather than a
     ratio that would be a tautology. The profile measures *discretion actually exercised*, not
     compiler-forced uniformity. Which scopes are enforced is declared per language in the same
     registry, never inferred at runtime.

4. **One opt-in MCP conclusion tool, `get_style_fingerprint`.** Returns the repository profile by
   default, a community profile for a given region, or a single file's profile. Output is the labeled
   profile (idiom → `{ dominant, ratio, samples }` or `{ signal: null }`), plus a one-line
   per-language summary. It is a *conclusion* (the measured idiom set), not a graph or a source dump.
   The tool lands in an opt-in preset only; it does not enter `MINIMAL_TOOLS` or the first-run
   default. `orient` MAY include a compact, top-few-idiom summary for the touched region when the
   evidence is strong, behind the same evidence floor, so an agent that never calls the tool still
   gets the dominant idioms for the area it is about to edit.

5. **Determinism & refresh.** Counters are integer tallies over a deterministic AST walk; the profile
   is byte-identical across re-analyses of a fixed repository state. It is recomputed on every analyze
   and incrementally updated for changed files under watch, so it tracks the codebase and never
   presents a stale idiom as current.

## Decision

**Descriptive empirical idiom counters, not a prescriptive style judgment, and no composite "style
score."** The artifact reports *what the code does* with sample sizes, and stops there. It does not
grade a file, rank "good" vs. "bad" style, or blend the counters into a single number — a composite
would be a hidden tuning constant the north star exists to exclude. Ranking and conformance decisions
are the agent's; OpenLore supplies the measured distribution and the evidence behind it. The counters
ride the existing parse pass (no second traversal, no new parser) and are gated by the per-language
registry, so a language with no declared counter set simply contributes nothing (fail-soft), exactly
like the CFG overlay's unsupported-language behavior.

## Scope contract — do not break these things

This change must NOT:
- Add a graph node, edge, or schema field. The fingerprint is a side artifact rolled up from the same
  AST walk, not part of `FunctionNode`/`CallEdge`/`ClassNode`.
- Add a second parse pass or a new parsing dependency. Counters are tallied in the existing walk.
- Emit a prescriptive judgment, a lint diagnostic, or a composite style score.
- Report a ratio below the evidence floor, or for a compiler-enforced choice — those report `null`.
- Enter the minimal/first-run tool surface. The tool is opt-in.
- Use an LLM, a learned model, or a clock; the profile is a deterministic function of the indexed AST.

## Out of scope (deferred)

Auto-rewriting a diff to match the profile; a "style violation" finding or enforcement-policy code
(this is descriptive, not a gate); cross-repo/federated style roll-ups; idioms requiring type
resolution beyond what the AST exposes (e.g. nullability conventions); and any counter for a language
that has no entry in the language-support registry (it lands when the language does).

## Implementation status

Tracked in `tasks.md`. Verified by a fixture repo with a deliberately skewed idiom mix (asserting
dominant-idiom detection, the sample floor returning `null`, and enforcement-aware `null`), a
determinism test (two builds byte-identical), and an integration test that the tool surfaces the
profile through the MCP handler.
