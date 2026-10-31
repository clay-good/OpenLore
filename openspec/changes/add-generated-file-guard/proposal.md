# Generated-file guard: tell the agent a file is generated, and where its source is

> Status: PROPOSED (2026-10-31, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). Additive fields in
> `orient`, `blast_radius`, and `verify_change`, plus one advisory finding. No new tool.

## The gap

Agents edit generated code, vendored code, and lockfiles by hand. The edit looks correct, passes,
and is silently erased by the next `protoc`, `openapi-generator`, `prisma generate`, or
`npm install`. The source the agent should have edited (the `.proto`, the OpenAPI document, the
Prisma schema, the codegen script) is usually one hop away and never shown.

OpenLore excludes some generated paths today by path pattern only (`isExcludedPath`, used by
`briefing_since` and `report_coverage_gaps`). It reads no in-file generated marker, no
`.gitattributes`, and never names the source.

## What changes

- **Detection, closed rules, in order:** (1) the standard header marker in the first lines of the
  file — Go's `^// Code generated .* DO NOT EDIT\.$` (https://go.dev/s/generatedcode), `@generated`,
  `DO NOT EDIT` / `AUTO-GENERATED` banners from a closed list of generator headers; (2)
  `.gitattributes` `linguist-generated` / `linguist-vendored`; (3) lockfiles by name;
  (4) the existing path patterns. Each detection records which rule matched.
- **Source naming, literal only:** when the header names its source (`source: order.proto`,
  `DO NOT EDIT. Generated from openapi.yaml`), or a config-invoked script (package.json script, CI
  run step, `go:generate` directive, Makefile target) names both the generator input and the output
  path, the guard records `generatedFrom` (file) and `regenerateWith` (the literal command).
  Otherwise both are `unknown` — never guessed.
- **Surfacing:**
  - `orient` and `blast_radius` mark generated files in scope with the rule, `generatedFrom`, and
    `regenerateWith`.
  - `verify_change` (including a speculative `patch`) reports `generated-file-edited` (advisory) when
    a diff hand-edits a generated file and its `generatedFrom` source is not also in the diff; a
    lockfile changed without its manifest is the same finding.
  - Detection is exposed for the hook surfaces in `add-agent-loop-hook-surfaces`, so a PreToolUse
    hook can state the fact before the write.

## Honesty contract

A file matched only by path pattern says so (lower certainty, same wording rule). A generator
header outside the closed list is not detected — the list is published in the docs so a team can see
what is and is not recognized.

## Not built

Running generators; checking that generated output is up to date (that needs the generator); blocking
the edit.

## Impact

- Files: generated-file classifier (shared, replaces nothing — `isExcludedPath` keeps its callers and
  gains a marker-aware sibling), `.gitattributes` reader, source/command resolver over config-invoked
  entries, `orient`/`blast_radius` fields, finding registration, `verify_change` projection.
- Specs: `mcp-handlers` — 1 ADDED.
- Tool surface: none added.
