# Public API surface contract: model the exported surface and certify whether a change breaks it

> Status: SHIPPED (2026-06-25, FEATURE-UPDATES proposal 2). Part of the `FEATURE-UPDATES.md` set.
> Adds a first-class **public surface** artifact (the symbols a package/module exports, with their
> signatures) and a deterministic **breaking-change classification** on a diff, plus the opt-in
> conclusion tool `certify_public_surface` + `openlore certify-public-surface` CLI. No graph-schema
> change, no LLM. Complements (does not duplicate) `add-change-impact-certificate`.
>
> **Implemented as:** the pure analyzer module `src/core/analyzer/public-surface.ts` (signature
> parse + breaking-change classifier, no disk), the handler
> `src/core/services/mcp-handlers/public-surface.ts` (surface listing + base-ref diff via
> per-changed-file base/HEAD call-graph snapshots, rename detection through `computeContinuity`,
> in-repo consumer resolution via the edge store, and the `confidence-boundary` known-unknowable
> disclosure for external consumers), the CLI `src/cli/commands/certify-public-surface.ts`, and the
> tool wiring (def/dispatch/contract-as-conclusion/tool-driver, `full`-preset only). Tool count
> 66 → 67; `tools/list` payload budget 72k → 74k. Classification is gated to TS/JS/Python (others
> fail-soft to surface membership). Function exports are signature-classified; **all other exports
> (const/class/type/interface, aliased `export { x as y }`, and generators) are surfaced for
> removal/addition** via a name-level pass so a removed non-function export is never a false "no
> change" — they are not signature-classified (no internal-contract diff).
>
> **Adversarial-review hardening (post-implementation, this PR):** two unsound verdicts were found
> and fixed — a function-type parameter (`cb: (x) => void`) was mis-parsed as optional because the
> signature splitter treated the `=>` arrow as a default `=`, so *adding a required callback* and
> *making a callback required* both read as `non-breaking`; the splitter now consumes `=>` as a token
> (fix in `splitTopLevel`/`parseParam`, regression-tested). Aliased/generator export *removal* (which
> resolved to no call-graph node) silently read as "no change" — fixed by the name-level pass above.
> Phantom exports from `export …` strings inside source were eliminated by stripping string/comment
> literals before the export scan and excluding test files from the surface.
>
> **Second adversarial round (this PR) — three more fixes:** (1) the literal-stripper was a pipeline of
> independent regexes that stripped a `//` *inside* a string (a URL) as a line comment, eating the
> closing quote and cascading into real declarations — another false-`non-breaking`; replaced with a
> single-pass string/comment tokenizer (`blankLiterals`), regression-tested with a `//`-bearing string.
> (2) a **renamed** export reported zero consumers because it looked up the old id while a HEAD-built
> index only has the new id — consumer resolution now unions the old and new ids. (3) the
> `visibility-reduced` (public → private) breaking rule, previously declared but never emitted, is now
> implemented: a symbol still defined in HEAD but no longer exported classifies `visibility-reduced`
> (distinct from a true `removed`), satisfying the analyzer spec's reduced-visibility requirement.
>
> **Deferred (noted):** method-level surface *within* a class; signature classification of
> non-function exports (const/type contract changes); propagating a function's signature change to its
> `export { fn as Alias }` aliases; package `exports`-map narrowing without a source change; cross-repo
> federated consumer resolution is disclosed-as-unknowable rather than resolved (the federation resolver
> hook is the follow-up). Re-exports (`export { X } from …`) count toward the diff verdict (their
> removal is breaking) but are omitted from the no-base surface *listing* (whose definitions live
> elsewhere) — an intentional asymmetry. Type-syntax equivalences the union-subset model can't see
> (`Array<string>` vs `string[]`) resolve to `potentially-breaking` — the safe (over-conservative)
> direction, by design. A latent gap surfaced + fixed locally: `parseJSExports` misses `export async
> function` / generators — `exportedNames` recovers those (shared parser unchanged).

## Why

For a library, a package, or any module with consumers across a boundary, the single highest-value
question a coding agent can ask before shipping is: **"does this change break my consumers' contract?"**
Removing an exported function, renaming it, making an optional parameter required, narrowing a return
type — these are the changes that break downstream builds and APIs, and they are exactly the changes an
agent makes casually while "cleaning up," with no signal that the edit crossed a contract boundary.

