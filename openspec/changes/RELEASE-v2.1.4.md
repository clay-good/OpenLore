# Release v2.1.4 (from v2.1.3)

The largest release since v2.1.2 — the integration point for **everything merged since the `v2.1.3`
tag (PRs #183–#216)** plus the **substrate-unification** work and the **call-graph modularization**
(PR #217). Staged by a `chore(release)` bump of `package.json` + `package-lock.json` to `2.1.4`; the
release workflow's tag↔version guard then validates the `v2.1.4` tag, runs lint/typecheck/tests, and
publishes to npm. The runtime version is read from `package.json` at startup, so `--version` and the
`tools/list` banner track the bump automatically.

Everything here is **additive and backward-compatible** — no breaking changes to tools, schemas, or
stored data; callers that ignore the new fields/modes see prior behavior. Every capability is
**deterministic and local-first** (no LLM in any serving path, no API key required), per the north-star
decision `c6d1ad07`.

> **Tool surface:** **72 tools**, now organized into **6 capability families**. The default MCP surface
> is unchanged — the lean **10-tool `navigation`** preset; the full 72-tool surface stays opt-in
> (`--preset full`). New this release: a `substrate` preset and `openlore mcp --list-tools`.

---

## 1. One substrate, two faces — capability families + `substrate` preset (PR #217)

OpenLore's ~72 tools had grown into a flat registry that read like two bolted-together products. This
release names what it actually is: **one deterministic structural substrate with two faces** — a *read*
face that navigates the graph (`orient`, `find_path`, `analyze_impact`, …) and a *write/check* face
that anchors facts and weighs changes (`recall`, `record_decision`, `verify_claim`, `blast_radius`,
`change_impact_certificate`, the commit gate).

- **Capability-family taxonomy.** Every tool declares exactly one of six **closed** families —
  `navigate` · `change` · `remember` · `verify` · `coordinate` · `federate` — surfaced in each tool's
  MCP `annotations.family`. A wide surface stays discoverable by family instead of a flat list of 72
  names. `tool-contract.test.ts` fails CI if a tool forgets a family.
- **`substrate` preset.** The navigation graph-traversal core plus the three highest-value governance
  *reads* (`recall`, `verify_claim`, `blast_radius`) — both faces out of the box. Per ADR-0022's
  evidence rule the **active default stays `navigation`** until an agent benchmark clears the wider
  one; `substrate` ships as a selectable preset.
- **`openlore mcp --list-tools`.** Prints the active surface grouped by family (and exits) — the
  human-facing counterpart to the on-the-wire `annotations.family`.
- **No redundant conclusions.** Genuinely-adjacent tools (e.g. `find_clones`↔`get_duplicate_report`,
  `select_tests`↔`report_coverage_gaps`, `blast_radius`↔`structural_diff`↔`change_impact_certificate`)
  now cross-reference each other in their descriptions, enforced by the contract test.

No new tool, dependency, LLM, or persisted artifact. Reference:
`openspec/changes/unify-navigation-and-governance-substrate/`.

## 2. Call-graph builder modularized behind a stable barrel (PR #217)

`src/core/analyzer/call-graph.ts` — the repo's most-imported file (~155 importers) — went
**5,425 → 4,745 lines**, decomposed into six cohesive sibling modules (`call-graph-types`, `-extract`,
`-external`, `-complexity`, `-cfg`, `-builtins`). `call-graph.ts` **re-exports every previously-importable
name**, so none of the 155 importers moved and the public surface is byte-for-byte identical
(23 exported names, 0 added/removed). Each extraction was verified **byte-identical** by a graph+helper
snapshot oracle and the full analyzer suite — graph output is unchanged. A `stable call-graph barrel`
test locks the invariant; the remaining higher-coupling sections are intentionally deferred with a
documented value-vs-risk rationale. Pure internal hygiene: no feature, dependency, or LLM.

## 3. New agent-facing conclusion tools (since v2.1.3)

A batch of deterministic, local-first conclusion tools (all opt-in via `--preset full` unless noted):

- **`certify_public_surface`** (#207) — breaking-change verdict over a working-tree diff: each changed
  export classified `breaking` / `non-breaking` / `potentially-breaking`, paired with the in-repo
  consumers it breaks. Conservative by construction (never silently "safe").
- **`get_style_fingerprint`** (#208) — a descriptive, deterministic per-language idiom profile so an
  agent matches the house style instead of its training prior. `orient` also carries a compact
  `regionStyle` line.
- **`briefing_since`** (#209) — ranks what changed since a base ref into a fixed tier order
  (surprising-change > hub-change > chokepoint-change > ordinary) from existing labels, not a weighted
  score.
- **`find_clones`** (#212) — the edit-time "does a near-duplicate already exist?" one-vs-all query, the
  scoped companion to the whole-repo `get_duplicate_report`.
- **`analyze_error_propagation`** (#213) — the exceptions that escape a function vs. those caught
  within it (TS/JS/Python), the error-handling analogue of `analyze_impact`.
- **`analyze_env_impact`** (#215) — "what breaks if I remove this env var?": line-precise read sites,
  the upstream blast radius, tests to run, and per-site required/soft classification.
- **`report_coverage_gaps`** (#204) — important code with **no reaching test**, ranked by
  hub/chokepoint significance; the structural inverse of `select_tests`.
- **`get_language_support`** (#203) — the deterministic per-language capability matrix, so a quiet
  result reads as "unsupported here" vs. "nothing found."
- **`plan_parallel_work`** / **`map_in_flight_conflicts`** (PARALLEL-WORK; #199–#202) — schedule N
  proposed tasks into safe-to-dispatch waves, and map collisions across every change already in flight
  (branches/PRs/agent tasks) from each change's actual diff.
- **`change_impact_certificate`** / **`working_set_context`** / **`spec_store_status`** (#178–#181) —
  the external spec-store arc: certify the paths a diff newly opens into a covering surface, assemble a
  token-budgeted cross-target briefing, and report spec-store binding health.

## 4. Substrate correctness — the floor under every conclusion

- **Call-resolution recall** (#205) — re-export/barrel resolution (TS/JS) and Python relative imports
  threaded into Pass-2 resolution, with `re_export` provenance. Recovers edges a "nothing reaches X"
  answer previously missed.
- **Symbol-identity continuity** (#206) — a renamed or moved symbol carries its anchored memory and
  decisions forward at the next `analyze` (with `carriedAcross` provenance) instead of orphaning it.
- **Stable nested-function identity** (#214) — same-named nested functions no longer collapse to one
  node (scope-qualified ids), so a function reachable only through one of them stops looking dead.
- **Index integrity attestation** (#196) — a deterministic post-build self-check so a half-built or
  schema-mismatched graph is never served as if complete; it degrades loudly, never silently.

## 5. Onboarding, distribution & freshness

- **Zero-interaction onboarding + auto-update + self-bootstrapping MCP server** (#216) — a CI-guarded
  postinstall hint, a non-blocking background cold-start index build when the MCP server is wired
  without a prior `openlore install`, a fully non-interactive `connect --yes`, a passive "update
  available" notifier, and an `openlore update` command.
- **Shareable graph artifact** (#210) — `openlore export` / `import` a portable, schema-versioned,
  integrity-stamped `.olbundle` so a team indexes once and bootstraps everywhere (validate-or-rebuild).

## 6. New language & infrastructure coverage

- **IaC ecosystems** — Docker + docker-compose (#193), GitHub Actions CI DAGs (#194), and Azure Bicep
  (#195) on the spec-07 IaC projector.
- **Cross-service HTTP topology** (#211) — client call-site → server route edges, within a repo and
  across federated repos, fixing the single-repo Express case and adding the cross-repo route bridge.

## 7. Pi extension parity

The Pi host gained native tools for `blast_radius` / `structural_diff` (#198), `get_map` /
`get_landmarks` / `find_path`, `verify_claim`, `remember` / `recall`, and the spec-drift / decision-gate
tools, plus task-scoped context injection at `before_agent_start` parity with `orient --inject` (#197).

---

## Verification

- `npm run build` clean; `tsc --noEmit` clean; `eslint` clean.
- Full suite green: **279 files / 5,534 tests** (2 skipped).
- Real `openlore analyze` end-to-end over the whole repo (893 files, ~7,700 functions): exit 0, sane
  artifacts, index-attestation passed.
- Call-graph public export surface byte-identical to the pre-refactor state (23 names, 0 added/removed).
- README demo GIF auto-recorded from a real terminal session (charmbracelet/vhs) running the actual
  `openlore` CLI against this repo.

**Full Changelog:** https://github.com/clay-good/OpenLore/compare/v2.1.3...v2.1.4
