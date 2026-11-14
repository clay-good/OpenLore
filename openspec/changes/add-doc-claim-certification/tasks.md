# Tasks — add-doc-claim-certification

## 1. Claims

- [ ] 1.1 New `src/core/services/doc-claims.ts`: extract the three claim forms from a Markdown
      text, with `file:line` for each; skip fenced blocks in other languages and URL links. Test:
      new `doc-claims.test.ts`. Done when a prose-heavy fixture yields no claim for ordinary words.
- [ ] 1.2 Resolve each claim against the graph and file tree at the merge-base and in the working
      tree: `holds`, `refuted` with evidence, or `unverifiable`. Test: `doc-claims.test.ts`. Done
      when an ambiguous or external subject is `unverifiable` and counted, never `refuted`.
- [ ] 1.3 Report a renamed or moved symbol as renamed with its current name, using the continuity
      data. Test: `doc-claims.test.ts`. Done when a rename fixture yields "renamed to X", not
      "missing".
- [ ] 1.4 Bound the scan: tracked `.md` files only, size-capped reads, and only files that name a
      subject the diff touched. Test: `doc-claims.test.ts`. Done when a diff that removes nothing
      and adds no Markdown reads no doc.

## 2. Surfaces

- [ ] 2.1 Register `doc-claim-refuted` (advisory, source `verify-change`) in
      `src/core/services/mcp-handlers/enforcement-policy.ts`. Test: `enforcement-policy.test.ts`.
      Done when the code resolves advisory by default.
- [ ] 2.2 Add the check to `src/core/services/mcp-handlers/verify-change.ts`: findings plus one
      receipt item per refuted claim. Test: `verify-change.test.ts`. Done when deleting a
      documented function yields the finding with the doc line, and an already-false claim the
      diff did not touch yields nothing.
- [ ] 2.3 Add the `doc-current` kind in `src/core/services/mcp-handlers/claim-verification.ts`,
      and to the `kind` enums in `src/cli/commands/mcp.ts` and `src/pi/extension.ts`. Test:
      `claim-verification.test.ts`. Done when a doc with one false claim is `refuted` with
      evidence and a doc with no checkable claim is `unverifiable`.
- [ ] 2.4 Classify the unverifiable count in `confidence-boundary.ts`. Test:
      `completeness-invariant.test.ts`. Done when the test passes.

## 3. Guards and docs

- [ ] 3.1 MCP↔Pi parity and payload budget for the new kind. Tests: `src/pi/extension.test.ts`,
      `src/cli/commands/mcp-presets.test.ts`. Done when both pass.
- [ ] 3.2 Document the finding and the kind in `docs/mcp-tools.md` and `docs/drift-detection.md`.
      Done when the docs list the three claim forms and what is not checked.