OpenLore already extracts exports and signatures, and it already answers reachability ("who calls
this?"). What it does not have is a first-class notion of **the public surface** — the subset of
symbols that are actually part of the contract a package offers the outside world — nor a deterministic
judgment of whether a diff is **compatible** with that surface. A competitor exposes export and
override relationships but stops short of certifying contract compatibility; OpenLore can close that
gap deterministically and turn it into a trustworthy conclusion.

This is distinct from `add-change-impact-certificate`, and the distinction matters. The certificate
computes the *paths a change newly opens into a declared sensitive surface* (reachability into a
boundary). This proposal is about the *shape and compatibility of the declared public contract itself*
— the signatures consumers bind to. One asks "did I open a new route into the data layer?"; the other
asks "did I change the API my consumers compile against?" They compose, but neither subsumes the other.

## What changes

1. **A `PublicSurface` artifact.** The system identifies the symbols that constitute a package/module's
   public surface — those reachable through its declared public entry points (the package manifest's
   `exports`/`main`/`types`, public index barrels, language-level visibility such as the `export`
   keyword or `public`/`pub` modifiers) — and records each with its **signature**: name, parameter list
   (names, order, optionality, and types where statically available), return type where available, and
   kind (function/method/class/type/constant). Entry-point discovery and visibility rules are gated per
   language through the `add-declarative-language-support-registry` seam, so coverage is observable and
   fail-soft.

2. **Deterministic breaking-change classification on a diff.** Given a base and a changed state, each
   public-surface symbol's change is classified deterministically into a fixed, closed set:
   - **breaking** — an exported symbol was removed or renamed (renames detected via
     `add-symbol-identity-continuity`, so a *renamed* export is reported as a rename, not a remove +
     add); a required parameter was added; an existing parameter was removed or made required; a
     parameter or return type was narrowed; visibility was reduced (public → private).
   - **non-breaking** — an optional parameter was added at the end; a new export was added; a return type
     was widened; documentation-only changes.
   - **potentially-breaking** — the change cannot be *proven* compatible from the statically-available
     type information (e.g. an untyped or dynamically-typed signature whose semantics may have changed).
     This class is the honest middle: it is never silently folded into "non-breaking."

3. **The breaking change names its blast radius (conclusion-shaped).** A breaking classification is
   reported with the consumers it breaks: in-repo consumers via the call graph, and — under federation —
   consumers in other indexed repos via cross-repo resolution. Where consumers are outside any indexed
   repo (closed-source or external downstream), the result says so via a confidence-boundary
   known-unknowable note rather than implying "no consumers."

4. **One opt-in MCP conclusion tool, `certify_public_surface`** (and a CLI equivalent). It returns the
   public surface on request, or — given a base ref — the **breaking-change verdict** for the current
   diff: the classified changes, each breaking one paired with its breaking consumers, and an overall
   `breaking | non-breaking | potentially-breaking` summary. It is a conclusion (a verdict + the
   affected consumers), never a graph. It lands in an opt-in preset only and reuses the existing
   confidence-boundary/staleness disclosure channel.

5. **Conservative by construction (honesty).** When type information is insufficient to prove
   compatibility, the classification is `potentially-breaking`, never `non-breaking`. The tool never
   asserts "safe" on evidence it does not have — the same posture as `verify_claim`'s `unverifiable`
   verdict. Determinism: the surface and the classification are pure functions of the indexed states;
   re-runs are byte-identical.

## Decision

**Classify compatibility from statically-available signatures; report `potentially-breaking` rather than
guess.** The classifier uses the signature information the analyzer already extracts (and the type
inference it has for supported languages); it does not run a type checker or a build. Where the
available types are rich enough to prove a change compatible or incompatible, it says so; where they are
not, it returns `potentially-breaking` and discloses why. This keeps the conclusion sound (it never
calls a breaking change safe) without requiring a per-language type checker, and it degrades gracefully
on dynamically-typed code to "I can see the symbol changed but cannot prove compatibility."

## Scope contract — do not break these things

This change must NOT:
- Run a type checker, compiler, or build, or call any package registry. Static, in-process, offline.
- Classify a change as `non-breaking` when compatibility cannot be proven from available types — that
  case is `potentially-breaking`.
- Report a removed export as breaking when it was in fact renamed — rename detection (continuity)
  reclassifies it as a rename with its new name.
- Add a graph node/edge schema field or enter the minimal/first-run tool surface. The tool is opt-in.
- Duplicate `add-change-impact-certificate`. That certifies newly-opened paths into a surface; this
  certifies the compatibility of the exported contract's shape.

## Out of scope (deferred)

Semantic/behavioral breaking changes that are not visible in the signature (a function that keeps its
type but changes its behavior); semver recommendation/automation (the verdict can *inform* a semver bump
but this change does not own version policy); cross-language API boundaries (e.g. a TypeScript client
binding a Python service — that is the cross-service topology's domain); and binary/ABI compatibility.

## Implementation status

Tracked in `tasks.md`. Verified by fixtures for each classification (removed export, renamed export via
continuity, added-required-param, narrowed return, added-optional-param non-breaking, untyped →
potentially-breaking), a consumers-named test (a breaking change lists its in-repo callers; under
federation, cross-repo consumers), and a determinism test.
