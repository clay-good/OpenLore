# Governance arrives as evidence at four moments, with one small tool set for the plugin

> Priority: P1 · Not built
> Reaches the agent through: the four hook moments (prompt submitted, before an edit, after an edit, before stop) and the existing answers `orient`, `blast_radius`, `verify_change`, `verify_claim`, `recall`
> Why it helps the agent: it gets proof it can act on at the moment it can still act, and it chooses from 11 tools, not 83.

## Problem

- OpenLore has 83 MCP tools. New capability has been added as new tools, so the agent must know
  which tool to call and when. Most governance value is never pulled.
- The `certify_*` tools and `change_impact_certificate` compute strong evidence, but no hook moment
  calls them (`grep certif src/cli/commands/hook.ts` returns nothing). An agent sees a public-API
  break only if it thinks to ask.
- The docs say "blocking is always opt-in". That is not true: 7 `corpus-integrity` codes block by
  default (`enforcement-policy.ts:483-518`), and they force `openlore enforce` to run its gate
  comparison in a repo that declared no policy (`enforce.ts:806-812`).
- The Claude Code plugin has no fixed tool set. The npm default (`substrate`, 15 tools) has no
  `verify_change` and carries 2 OpenSpec-only tools.
- The north star in `overview` does not say when evidence reaches the agent or what the agent does
  with a finding.

## What changes

1. **North star (`overview`).** OpenLore delivers deterministic evidence to the agent at four
   moments. Each finding carries proof and leads to one of three actions: fix it; decide, and record
   the decision with a link to the proof; raise it to a human in the agent's own final message or PR
   body. It is quiet unless something is new and real.
2. **Moments, not tools (`architecture`).** New capability reaches the agent as evidence at a hook
   moment, or as a field or finding on `orient`, `blast_radius`, `verify_change`, `verify_claim` or
   `recall`. It does not add an MCP tool.
3. **Quiet by default (`mcp-quality`).** A moment emits no finding when nothing is new and real. A
   finding is stated once per session. Each emitted finding names its proof and one action:
   `fix`, `decide` or `raise`.
4. **`verify_change` in the default, and one plugin tool set (`mcp-quality`,
   `src/cli/commands/mcp.ts`).** `verify_change` joins `substrate` (16 tools), gated by the
   benchmark protocol. A new preset entry `plugin`, a subset of `substrate`, has 11 tools:
   `orient`, `search_code`, `get_subgraph`, `analyze_impact`, `find_path`,
   `get_function_skeleton`, `suggest_insertion_points`, `recall`, `verify_claim`, `blast_radius`,
   `verify_change`. No spec-generation tool is in the plugin set.
5. **Certificates become evidence sources.** The before-stop moment may call
   `certify_public_surface`, `certify_service_contract` and `change_impact_certificate` in process,
   each only on its trigger and inside a time slice. See the table in `design.md`.
6. **Advisory by default, with no exception.** The 7 `corpus-integrity` codes change their source
   default from `blocking` to `advisory`. The stale comment above `applyPolicyPrecedence` is fixed.

## What does not change

- No tool is renamed, aliased or removed. All 83 tools stay in `TOOL_DEFINITIONS` under their
  current names.
- The npm default stays the `substrate` preset. Its 15 tools stay; `verify_change` is added
  (16), only if the benchmark shows no regression.
- Every tool outside the plugin set stays available through `openlore mcp --preset <name>`,
  `--preset full`, `openlore install --preset <name>`, the CLI commands, and Pi.
- Pi keeps its surface: `NAV_TOOLS` (46) and `PI_EXCLUDED_CONCLUSION_TOOLS` (36) are not edited.
  The two-direction parity guard keeps passing.
- `enforcement.policy` stays in the code with the same precedence. A repository that set a policy
  gets the same result as today for every code the policy names.
- Hooks stay fail-open and local. No network call, no LLM, no new service.
- `plugin/.mcp.json` and `plugin/hooks/hooks.json` belong to the `ship-claude-code-plugin` change.
  This change defines the set in `src/` and in the specs only.

## Limits we disclose

- **Migration.** A repository that relied on the default block must add the 7 codes to
  `enforcement.policy` as `blocking` (the exact lines are in `design.md`). The CHANGELOG must say
  so under "Changed". Without that line, `openlore enforce --hook` no longer fails a commit on a
  broken corpus reference; the finding is still reported.
- `openlore doctor` keeps reporting a corpus graph error as `fail`. It reads severity, not the
  enforcement class (`doctor.ts:482-485`).
- The 11-tool list is chosen from the preset tables and from how often the 11 shipped skills name
  each tool. There is no usage telemetry to measure real call counts.
- `prepare_spec_generation` and `prepare_spec_repair` are not in the plugin set. The
  `openlore-generate` and `openlore-repair` skills call them, so the plugin change must decide how
  those skills reach them.
- `certify_provenance` and `certify_merge` are called at no moment. One writes an attestation, the
  other needs two branches. Both stay pull tools.
- Public-surface findings cover TypeScript, JavaScript and Python only. A slice that times out says
  nothing; the moment never reports "no break" for a check that did not finish.
- The prompt-submitted moment carries orientation context, not findings. The quiet rule governs
  findings. This change does not move `orient --inject` into `HOOK_MOMENTS`.

## Owner decision (2026-11-14, ADR-0037)

Add `verify_change` to `substrate`; keep a separate `plugin` set that is a subset of it, with no
spec-generation tool. See `design.md` section 1 for the benchmark gate and its fallback.

## Depends on / order

- Shipped: `LoopMomentsReceiveBudgetedReceipts` and `LoopHooksAreAdvisoryUnlessPolicyBlocks`
  (`cli` spec), the per-session dedupe (`hook.ts:232-262`), `PresetMembershipIsEnforcedAtDispatch`.
- `ship-claude-code-plugin` (PR #727, other owner) consumes the `plugin` preset. Land task group 2
  first; the plugin then starts `openlore mcp --preset plugin`.
- `stop-hook-speaks-to-agent` (P2) is not planned here. Today the before-stop receipt goes to the
  user, and the model sees it only on a policy block. Until that item lands, the evidence added in
  task group 3 reaches the user at stop, and reaches the agent through `verify_change`.
- Order inside this change: 1 (advisory default) → 2 (preset) → 3 (evidence sources) → 4 (proof and
  action fields) → 5 (docs and guards). Each group is one small PR.
