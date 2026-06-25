@.openlore/analysis/CODEBASE.md
@openspec/specs/overview/spec.md

# openlore MCP tools — when to use them

| Situation | Tool |
|-----------|------|
| Starting any new task | `orient` — returns functions, files, specs, call paths, and insertion points in one call |
| Don't know which file/function handles a concept | `search_code` |
| Need call topology across many files | `get_subgraph` / `analyze_impact` |
| "Which tests must I run for this change?" | `select_tests` — backward reachability to the reaching tests |
| "Which important code has NO test reaching it?" / "is the risky part of this change untested?" | `report_coverage_gaps` (opt-in `--preset full`) — the structural inverse of `select_tests` over the whole graph: functions in no test's reachable set, ranked by hub/chokepoint significance (no runtime, no coverage tool). SOUND DIRECTION ONLY — reports "no reaching test", never claims a symbol is "tested" (reachable-from-a-test ≠ behavior-verified). A gap with no caller at all is labeled also-dead (distinct from `find_dead_code`); an untested entry point is untested-not-dead. Scope to a diff (`changedSymbols`/`diffRef`) or region (`filePattern`). Distinct from `get_test_coverage` (spec-tag based). CLI: `openlore coverage-gaps` |
| "What's the blast radius of my diff before I commit?" | `blast_radius` — one advisory briefing: callers/layers, tests to run, anchored memories/decisions that will drift, stale specs |
| "Post a deterministic structural review on a PR" (CLI, no MCP/agent) | `openlore review` — composes `structural_diff` + `blast_radius` into a Markdown/JSON briefing; bundled GitHub Action posts it as one sticky comment. Advisory by default; opt-in gating via `blastRadius.block`. No new MCP tool |
| "What's unreachable / what dies if I delete X?" | `find_dead_code` — cross-language reachability (candidates) |
| Reviewing a change: structural delta + stale callers | `structural_diff` |
| "Did my diff escape its declared write-footprint, and what conflict did that open?" | `structural_diff` with an opt-in `declaredFootprint` (+ `peerFootprints`) — the back-side of `plan_parallel_work`: flags symbols modified outside the declared write-set (out-of-scope / read-set-intrusion / scope-creep), names peers an escape newly conflicts with, and verifies declared `append`s against the realized diff. Advisory; opt-in blocking via `enforcement.policy`. No new tool (change: add-footprint-escape-detection) |
| "What changes together with this / what's volatile?" | `get_change_coupling` — co-change + churn from git |
| Lay of the land / where do regions connect? | `get_map` (region view; pass a communityId to drill in) |
| Find the route from A to B (by name, role, or landmark) | `find_path` (cheapest call path + alternates) |
| Planning where to add a feature | `suggest_insertion_points` |
| Reading a spec before writing code | `get_spec` |
| Checking if code still matches spec | `check_spec_drift` |
| Finding spec requirements by meaning | `search_specs` |
| Checking spec coverage before starting a feature | `audit_spec_coverage` |
| Recording an architectural decision before writing code | `record_decision` |
| Persisting a durable, code-anchored fact for later sessions | `remember` (opt-in `memory` preset) — anchors a note to a symbol/file so it self-invalidates; optional `type` (invariant/gotcha/rationale/…, default note) and `supersedes=<id>` to retire a prior memory (kept queryable via `asOf`); re-recording the same content+anchor updates in place |
| Recalling what's known about code you're touching | `recall` (opt-in `memory` preset) — returns memories with a freshness verdict (never serves orphaned ones as authoritative); two authoritative memories on one symbol surface in `unreconciled`; an authoritative memory that cites a superseded decision carries a `staleDecisionRef` signal (and is not presented as cleanly fresh); optional `asOf`/`changedSince` (commit-ish) for history and a `type` filter |
| About to assert a structural fact to a user ("X is dead", "Y calls Z", "this is safe to change") — or cite a decision ("ADR abc12345 governs this") | `verify_claim` (opt-in `verify` preset) — verify the claim against the graph, then cite the receipt to the human; an `unverifiable` verdict means hedge or read the source. The `decision-current` kind (subject = an 8-char decision id) verifies a decision is still authoritative against the decision store: `refuted` (with the live superseder to cite instead) if it was superseded/rejected — catch a stale citation before it reaches the human |
| "Is my external spec store's binding to its code repos healthy?" | `spec_store_status` (opt-in `federation` preset) — read-only health of the `.openlore/config.json` `specStore` binding: per-target resolution + index freshness, reference presence, conclusion-shaped findings with stable codes; never blocks |
| "Assemble the structural context an active change needs across its target repos" | `working_set_context` (opt-in `federation` preset) — `orient` generalized from one repo to a change's spec-store targets: reads the change's proposal, orients each indexed target on that intent, returns ONE token-budgeted, per-target-attributed briefing (symbols, callers, spec domains, insertion points) + fresh in-scope anchored intent (orphaned withheld, drifted flagged); read-only, never blocks |
| "Certify what my change touches before it lands — does it open a new path into a sensitive boundary?" | `change_impact_certificate` (opt-in `federation` preset) — ONE conclusion-shaped certificate for the current diff: blast radius, the paths the change NEWLY OPENS into each declared covering surface (reachable after but not before — differential, no LLM), drifted specs, tests to run. Decays via the freshness lease (anchored to touched symbols; the spec-store health check re-fires a stale one). Advisory; opt-in blocking only on a configured surface severity. Declare surfaces under `impactCertificate.surfaces` in `.openlore/config.json`. Also `openlore impact-certificate [--base <ref>] [--change <id>] [--json] [--hook] [--save]` |
| "Which of these N tasks can I run in parallel across agents/worktrees, and in what order?" | `plan_parallel_work` (opt-in `coordination` preset) — given a caller-supplied task list (`{ id, seedSymbols?, seedFiles?, writeMode? }`), returns the computed plan: a hazard-typed conflict graph (WAW / shared-append / RAW / WAR / soft-coupling), a wave schedule (wave 1 = dispatch now), and the critical path (minimum sequential rounds with unlimited agents). Stateless and advisory — re-invoke with the remaining tasks to re-plan; no lease, no dispatch. Mark registration-site touches (a dispatcher case, a registry array) `writeMode:"append"` so they are not falsely serialized. WAW conflicts and unorderable RAW cycles surface as policy-shaped governance findings (`parallel-work-conflict` / `parallel-work-cycle`) the invoking caller can gate on via `resolveEnforcementClass`; the bundled `openlore enforce` commit gate does not run the planner, so it never blocks on them |
| "Which changes already in flight — humans' branches/PRs and my agents' tasks — collide right now, within or across the federation?" | `map_in_flight_conflicts` (opt-in `coordination`/`federation` preset) — the *team* version of `plan_parallel_work`: instead of a caller-supplied task list it harvests every in-flight change (local branches, open PRs via `gh`, plus any supplied agent task descriptors) and runs the same hazard classifier across all of them. Each footprint is derived from the change's ACTUAL diff — per-symbol `append` vs `modify` read off the hunks — so two PRs appending disjoint registry entries resolve to `shared-append`, not a false WAW, with no `writeMode` declaration. Returns per conflict: the two actors, hazard class, shared symbols, and a suggested landing order ("land #210 first; it shares `resolveCallSite`'s write-set"). A change whose diff can't be fetched or whose symbols don't resolve is labeled "not assessed", never "no conflict". Read-only, stateless (no watcher/poll/store), advisory; opt-in `federation` matches across repo boundaries by stable id. WAW pairs surface as the policy-shaped `cross-actor-conflict` finding a CI check can gate on |
| "A structural result for a file looks empty — is the language even supported for that?" / "what does OpenLore extract for language L?" | `get_language_support` (opt-in `--preset full`) — the deterministic per-language capability matrix (`signatures`, `callGraph`, `imports`, `cfgOverlay`, `typeInference`, `styleFingerprint`, `iacProjection`) for the repo's detected languages, or a named language (a pure registry lookup; an unknown language returns an honest all-unsupported record). Makes a quiet result interpretable — "calls unsupported for L" vs. "no callers". Fail-soft: an unsupported capability yields nothing, never a guess. Registry is DERIVED from the live extractors so the matrix can't over-claim. See `docs/language-support.md` for the "add a language" checklist |

