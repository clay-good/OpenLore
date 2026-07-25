# Tasks — reconcile-substrate-write-face

## Implementation — step 1 (copy honesty, immediate)
- [x] `BREADTH_POINTER` (mcp.ts:2280-2286): "both faces of the substrate" → "the navigation core
      plus governance reads (recall, verify_claim, blast_radius)"
- [x] `--preset` help (mcp.ts:2714): same "both faces" fix; ALSO correct the stale opener —
      "Default (no preset) is the lean `navigation` surface" → the `substrate` default
      (LEAN_DEFAULT_PRESET = 'substrate', constants.ts:222)
- [x] Substrate preset comment tail (mcp.ts:2203-2205): drop the stale "active default stays
      `navigation`" sentence (the flip landed — ADR-0023 / c79ec7ca)
- [x] README.md:244,460 — "both-faced out of the box" / "(both faces)" → "navigation core plus
      governance reads"
- [x] CLAUDE.md:47 default-surface block: same fix
- [x] docs/install.md:37, docs/agent-setup.md:142, docs/cli-reference.md:109,137,147,
      docs/mcp-tools.md:39 — same fix (docs/mcp-tools.md:63 already discloses reads-only; align
      its "both faces" heading)
- [x] docs/governance-dogfooding.md:30 — stale "lean navigation preset / ADR-0022" row →
      substrate default / ADR-0023
- [x] Guard the corrected phrasing: extend the honesty-contract/doc-claim checks so the retired
      "both faces" claim cannot reappear while the preset holds reads only

## Implementation — step 2 (benchmark-gated write-face evaluation; separate PR, gated)
- [ ] Define the candidate surface: `substrate` + `remember` + `record_decision` (13 → 15 tools)
- [ ] Run the DefaultSurfaceRevealsAllFaces harness on the candidate vs. current default, two
      models × both repo tiers (the c79ec7ca protocol)
- [ ] No-regression result → `record_decision` superseding c79ec7ca/ADR-0023; flip the preset;
      re-measure the tools/list preset budget (mcp-presets.test.ts) and let the change-1 doc-claim
      guard drive the "13 tools" doc updates
- [ ] Regression result → record the negative evidence as a decision; default stays reads-only
      (step-1 copy already truthful); do NOT flip

## Verification
- [x] Step 1: no shipped surface (README, docs, CLAUDE.md, instructions channel, --help) claims
      "both faces" for a reads-only preset; grep-based guard green
- [x] Step 1: `openlore mcp --help` names `substrate` as the default
- [x] Full suite green (`npm run test:run`)

## Spec
- [x] `mcp-quality` delta: ADD DefaultSurfaceCopyMatchesItsContents
