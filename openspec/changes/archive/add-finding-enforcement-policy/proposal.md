# Finding enforcement policy: one declarative table for what blocks, what advises, what is silenced — and a first new finding to flow through it

> Status: IMPLEMENTED (2026-06-23). Shipped on branch `feat/finding-enforcement-policy`. The unified
> policy core, the `stale-decision-reference` finding, `recall` surfacing, and the `openlore enforce`
> gate are built, unit- + e2e-tested, and dogfooded in a real git pre-commit. One scoped deferral: the
> `verify_claim` clause of `StaleDecisionReferenceSurfacedThroughExistingTools` (its claim model is
> structural-only, with no decision-reference claim to rest on — `recall` + the gate cover the surfacing
> intent). See the spec status notes in `openspec/specs/{config,mcp-handlers,cli}/spec.md`.
>
> Additive governance change. No new MCP tool and no default-surface
> growth. Two composable parts: (A) a unified, config-driven enforcement policy that decouples a
> finding's *severity* from its *enforcement class*, replacing the per-surface opt-in-blocking configs
> that several features each reinvented; and (B) the first new deterministic finding authored to flow
> through that policy — a live, authoritative artifact that references a superseded decision. Builds on
> the decisions gate, `add-preflight-blast-radius-guard` (opt-in blocking precedent), and
> `add-change-impact-certificate` (`impactCertificate.surfaces` severities). Grounded in the north star
> (`c6d1ad07`): deterministic, locally-computed, no LLM.

## Why

OpenLore already emits governance findings from several deterministic sources — the decisions
pre-commit gate, the pre-flight blast-radius guard (`add-preflight-blast-radius-guard`), and the change
impact certificate (`add-change-impact-certificate`). Each one grew its **own** way to express "should
this block a commit or merely inform?": the blast-radius guard takes `block: [<pattern>]`, the impact
certificate takes `impactCertificate.surfaces[].severity` plus `block: ["critical"]`, and the decisions
gate hardcodes its own blocking semantics. The result is three different config shapes, three different
defaults, and no single place an operator can read to answer "what will actually fail my commit here?"

This couples two things that should be separate: **how serious a finding is** (a property of the
finding, owned by the code that computes it) and **whether this repository wants it to block** (a
property of the repository's risk posture, owned by config). Coupling them means every new finding
source must re-derive an enforcement story, and an operator must learn N of them.

The fix is one declarative table. A repository declares, in `.openlore/config.json`, a map from stable
**finding code** to **enforcement class** — `blocking`, `advisory`, or `off` — with deterministic
precedence. Every finding source emits findings carrying a stable code and its intrinsic severity; the
gate consults the single policy to decide the class. Advisory stays the default, so a repository that
declares nothing behaves exactly as it does today. This is the missing single source of truth, and it
is pure config plus a pure policy pass — no LLM, no new tool.

The second part proves the table on a finding OpenLore should already be surfacing but does not. OpenLore
tracks decision supersession (`supersedes`, queryable through `asOf`) and anchors memory to symbols. But
a **live, authoritative artifact that still points at a decision that has since been superseded** is
currently only discoverable by manually walking history. That is a textbook stale-reference: the artifact
asserts something whose stated basis has been retired. Making it a first-class deterministic finding —
`stale-decision-reference` — and routing it through the new policy is the smallest end-to-end proof that
the table works, and it closes a real integrity gap in the code-anchored governance layer.

## What changes

1. **A unified enforcement-policy declaration.** `.openlore/config.json` MAY carry an
   `enforcement.policy` object mapping a stable finding **code** to one of `blocking | advisory | off`.
   The map is additive and optional; an absent or empty policy preserves today's behavior exactly.

2. **Deterministic precedence, severity-independent.** Enforcement class is resolved by a pure function
   of (the finding's code, the policy, the finding's intrinsic severity) with a fixed precedence:
   an explicit `off` for a code wins over everything (a deliberate silence), then an explicit
   `blocking`, then an explicit `advisory`, then the source-declared default for that code. Resolution
   is order-independent and produces identical output for identical inputs.

3. **Findings carry a stable code and an intrinsic severity.** Every governance finding source
   (decisions gate, blast-radius guard, impact certificate, and the new finding below) SHALL emit each
   finding with a stable, documented `code` and an intrinsic `severity`, so the one policy can govern
   all of them. The existing per-surface `block: [...]` configs become thin sugar over, and are
   superseded by, the unified policy.

4. **One gate consults one policy.** The pre-commit / pre-merge gate SHALL collect findings from all
   sources, resolve each finding's class through the single policy, and fail only when at least one
   `blocking`-class finding is present — sorting findings by a stable key so output is reproducible.

5. **A new finding: `stale-decision-reference`.** OpenLore SHALL deterministically detect when a *live,
   authoritative* artifact (an approved decision, a non-orphaned anchored memory, or a spec requirement)
   references a decision that has been **superseded** or otherwise retired, and SHALL emit it as a
   finding with code `stale-decision-reference` carrying both the referencing artifact and the retired
   target. The supersession edge that performed the retirement is exempt (it is *supposed* to point at
   the retired decision). The check is a pure walk of the decision graph and anchored references — no LLM.

## What does NOT change

- **Advisory by default.** A repository that declares no `enforcement.policy` behaves exactly as today;
  nothing newly blocks. Blocking is always opt-in, consistent with `add-preflight-blast-radius-guard`.
- **No LLM.** Class resolution is a pure function; the stale-reference finding is a deterministic graph
  walk. The north star (`c6d1ad07`) holds.
- **No new MCP tool and no default-surface growth.** This is config plus a policy pass plus one finding
  computed by existing surfaces (recall / verify / the gate). It does not enter the lean default preset.
- **Sources still own severity.** The policy decides *enforcement class*, never *severity*; a finding
  source remains the single authority on how serious its findings intrinsically are.
- **No silent suppression of integrity.** `off` is a recorded, inspectable policy entry, not a quiet
  default; the gate output SHALL still list `off`-classed findings as informational so a silence is
  visible, never invisible.

## Application to OpenLore

- **Policy declaration + precedence** live in the `config` domain (`.openlore/config.json`,
  `readOpenLoreConfig`), reusing the existing config read/merge path.
- **Finding codes + class resolution** live in `mcp-handlers`, alongside the existing conclusion-shaped
  finding contracts (`tool-contract.ts`); the resolver is a pure helper the gate and any finding source
  can call.
- **The unified gate** lives in `cli`, generalizing the decisions-gate and blast-radius-guard hook
  posture into one pass over all finding sources.
- **`stale-decision-reference`** reuses the decision store's supersession/`asOf` history
  (`add-bitemporal-typed-memory-operations`) and the anchored-memory freshness model
  (`add-code-anchored-memory-staleness`); it is surfaced by `recall` / `verify_claim` and contributed to
  the gate.

## Out of scope

- **Authoring help for policies.** OpenLore consumes a declared `enforcement.policy`; helping a team
  decide which codes to block is adjacent product work, not part of this change.
- **Per-path / per-directory policy scoping.** The policy is repository-wide. Scoping a code's class to a
  subtree is a possible later refinement, deliberately excluded here to keep resolution a pure,
  order-independent function.
- **New finding sources beyond `stale-decision-reference`.** This change unifies enforcement and proves
  it on exactly one new finding; cataloguing further findings is follow-on work.
- **Auto-remediation.** The gate reports; it does not rewrite the offending reference or re-point it at
  the superseding decision.
