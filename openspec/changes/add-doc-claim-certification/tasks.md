# Tasks — add doc claim certification

## Implementation
- [ ] Markdown claim extractor over a closed, syntactic vocabulary: symbol reference, path
      reference, `path:line` citation, own-binary CLI invocation in a fenced block, MCP tool name
- [ ] Resolvers: symbol table, file tree, span check for line citations, command registry,
      `TOOL_DEFINITIONS`
- [ ] Verdicts `holds | refuted | uncheckable`, each with evidence; `uncheckable` counted and
      reported, never silently dropped
- [ ] Ambiguous extraction resolves to `uncheckable`, never `refuted`
- [ ] Renamed symbols reported as renamed (via the shipped identity continuity), not missing
- [ ] `certify_doc_claims` handler + `openlore certify-docs [--path <glob>] [--json]`
- [ ] Register `doc-claim-refuted` in `FINDING_CODE_REGISTRY`; advisory by default, gateable only
      via `enforcement.policy`
- [ ] Port `src/doc-claim-sync.test.ts`'s claims to the generic path where the vocabulary covers
      them; keep the count/floor assertions it uniquely handles

## Verification
- [ ] A documented symbol that exists → `holds`; one deleted → `refuted` with counter-evidence
- [ ] A `path.ts:123` citation whose line drifted outside the named symbol's span → `refuted`
- [ ] A renamed symbol → reported renamed with the new name, not missing
- [ ] A documented flag of an external tool → `uncheckable`, counted, not `refuted`
- [ ] Prose that merely mentions a word matching a symbol shape but is not a code reference →
      `uncheckable` or not extracted; never a false refutation (guarded by a prose-heavy fixture)
- [ ] Default run is advisory: exit code unaffected; policy-gated run blocks only when configured
- [ ] Self-check: `openlore certify-docs` on this repo produces a stable, non-empty report
- [ ] Conclusion-shape assertion + tool-contract test pass

## Spec
- [ ] `mcp-handlers` delta: ADD DocumentationClaimsAreCertifiedAgainstTheSubstrate