For all other cases (reading a file, grepping, listing files) use native tools directly.

> **The default MCP surface is lean (change `default-to-lean-tool-surface`):** a bare
> `openlore mcp` / `openlore install` wires the 10-tool `navigation` preset — the Spec 14
> benchmark winner — not all 66 tools. Breadth is opt-in: `--minimal` (governance core),
> `--preset memory` / `verify` / `federation` / `coordination`, or the full surface via `--preset full`
> (`--all-tools`). The decisions-gate workflow below needs `record_decision`, which is **not**
> in the lean default — install with `--preset full` (or `--minimal`) on repos that gate commits.

> **Memory tools (`remember`/`recall`) are opt-in:** they ship in the `memory` preset
> (`openlore mcp --preset memory`), not the default or `minimal` surface, per the
> `mcp-quality` minimize-tool-surface rule.

> **Authoring a new MCP tool?** Classify it `conclusion` or `explicit-topology` in
> `src/core/services/mcp-handlers/tool-contract.ts` — `tool-contract.test.ts` fails until you do.
> Conclusion tools must return the computed answer, not a graph for the agent to traverse.

> **Authoring a new governance finding?** Register its stable `code` (with a source-declared default
> class + description) in `FINDING_CODE_REGISTRY` in `src/core/services/mcp-handlers/enforcement-policy.ts`,
> and emit it in the unified `GovernanceFinding` shape (`{ code, severity, source, subject, message }`).
> A registered code is one an operator's `enforcement.policy` can name and `openlore enforce` can govern;
> the source owns the finding's intrinsic `severity`, the policy owns its enforcement class. Findings stay
> advisory by default — blocking is always opt-in (change: add-finding-enforcement-policy).

