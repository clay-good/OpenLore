# Design: honest interference-map conclusions

## Decisions

- Preserve every enumerated change. Provider failures become actor-attributed not-assessed nodes;
  repository-wide enumeration failures and coverage limits become caveats.
- Require a commit base that represents a full comparison window. Auto resolution prefers local or
  remote default branches and rejects `HEAD~1` for this conclusion tool instead of treating one commit
  as the whole in-flight change.
- Keep the existing hazard vocabulary. Pure read/read overlap is omitted because it is not a data
  hazard; WAR remains same-file, disjoint-symbol writes.
- Keep assessment bounded at 400 files per change. Larger diffs are not partially assessed; they use
  the explicit `assessment-capped` not-assessed reason.
- Normalize governance severity to `info | warning | error | critical`. Because that changes serialized
  enforcement output, `openlore enforce --json` advances to schema version 2.

## Compatibility

Custom in-flight providers may continue returning the legacy `RawChange[]`; providers that need to
report coverage caveats may return `{ changes, caveats }`. Enforcement JSON consumers must migrate
`schemaVersion: 1` / `warn` handling to `schemaVersion: 2` / `warning`.

## Verification

Provider tests cover each failed git operation, PR failures and limits, and the 400/401 boundary. Map
tests cover mixed assessed/unassessed conclusions and rejected bases. Classifier and planner tests pin
read/read, WAR, WAW, RAW, and shared-append behavior. A real temporary git repository verifies
remote-only default-branch resolution.
