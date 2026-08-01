# Log anchor conclusions: a pasted log line resolves to the code that emitted it

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Extract
> every logging call site's format-string template during the walk OpenLore already does, index
> the constant parts, and answer "which code emitted this log line?" as a conclusion — call
> site, enclosing function, backward call paths, reaching tests. The matching is string algebra
> over statically extracted templates (the log↔source matching literature's deterministic
> core); no runtime integration of any kind.

## The gap

- A production log line is the most common runtime artifact a coding agent is handed
  ("investigate this error"), and OpenLore cannot connect it to the graph. Neither can grep:
  `log.error(\`payment ${id} failed after ${n} retries\`)` never contains the literal text
  `payment 84c2 failed after 3 retries`. The agent falls back to iteratively grepping
  fragments — the exact file-by-file rediscovery loop the substrate exists to eliminate.
- The facts needed are already walked past on every analyze: logging call sites are ordinary
  call expressions whose arguments are string/template literals; their constant parts are
  statically extractable with line precision. OpenLore persists nothing about them today.
- Scope guard: the settled won't-do on runtime observability (archived
  `defer-gryph-runtime-observability`) froze *runtime integration* — watching logs, ingesting
  streams, correlating live telemetry — out of scope. This proposal does none of that: the
  input is one caller-supplied string; extraction is static; nothing runs, tails, or connects.

## What changes

- **Template extraction in the existing walk.** During Pass 1, call sites whose callee matches
  a closed per-language logger pattern set (console/log/logger method names, standard-library
  logging calls — a source-declared table, extensible per language like the env-var patterns)
  and whose arguments contain string or template literals yield a template record:
  `{constantParts[], file, line, enclosingSymbol, level?}`. Persisted as a sidecar artifact,
  rebuilt incrementally with the file's other facts. Dynamically constructed messages (no
  extractable constant part of any length) are counted as an unmatchable boundary per file,
  never dropped silently.
- **One new conclusion tool, `locate_log_origin({logLine})`** (`full` preset, family
  `navigate`; CLI `openlore log-origin "<line>"`). Matching is deterministic constant-part
  containment: a template matches when all its constant parts appear in the queried line in
  order; candidates are ranked by total matched constant length — a longest-match ordering,
  not a scoring constant. The result per candidate: call site (file:line), enclosing function,
  backward call paths to entry points (existing reachability lookups), and the reaching tests.
- **Honesty contract.** Multiple surviving candidates are ALL returned, never narrowed by
  guesswork, with the shared-prefix reason stated; zero candidates returns the unmatchable-
  boundary count for context ("N sites in this repo log dynamically and cannot be matched"),
  never a bare empty; a line matching only templates in unsupported languages says so. The
  response states its basis: static templates at the current index, which may lag the deployed
  version — the deployed-version gap is a named boundary, with the existing staleness
  disclosure carried when the index trails the working tree.
- **Deliberately NOT borrowed / NOT built:** log ingestion, tailing, or storage; OpenTelemetry
  or collector integration; ML/LLM template inference (the published systems' learned half is
  exactly what is not borrowed — only the deterministic constant-part matching core); severity
  heuristics; cross-repo matching in this change (federation later, if ever, as its own
  proposal).

## Why this is in scope

This converts a class of question agents answer today by slow, unreliable grep into a
receipt-backed conclusion computed from facts the walk already visits — static analysis only,
no LLM, no runtime, fail-soft, disclosed boundaries. It is the same shape as
`analyze_env_impact` (an inventory of read/emit sites + reachability joins) applied to the
logging surface, and it is whitespace: no agent substrate in the surveyed field offers it.

## Impact

- Files: a logger-pattern table + template extractor in the Pass-1 walk, a sidecar template
  index (incremental with file facts), the `locate_log_origin` handler + CLI, tool-contract
  classification, presets/docs.
- Specs: `analyzer` — 1 ADDED requirement; `mcp-handlers` — 1 ADDED requirement.
- Tool surface: +1 tool in `full` preset only; adjacent cross-reference: `analyze_env_impact`
  (inventory + blast-radius shape) and `search_code` (which this is not — no semantic ranking).
- Risk: logger-pattern misses (wrappers) under-extract (mitigated: per-file unmatchable/
  unrecognized counts make the floor visible; wrapper patterns addable to the table); very
  short constant parts over-match (mitigated: all candidates returned with matched-length
  ordering and the ambiguity reason); template index size (bounded: constants only, no message
  bodies beyond the literal parts already in source).
