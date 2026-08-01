# Symbol span locator: a read-only, staleness-checked edit location the host can trust

> Status: IMPLEMENTED (2026-07-18; proposed 2026-07-03, e2e audit; reframed 2026-07-18). Ships the
> read-only `locate_symbol_span` tool on `--preset full` (tool count 72→73). Awaiting merge +
> `openspec archive`. The original draft added
> source-*writing* tools (`replace_symbol_body`, `insert_before/after_symbol`) framed as closing
> "the largest surface gap vs. Serena MCP." That gives OpenLore a write/edit face — neither memory
> nor guardrail, and a duplicate of the write surface the agent host already owns. Reframed to keep
> OpenLore read-only: it returns the byte-exact, staleness-verified edit *location* as a conclusion;
> the host applies the write with its own tool.

## The gap

OpenLore already resolves a task to precise spans: `suggest_insertion_points` names the function to
extend, tree-sitter gives byte-exact spans, and `name::path` addressing disambiguates symbols
(`clone-query.ts:37,115`, not-found → candidates at `:147`). But when the agent goes to apply an
edit, it must *re-locate* that span by string-matching against a fresh read — the one step where the
substrate's knowledge is thrown away and replaced by guesswork (wrong-overload hits, duplicated
snippets, whitespace drift), with no signal that the index it's trusting is even current.

## What changes

**One read-only conclusion tool** — `locate_symbol_span(symbol)` — family `navigate`, class
`conclusion`, `readOnlyHint: true`. It resolves a `name::path` (or bare-name → candidates) symbol
and returns the edit location plus a freshness verdict:

```
{ file, startLine, endLine, startByte, endByte, contentHash,
  verdict: "fresh" | "stale" | "ambiguous" | "not-found",
  candidates?: string[] }
```

- **`fresh`** — the indexed span's content hash (the anchor engine's `hashSpan` discipline,
  `src/core/decisions/anchor.ts:27-29`) matches the file's current bytes. The span is safe to edit
  at exactly these offsets.
- **`stale`** — the index is behind the working tree; the offsets are NOT trustworthy. Returns a
  re-analyze hint instead of a location. This is the guardrail: OpenLore refuses to hand out a span
  it can no longer vouch for, rather than letting the agent edit at a drifted offset.
- **`ambiguous` / `not-found`** — bare name with multiple matches, or unknown symbol → the
  `name::path` candidate list, never a fuzzy guess.

The host applies the edit using the returned span with its own edit tool. **OpenLore adds precision
and a freshness guarantee, not write authority.** No write face, no `edit` preset, no shell, no
multi-file transaction, no auto-commit, and no extension of the mcp-security write-confinement
contract (the tool only reads).

**Why this is in scope.** This is memory + guardrail, not action: the memory is the indexed,
content-hashed span; the guardrail is the `fresh`/`stale`/`ambiguous` verdict that refuses to serve
a location the substrate can't stand behind. It composes cleanly with the host's existing write
surface instead of duplicating it. Deliberately NOT borrowed from Serena MCP: its symbol-body
*write* tools, its per-language LSP-server dependency (tree-sitter spans are already here), its
shell-execution tool, and its memory/onboarding subsystem.

## Impact

- New handler (e.g. `mcp-handlers/symbol-span.ts`), one `conclusion` tool, `TOOL_CAPABILITY_FAMILY`
  entry (family `navigate`), `tool-contract.ts` classification, read-only annotations. Read-only, so
  it composes safely into `--preset full` (and may fit `substrate`); no new opt-in write preset,
  no security-surface change.
- Specs: `mcp-handlers` — 1 ADDED requirement (SymbolSpanLocatorReportsFreshnessVerdict). The
  former `mcp-security` write-confinement delta is dropped — there is no write face.
- Tool count 72→73; tools/list payload budget (`mcp-presets.test.ts`) bumped for whichever preset
  carries it; default-surface benchmark untouched unless it lands in `substrate`.
- Risk: low — read-only. The content-hash check is best-effort against a racing editor (disclosed),
  exactly like any read-then-report tool.
