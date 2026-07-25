# Doc-claim sync guards: every quantitative doc claim is CI-guarded or derived from code

> Status: SHIPPED (2026-07-18, PR #230; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). The README/docs state ~20 quantitative claims (tool
> count, preset sizes, language counts, test floor) with no CI guard — the exact figure that has
> already drifted once (docs said "50 tools" when the real surface was 58). Extends the existing
> `honesty-contract.test.ts` guard pattern so a doc number can never silently rot again. Test +
> copy-hygiene only — no runtime change, no LLM. Grounded in the honesty contract and the
> `mcp-quality` guarded-claims discipline.

## The gap

The CLI already self-updates its tool count (`${TOOL_DEFINITIONS.length}` interpolated into the
`--preset` help, `mcp.ts:2714`), and README *benchmark* figures are guarded
(`src/honesty-contract.test.ts:23-63` pins every scorecard number to a `CANONICAL` table). But the
rest of the doc surface states literals with nothing binding them to code:

| Claim | Where (all currently TRUE, all unguarded) |
|---|---|
| "72 tools" | `README.md:244,267,309,332,500`; `CLAUDE.md:47`; `docs/mcp-tools.md:37,43`; `docs/cli-reference.md:112,128,140,149,603`; `docs/agent-setup.md:116,140,142`; `docs/install.md:37`; `docs/governance-dogfooding.md:30` |
| "13-tool substrate" / "10 tools" navigation | `README.md:244`; `docs/agent-setup.md:140,142`; `docs/cli-reference.md:137,147` |
| "18 languages + 12 IaC" badge | `README.md:16` |
| "5500+ tests" floor | `README.md:17,537` |

This figure has drifted before: the README said "50 tools" when the real surface was 58 (memory:
`project_mcp_tool_doc_count_drift`), and the count has moved 8 times since (58→…→72, one per new
tool). Every new tool is a fresh chance for ~16 doc sites to silently go stale.

Two claims are stale **today**:

- `CLAUDE.md:41` lists the `get_language_support` capability matrix as 7 capabilities
  (`signatures` … `iacProjection`) — the live `CAPABILITIES` set has 9
  (`language-support.ts:41-51`; missing `crossServiceHttp`, `errorPropagation`).
- `package.json:52-60` keywords (`reverse-engineering`, `documentation`, `spec-driven`) and the
  `openspec.summary` (`package.json:77`: "Reverse-engineer living OpenSpec specs from existing
  code…") still describe the pre-pivot product, contradicting the package's own `description`
  (`package.json:4`: "Persistent architectural memory and structural cognition for AI coding
  agents") and the north star (`overview/spec.md`, decision `c6d1ad07`).

## What changes

1. **A doc-claim sync test** (extending the `honesty-contract.test.ts` pattern; plain `.test.ts` so
   CI runs it): scans the enumerated doc surfaces for the tool-count / preset-size /
   language-count claims and asserts each equals the value **derived from code** —
   `TOOL_DEFINITIONS.length`, `TOOL_PRESETS.substrate.size` / `TOOL_PRESETS.navigation.size`,
   `CODE_LANGUAGES.length` / `IAC_LANGUAGES.length`. A tool added without touching the docs fails
   CI with the list of stale sites.
2. **Floor claims get the CANONICAL treatment**: the "5500+" test floor is pinned to one canonical
   constant next to the guard (the `honesty-contract.test.ts:24-33` pattern), asserted consistent
   across its occurrences — updating the claim requires touching the guard in the same reviewed
   change. No fabricated "measured" figure: a floor is a floor, stated as one.
3. **Fix the two stale claims now**: CLAUDE.md:41 gains the two missing capabilities;
   `package.json` keywords + `openspec.summary` are rewritten to the north-star positioning
   (structural context substrate / architectural memory for coding agents).
4. **A standing rule** (spec requirement): any new quantitative claim in a user-facing doc ships
   with a guard or is derived from code — the same discipline `verify_claim` imposes on agents'
   structural assertions, applied to our own docs.

## Why this is in scope

The honesty contract already treats an unguarded published number as a defect
(`honesty-contract.test.ts` exists precisely because unproven token-savings claims shipped once).
A stale "N tools" or a pre-pivot package summary is the same failure — the project asserting
something about itself that nothing verifies — and it has a proven drift history. This makes the
existing discipline cover *all* quantitative doc claims, not just benchmark figures.

## Impact

- New/changed: one doc-claim sync test (new file or a section in `src/honesty-contract.test.ts`);
  `CLAUDE.md:41` capability list; `package.json` keywords + `openspec.summary`; no runtime code.
- Specs: `mcp-quality` — 1 ADDED requirement (QuantitativeDocClaimsAreGuarded).
- Risk: none at runtime. The guard adds friction to adding a tool (must touch docs in the same PR)
  — that friction is the point; the failure message lists the exact stale sites to fix.
