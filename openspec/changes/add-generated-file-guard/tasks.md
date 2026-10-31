# Tasks — add-generated-file-guard

## Implementation
- [ ] Classifier: header markers (closed list, first N lines), `.gitattributes` generated/vendored,
      lockfile names, existing path patterns; record the matching rule
- [ ] Source resolver: literal header source; `go:generate`, package.json scripts, CI run steps,
      Makefile targets naming input + output; else `unknown`
- [ ] `orient` / `blast_radius` fields: `generated: { rule, generatedFrom, regenerateWith }`
- [ ] `generated-file-edited` finding (advisory, registered): generated file edited without its
      source in the diff; lockfile without manifest
- [ ] `verify_change` projection (written diff and speculative `patch`)
- [ ] Docs: published marker list

## Verification
- [ ] Go `Code generated ... DO NOT EDIT.` header detected; source named from `go:generate`
- [ ] `linguist-generated` path detected via `.gitattributes`
- [ ] Editing `gen/order_pb.ts` alone → finding; editing it with `order.proto` → no finding
- [ ] Unknown source → `unknown`, not guessed
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD GeneratedFilesAreMarkedWithTheirSource
