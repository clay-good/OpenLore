# Tasks — CLI output hygiene

## Implementation
- [x] decisions --list via logger/chalk; guard test: no raw \x1b[ literals under src/cli
- [x] --config missing/unreadable → fatal error naming the path
- [x] doctor summary derived from emitted warnings (per-check fragments)
- [x] Surface-parameterized hint templates (CLI says `openlore analyze`, MCP says the tool name);
      guard test for MCP tool names in CLI hint strings
- [x] decisions --list glyph set + legend; `verified` rendered "awaiting review"
- [x] Cosmetics: scope lance WARN logging; absolute/repo-relative export paths; init detects
      plain-TS projects; manifest emit --dry-run

## Verification
- [x] `--no-color decisions --list | cat -v` shows zero escape bytes
- [x] `--config /nonexistent` exits non-zero naming the path
- [x] doctor with only a staleness warning summarizes staleness
- [x] find-clones unknown-symbol hint names `openlore analyze`
- [x] Full suite green

## Spec
- [x] `cli` delta: ADD OutputContractsAreUniform
