# Tasks — add-codeowners-ownership-evidence

## 1. Resolver

- [ ] 1.1 New `src/core/analyzer/codeowners.ts`: locate the file, parse GitHub-format rules, and
      resolve owners by last-match-wins. Test: new `codeowners.test.ts`. Done when
      `* @org/core` then `src/api/ @org/api-team` resolves `src/api/routes.ts` to `@org/api-team`
      with no git call.
- [ ] 1.2 Honest gaps in the same module: no file → "not assessed"; GitLab sections or Bitbucket
      syntax → unsupported format, no map; one bad rule → skipped and counted. Read the file with
      the confined, size-bounded reader in `src/utils/path-confinement.ts`. Test:
      `codeowners.test.ts`. Done when no fixture yields a partial or wrong owner map.

## 2. Surfaces

- [ ] 2.1 Add `ownership` to the briefing in `src/core/services/mcp-handlers/blast-radius.ts`,
      for changed files and affected-caller files. Test: `blast-radius.test.ts`. Done when a diff
      across two owned areas names both owners and a repository with no file says "not assessed".
- [ ] 2.2 Add the "raise to" receipt line in `src/core/services/mcp-handlers/verify-change.ts`.
      Test: `verify-change.test.ts`. Done when the line appears only if owners resolved, and the
      before-stop receipt (`src/cli/commands/hook.test.ts`) stays within its budget.
- [ ] 2.3 Register `unowned-critical-path` (advisory, source `blast-radius`) in
      `src/core/services/mcp-handlers/enforcement-policy.ts` and emit it from `blast-radius.ts`
      for changed hub or chokepoint symbols in uncovered files. Tests: `enforcement-policy.test.ts`,
      `blast-radius.test.ts`. Done when a changed uncovered hub yields the finding, a covered one
      does not, and an unchanged one does not.
- [ ] 2.4 Classify the "not assessed" and skipped-rule fields in `confidence-boundary.ts`. Test:
      `completeness-invariant.test.ts`. Done when the test passes.

## 3. Guards and docs

- [ ] 3.1 Screen owner handles on output like other repository text. Test: `blast-radius.test.ts`
      with an instruction-shaped handle. Done when the text is withheld or neutralized.
- [ ] 3.2 MCP↔Pi parity and payload budget (`blast_radius` is on the default surface). Tests:
      `src/pi/extension.test.ts`, `src/cli/commands/mcp-presets.test.ts`. Done when both pass.
- [ ] 3.3 Document `ownership` and the finding in `docs/mcp-tools.md` and `docs/configuration.md`.
      Done when the docs state "GitHub format only" and "never inferred from authorship".