> **MCP tool ↔ Pi extension parity.** OpenLore ships the same structural capabilities through two
> surfaces: the MCP tools (`src/core/services/mcp-handlers/*`) and the Pi extension
> (`src/pi/extension.ts` — native tools + the `before_agent_start` context-injection block).
> Whenever you change one, ask whether the other needs the same change, and vice versa:
> - New / changed MCP tool behavior, signature, or output shape → does the Pi extension expose or
>   consume it (native `NAV_TOOLS`, or the injection block), and should it be updated to match?
> - New / changed Pi behavior (injection, gating, rendering) → should the equivalent CLI/MCP path
>   (e.g. `orient --inject`, the Claude Code hook) carry the same logic?
> Keep shared logic in one dependency-light module both surfaces import rather than duplicating it
> (the Pi host must never import the analyzer in-process — it orients via the warm daemon over RPC).
> If parity is intentionally skipped, say why in the PR.

<!-- openlore-decisions-instructions -->
## Architectural decisions

When making a significant design choice, call `record_decision` **before** writing the code.

Significant choices: data structure, library/dependency, API contract, auth strategy,
module boundary, database schema, caching approach, error handling pattern.

```
record_decision({
  title: "Use JWTs for stateless auth",
  rationale: "Avoids session store in infra",
  consequences: "Tokens can't be revoked early",
  affectedFiles: ["src/auth/middleware.ts"],
  supersedes: "a1b2c3d4"  // 8-char ID of prior decision being reversed
})
```

Decisions are consolidated in the background immediately after `record_decision` is called — the pre-commit gate reads the already-consolidated store and adds no LLM latency.

**Performance note**: if you skip `record_decision`, the gate detects unrecorded source changes at commit time and triggers a slow LLM extraction on the *next* commit (~10-30s). Calling `record_decision` proactively keeps every commit instant.

## When git commit is blocked by the decisions gate

If `git commit` fails and the output is JSON with `"gated": true`, do NOT retry silently.
Check the `reason` field and act accordingly:

**`reason: "verified"` — decisions await review:**
Present each decision to the user:
> "The commit is blocked — I found N architectural decision(s) to validate:
> 1. **[id]** Title — rationale
Do you approve? (yes/no)"
For each approval call `approve_decision`, for rejections call `reject_decision`.
Then run `openlore decisions --sync` and retry `git commit`.

**`reason: "approved_not_synced"` — decisions approved but not written to specs:**
Run `openlore decisions --sync` then retry `git commit`. Do not skip this step.

**`reason: "drafts_pending_consolidation"` — drafts were recorded but not yet consolidated:**
Present to the user:
> "N decision draft(s) were recorded but never consolidated. Run consolidation now? (~10-30s)"
If yes: run `openlore decisions --consolidate --gate` and handle the result.
If no: retry with `git commit --no-verify` to skip the gate.

**`reason: "no_decisions_recorded"` — source files staged but nothing recorded:**
Present to the user:
> "Source files are staged but no architectural decisions were recorded. Run fallback extraction to check for undocumented decisions? (~10-30s)"
If yes: run `openlore decisions --consolidate --gate` and handle the result.
If no: retry with `git commit --no-verify` to skip the gate.
<!-- end-openlore-decisions-instructions -->
