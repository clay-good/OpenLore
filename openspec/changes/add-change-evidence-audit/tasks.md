# Tasks — add-change-evidence-audit

## Implementation
- [ ] Marker scanner: `change: <name>` over `src/` with file:line receipts
- [ ] Delta differ: each ADDED/MODIFIED requirement in `changes/<name>/specs/*/spec.md`
      present-in / absent-from the target main spec, keyed by requirement name within the
      target domain; per-requirement report
- [ ] `openspec validate` delegation wrapper (never reimplement lifecycle/validation)
- [ ] Fixed verdict rule table: built / built-unmarked (verify-against-code caveat verbatim) /
      partially-built / unbuilt / not-assessed (parse failure, with error); archivable-candidate
      label = built + validates, never an archive action
- [ ] `openlore change-status [<name>] [--json]` + `--table` (STATUS.md table body to stdout;
      checkboxes shown as display-only column, excluded from verdicts)

## Verification
- [ ] Fixtures: one synthetic change per verdict state, incl. marker-without-sync and
      sync-without-marker; malformed delta → not-assessed with the parse error
- [ ] Name-within-domain matching: same requirement name in two domains does not cross-match
- [ ] Evidence-not-correctness sentence present in text and `--json` outputs
- [ ] `--table` output matches STATUS.md's column format
- [ ] Full suite green

## Spec
- [ ] `cli` delta: ADD ChangeStatusIsComputedFromDocumentedEvidence
- [ ] `openspec` delta: ADD ChangeEvidenceAuditDelegatesLifecycle
