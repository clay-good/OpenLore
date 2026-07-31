# Add call-site usage profile: how this codebase actually calls X

> Status: PROPOSED (2026-07-27, ecosystem research sweep). `get_usage_profile`: before writing a
> new call to a symbol, a deterministic census of the existing call sites — arity distribution,
> which optional arguments are actually passed, awaited-vs-discarded, wrapped-vs-bare — in the
> `{ dominant, ratio, samples }` shape the style fingerprint established. Prior art: the
> API-usage-mining lineage (MAPO/PAM/FOCUS — https://hal.science/hal-02023023/document),
> collapsed from cross-repo statistics to in-repo counting.

## The gap

Agents write plausible-but-unidiomatic calls: the right function, the wrong shape — skipping the
`options.timeout` every existing caller passes, discarding a result every existing caller
awaits, calling bare what the codebase always wraps in a try. The substrate answers "how does
this *repo* write code" (`get_style_fingerprint`, repo/region/file granularity) and "who calls
X" (`get_subgraph`), but not "how is X *called*" — even though every call site is already in the
EdgeStore with its line (`CallEdge.line`, `src/core/analyzer/call-graph-types.ts:146-160`), so
the census is a re-read and a count away. The fingerprint's own discipline (dominant/ratio,
evidence floors, `enforced` nulls) is the exact shape this needs at per-symbol granularity.

## What changes

A new `get_usage_profile` conclusion tool (opt-in `--preset full`) + `openlore usage-profile
--symbol <name> [--json]`:

- **Input**: one symbol (`name` or `name::path`, the `find_clones` resolution discipline —
  unknown symbol → not-found + candidates; ambiguous bare name → `name::path` candidates; never
  an empty profile implying "never called").
- **Census over resolved call sites**: re-read each site's line and parse the call expression;
  count what is syntactically certain — argument count distribution, literal-vs-variable per
  position, named/keyword options passed (TS object-literal keys, Python keywords), result
  context (`awaited | returned | assigned | discarded`), enclosing `try`/error-context or not.
  Output per facet: `{ dominant, ratio, samples }` with file:line receipts on the samples.
- **Honesty rules carried over whole**: a facet below the fingerprint's evidence floor reports
  null, never a guess; spread/dynamic arguments make a site `uncountable` for that facet
  (disclosed count); call sites reached only through synthesized or low-confidence edges are
  excluded and disclosed; output is labeled *observed frequency*, never "correct usage".
- **Sibling cross-references** (NoRedundantConclusions): `get_style_fingerprint` (repo-level
  idioms) and `get_subgraph` (who calls; this tool says *how*).

Deliberately NOT borrowed from the usage-mining lineage: frequent-pattern mining / association
rules (statistical inference over call sequences — replaced by plain counting of one symbol's
sites), cross-repo corpora, and any recommendation ranking ("callers usually also call Y" is
sequence mining, refused — the tool reports one symbol's observed call shapes only).

## Why this is in scope

Targets the highest-frequency agent failure the substrate can measure (unidiomatic calls) with
pure aggregation over facts already stored, computed live like `find_clones` (cached graph + a
re-read of the spanned source, no new artifact). Descriptive, deterministic, evidence-floored —
the fingerprint contract at symbol granularity.

## Impact

- New: census module + `get_usage_profile` handler + CLI. Registered in
  `TOOL_CAPABILITY_FAMILY` (`navigate`), classified `conclusion`; tools/list payload budget
  re-asserted or consciously bumped.
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Risk: per-language call-expression parsing breadth (mitigated: languages ride the loaded
  grammars; an unsupported language returns explicit `unsupported`, the `get_language_support`
  discipline); tempting misuse as a linter (mitigated: output wording is frequency-only, spec'd
  as such).
