# Proposal

## Why

A ranked list is not an answer. When keyword retrieval has no real match, `search_code` and `orient`
still return their top-N functions with scores — the same shape they return when the answer is
genuinely in there — so the caller cannot tell "here is what you asked for" from "here is the least
irrelevant thing I hold". On 2026-09-20 an `orient` about a spinner that would not stop returned
three confidently-ranked symbols, none on the causal path, plus an insertion point recommending a new
step inside a function that had nothing to do with the bug. Nothing in the response said the question
was not covered.

Two halves of this are already built: `add-retrieval-match-evidence` makes every result carry the
field and terms it matched on, and `NoFalseCompleteness` already forbids dressing an incomplete
conclusion as complete. What is missing is the verdict — a result set whose evidence is uniformly
weak must say so — and the question-kind routing that makes the verdict meaningful: "what makes this
appear", "what order do these run in" and "where is X" are different questions, and only the last is
answerable by ranking symbols against a query string.

## What Changes

- Retrieval surfaces (`search_code`, `search_specs`, and `orient`'s symbol selection) gain an
  explicit **coverage verdict** derived from the match evidence already attached to each result:
  `covered` when at least one result matched on a strong field, `weak` when every result rests on
  low-tier evidence, and `uncovered` when nothing matched beyond noise. An `uncovered` verdict
  returns no ranked list at all — it returns the reason and what would answer the question.
- The verdict is computed from existing evidence tiers, not from a new score or a threshold on
  relevance. No new ranking, no LLM, no confidence number.
- Responses carrying a `weak` or `uncovered` verdict name the **question kind** they could not
  serve, from a closed vocabulary: `where-is`, `who-calls`, `what-gates`, `what-order`,
  `is-it-tested`, `why-decided`. Each kind names the tool that does answer it when one exists
  (`who-calls` → `analyze_impact`, `why-decided` → `recall`, `is-it-tested` → `select_tests`), and
  says plainly that the kind is not served when none does.
- `suggest_insertion_points` SHALL abstain rather than recommend a location when the retrieval that
  produced its candidates was `uncovered` — a wrong insertion point is worse than none.
- The verdict is part of the conclusion contract, so the existing dispatch-time shape enforcement
  covers it.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-quality`: `NoFalseCompleteness` gains its coverage counterpart — a result set whose evidence
  is uniformly weak SHALL NOT be shaped like an answered question; abstention is a first-class
  response, not an empty list.
- `mcp-handlers`: the retrieval-backed handlers (`search_code`, `search_specs`, `orient`,
  `suggest_insertion_points`) carry the coverage verdict and the question-kind disclosure.

## Impact

- `src/core/analyzer/retrieval-evidence.ts` — verdict derivation from existing tiers
- `src/core/services/mcp-handlers/semantic.ts`, `orient.ts`, `graph.ts` — verdict on responses,
  abstention path in `suggest_insertion_points`
- `src/core/services/mcp-handlers/retrieval-miss.ts` — the existing miss explainer becomes the
  remedy the `uncovered` verdict points to
- `src/core/services/mcp-handlers/tool-contract.ts` — verdict in the conclusion shape
- No index or artifact change; the evidence the verdict reads is already computed per result
