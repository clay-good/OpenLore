# Tasks — add-doc-claim-sync-guards

## Implementation
- [x] ~~Doc-claim sync test: assert every "72 tools" site matches `TOOL_DEFINITIONS.length`~~
      **ALREADY SHIPPED** by `src/cli/commands/mcp-tool-count-doc.test.ts` (PR #229), which pins the
      full-surface "N tools" count to `TOOL_DEFINITIONS.length` across README, docs/mcp-tools.md,
      docs/cli-reference.md, docs/governance-dogfooding.md, docs/agent-setup.md, cli/spec.md,
      CLAUDE.md, and docs/install.md — a wider surface than this proposal enumerated. Descoped.
- [x] ~~Preset-size claims ("13-tool substrate", "10 tools" navigation) match preset set sizes~~
      **ALREADY SHIPPED** in the same guard (substrate → `TOOL_PRESETS[LEAN_DEFAULT_PRESET].size`,
      navigation → `TOOL_PRESETS['navigation'].size`, plus the tools/list byte/token band). Descoped.
- [x] README badge language counts match the code sets — guarded in `src/doc-claim-sync.test.ts`.
      **Premise corrected:** the badge "18" is the general-purpose code languages
      (`CODE_LANGUAGES.filter(l => !isIacLanguage(l)).length` = 18), NOT `CODE_LANGUAGES.length`
      (= 20; Terraform + Bicep are extension-detected code langs that also belong to the IaC bucket,
      counted in the "+ 12 IaC" half). "12 IaC" = `IAC_LANGUAGES.length`. The docs/output.md
      call-graph "(18 languages: …)" note is guarded against the same derived count.
- [x] Test-count floor ("5500+", README badge + build note) pinned to one canonical constant
      (`MIN_TEST_FLOOR`) beside the guard; both occurrences asserted to agree, and to be published
      as a floor (the `+` suffix), never a measured exact figure.
- [x] Failure messages list the stale site and the expected value (actionable, not a bare diff) —
      verified by three mutation checks (badge 18→17, floor 5500→5000, retired keyword re-added).
- [x] Fix CLAUDE.md `get_language_support` row: capability list gains `crossServiceHttp` +
      `errorPropagation` (now matches the 9-member `CAPABILITIES` set, language-support.ts:41-51).
      (CODEBASE.md's coverage matrix already had all 9 columns — only CLAUDE.md was stale.)
- [x] Refresh package.json `keywords` (drop `reverse-engineering`/`documentation`/`spec-driven`)
      and `openspec.summary` to the north-star positioning; `description` (line 4) stays the anchor.

## Verification
- [x] New guard green on current docs (all figures are true today) — 7/7 pass.
- [x] Mutation check: doc "18" → "17" (and floor 5500 → 5000, and a retired keyword) each fail the
      guard naming the exact site + expected value.
- [ ] Full suite green (`npm run test:run`)

## Spec
- [x] `mcp-quality` delta: ADD QuantitativeDocClaimsAreGuarded (specs/mcp-quality/spec.md)
