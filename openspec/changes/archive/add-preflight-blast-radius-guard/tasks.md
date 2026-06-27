# Tasks — Pre-flight blast-radius guard

> Status: IMPLEMENTED (2026-06-18). Phase-2; built after the five memory + dispatch changes. The
> cross-repo-consumers input (`add-multi-repo-federation`) is scoped out and surfaced as a documented
> no-op until federation ships. Decision `987286eb` recorded before the briefing contract + hook posture.

## 1. Briefing computation (orchestration only)
- [x] Given a staged/working diff, compose: affected callers + layers (`analyze_impact`), tests to run
      (`select_tests`), anchored memories/decisions this diff will drift/orphan, stale specs
      (`check_spec_drift`, which already folds in anchored-memory + ADR drift).
      → `src/core/services/mcp-handlers/blast-radius.ts` (`computeBlastRadius`).
- [~] Cross-repo consumers of changed published interfaces (`add-multi-repo-federation`) — scoped out;
      emitted as `federation: { evaluated: false, note }` until federation lands. Documented in caveats.
- [x] Test: a diff touching a hub returns caller count, layers, tests, and any anchored-memory drift.
      → `blast-radius.test.ts` "briefs a hub change".

## 2. Conclusion-shaped output
- [x] Emit a single actionable briefing (counts + named risks + tests), never a graph.
- [x] Test: output is conclusion-shaped; `tool-contract.ts` classification holds.
      → `blast_radius` classified `conclusion`; `assertConclusionShape('blast_radius', b)` asserted in test;
      `tool-contract.test.ts` + `tool-driver.test.ts` cross-checks pass.

## 3. Non-blocking surface + opt-in hook
- [x] Expose on demand (MCP tool `blast_radius`, kept OUT of minimal/navigation/memory presets) and via
      an advisory git hook (`openlore blast-radius --install-hook`, reusing the decisions-hook install
      pattern; marker `# openlore-blast-radius-hook`, coexists with the decisions gate).
- [x] Default is non-blocking; opt-in blocking for specific high-risk patterns
      (`orphans-anchored-memory`, `orphans-anchored-decision`) via `.openlore/config.json`
      `blastRadius.block`.
- [x] Test: default hook exits 0 (advisory); opt-in blocking pattern exits non-zero only on that pattern.
      → `triggeredBlockPatterns` unit tests (fires on its pattern, advisory otherwise, advisory by default);
      verified e2e: `blast-radius --hook` exits 0 on this repo's diff.

## 4. Docs
- [x] Documented the pre-flight briefing and its non-blocking-by-default posture in the `mcp-handlers`
      and `cli` specs, the CLAUDE.md tool table, and a dogfood report (`DOGFOOD-preflight-blast-radius.md`).
