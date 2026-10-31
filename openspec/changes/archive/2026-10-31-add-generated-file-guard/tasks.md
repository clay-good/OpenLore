# Tasks — add-generated-file-guard

## Implementation
- [x] Classifier: header markers (closed list, first N lines), `.gitattributes` generated/vendored,
      lockfile names, existing path patterns; record the matching rule
- [x] Source resolver: literal header source; `go:generate`, package.json scripts, CI run steps,
      Makefile targets naming input + output; else `unknown`
- [x] `orient` / `blast_radius` fields: `generated: { rule, generatedFrom, regenerateWith }`
- [x] `generated-file-edited` finding (advisory, registered): generated file edited without its
      source in the diff; lockfile without manifest
- [x] `verify_change` projection (written diff). The speculative `patch` input does not exist yet;
      it lands with the `add-verification-feedback-loop` addendum and reuses `generatedFileEditedFindings`.
- [x] Docs: published marker list (`docs/generated-files.md`)

## Verification
- [x] Go `Code generated ... DO NOT EDIT.` header detected; source named from `go:generate`
- [x] `linguist-generated` path detected via `.gitattributes`
- [x] Editing `gen/order_pb.ts` alone → finding; editing it with `order.proto` → no finding
- [x] Unknown source → `unknown`, not guessed
- [x] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD GeneratedFilesAreMarkedWithTheirSource
