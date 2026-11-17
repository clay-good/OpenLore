# Tasks — finish the verify_change receipt

The tool, its first fold-ins (#605, #629, #632, #634, #658), and the before-stop hook (#637) are
shipped and are not listed here.

## 1. Fold in facts OpenLore already computes

- [ ] 1.1 Compose `handleCertifyPublicSurface` against the receipt's resolved base in
      `src/core/services/mcp-handlers/verify-change.ts`; each breaking or potentially-breaking export
      is an item with its rule code and consumers. Test: `verify-change.test.ts`. Done when a
      narrowed export appears above spec drift, with its consumers named.
- [ ] 1.2 Compose the `handleCertifyServiceContract` verdicts (`contract-breaking`,
      `contract-declared-unimplemented`, `contract-implemented-undeclared`) in `verify-change.ts`.
      Test: `verify-change.test.ts`. Done when a removed declared operation with an in-repo caller
      is an item, and an unreadable spec is a boundary, not "no findings".
- [ ] 1.3 Project `envDeclarations.stillSet` from `blast-radius.ts` as items naming file and line.
      Test: `verify-change.test.ts`. Done when a removed env read still set in a Dockerfile yields
      one item with the Dockerfile line.

## 2. New diff-scoped findings

- [ ] 2.1 Add only the `check_architecture` violations whose edge the diff adds
      (`architecture.ts` → `verify-change.ts`). Test: `verify-change.test.ts`. Done when a base
      violation is not reported and a new one is.
- [ ] 2.2 Register `secret-added` and `cycle-introduced` in `FINDING_CODE_REGISTRY`
      (`enforcement-policy.ts`); compute them from `secret-redaction.ts` on added lines and from
      `detectDependencyCycles` (`dependency-graph.ts`) at base and after. Tests:
      `verify-change.test.ts`, `enforcement-policy.test.ts`. Done when a pasted key yields a finding
      with file and line but the key text appears in no output, and only a new cycle is reported.

## 3. Receipt shape and inputs

- [ ] 3.1 Reword the imperative `nextAction` strings in `verify-change.ts` as facts, and add a
      `schemaVersion` field to the receipt. Test: `verify-change.test.ts`. Done when no
      `nextAction` starts with an imperative verb and existing field names are unchanged.
- [ ] 3.2 Add an optional `staged` input (schema in `src/cli/commands/mcp.ts`, handler in
      `verify-change.ts`). Decide whether an explicit base that does not resolve is fatal or a
      disclosed fallback, and record it with `openlore decisions record`. Test:
      `verify-change.test.ts`. Done when a staged-only change is graded and the decision is recorded.
- [ ] 3.3 Add the optional `patch` input: apply a unified diff in memory, build through the Pass-1
      cache, mark the receipt `speculative: true` with the patched files; a non-applying hunk, an
      out-of-corpus path, or an over-cap patch fails with the reason. Test:
      `verify-change.test.ts`. Done when a patch that removes a called function gives the same items
      as the same edit on disk, and the working tree is byte-identical before and after.

## 4. Before-stop receipt speaks to the agent (`stop-hook-speaks-to-agent`)

- [ ] 4.1 Design and build delivery of the before-stop receipt to the agent as context, quiet when
      no item is new since the last stop (`src/cli/commands/hook.ts`). Test: `hook.test.ts`. Done
      when the design is written here and a repeat stop with no new item prints nothing.

## 5. Docs and parity

- [ ] 5.1 Update the `verify_change` row in `docs/mcp-tools.md` and the tool description in
      `src/cli/commands/mcp.ts` for the new item families and inputs. Done when
      `doc-claim-sync.test.ts` and `tool-contract.test.ts` pass.
- [ ] 5.2 Mirror the new inputs in `src/pi/extension.ts`. Test: `src/pi/extension.test.ts`. Done
      when the MCP↔Pi parity guard passes.
