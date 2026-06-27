# Tasks — Structural claim verification

> Phase-2; build after the five memory + dispatch changes (reuses the grounding certificate and
> confidence-boundary detection). Call `record_decision` before the claim/verdict contract (API
> contract), per `CLAUDE.md`.

## 1. Claim + verdict contract
- [x] Define the structured claim `{ kind, subject, object? }` for kinds `calls`, `reaches`, `dead`,
      `impacts`, `safe-to-change`, and the verdict `{ verdict, receipt }`.
- [x] Map each kind to its existing deterministic computation (traversal / reachability /
      `analyze_impact` / blast-radius + memory-orphaning).
- [x] Test: a true `calls` claim returns `confirmed`; a false one returns `refuted`.

## 2. Receipt as citation
- [x] Attach the evidence (edges/spans/`contentHash`, index commit) in the grounding-certificate shape.
- [x] Test: the receipt's hashes match an independent hash of the cited spans.

## 3. Unverifiable verdict
- [x] Return `unverifiable` (with the boundary named) when a claim depends on a blind spot; reuse
      `add-confidence-boundary-disclosure`.
- [x] Test: a `dead` claim about a reflection-reached symbol returns `unverifiable`, not `confirmed`.

## 4. Surface + docs
- [x] Register behind an opt-in preset; nothing in the default. Confirm `tool-contract.ts` = `conclusion`.
- [x] Document the verify-then-cite loop pattern in `mcp-handlers` + `CODEBASE.md`.
