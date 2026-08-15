---
name: openlore-review-changes
description: Review code changes using OpenLore risk, call, coverage, and cluster evidence without editing code. Use when asked for a change review, pre-PR safety check, or merge recommendation.
---

# openlore: Review Changes

## When to use this skill

Trigger this skill whenever the user asks to **review, audit, or check the safety of recent changes**, with phrasings like:
- "review my changes"
- "what did I break?"
- "is this branch safe to merge?"
- "pre-PR check"
- "what's risky in this diff?"
- "check the blast radius of my changes"
- explicit command `/openlore-review-changes`

**No code is written.** Output is a risk-ranked review with a go/no-go recommendation.

---

## Step 1 — Confirm directory and base ref

Ask: which project? Diff against which base? (default: `main`)

Store as `$DIRECTORY` and `$BASE_REF`.

---

## Step 2 — Detect changed functions and risk scores

Call the openlore MCP tool `detect_changes` with:
```json
{"directory": "$DIRECTORY", "base": "$BASE_REF"}
```

The risk score is **multiplicative**: `likelihood × impact`.
- `likelihood` = how much was changed × how poorly covered it is (`"called"` tests count full; `"imported"`-only count 0.3×)
- `impact` = structural blast radius (log fanIn + distance-weighted transitive callers weighted by callType + external boundary calls)

A function with fanIn=0 calling nothing external scores 0 regardless of change size — correct; focus on non-zero scores.

Present a risk-ranked table:

| Rank | Function | File | riskScore | blastRadius | fanIn | testedBy |
|---|---|---|---|---|---|---|

Flag:
- `riskScore ≥ 5` → 🔴 HIGH — must inspect
- `riskScore 2–5` → 🟡 MEDIUM — inspect if time allows
- `riskScore < 2` → 🟢 LOW

---

## Step 3 — Deep-inspect each HIGH function

For each function with `riskScore ≥ 5`, call `get_minimal_context`:
```json
{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME"}
```

**What to read:**

- `function.riskLevel` — `"high"` means the tool expanded caller/callee lists to 24. All shown entries are in the blast radius.
- `callers[*].callType` — all `"awaited"` = async interface frozen; any signature change breaks every caller without a compile error in JS. Mixed = looser coupling.
- `callees[*].isExternal: true` — function touches an external boundary (HTTP/DB). Failures here propagate outward and may not be caught in unit tests.
- `testedBy[*].confidence` — `"called"` = direct test (strong safety net). `"imported"` = test file only imports the module; `vi.mock()` can neutralize it entirely. Only `"imported"` = effectively untested.

For each HIGH function, state:
```
$FUNCTION_NAME ($FILE):
  Interface frozen? [yes — all callers await | no — mixed]
  External boundary? [yes: $CALLEES | no]
  Effective coverage: [strong (called) | weak (imported only) | none]
  Verdict: [safe | needs direct tests first | coordinate with callers before merge]
```

---

## Step 4 — Check cluster density for non-safe HIGH functions

For any HIGH function whose verdict is not "safe":
```json
{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME"}
// get_cluster
```

Read `stats.clusterDensity`:

| Density | Meaning | Action |
|---|---|---|
| < 0.05 | Sparse — shared utilities | Change isolated; safe to land independently |
| 0.05–0.15 | Moderate coupling | Review `internalCallGraph` for transitively dependent functions |
| > 0.15 | Dense — tightly interwoven | Coordinate whole cluster; consider feature flag or staged rollout |

---

## Step 5 — Coverage gap check

For each HIGH or MEDIUM function with `testedBy` empty or all `"imported"`:

> "⚠️ `$FUNCTION_NAME` has no direct test coverage. Changes here are not caught by the test suite unless a test directly calls this function. Recommend adding a characterisation test before merging."

Suggest a concrete test scenario based on the function body from `get_minimal_context`.

---

## Step 6 — Output the review

### Summary
- Total changed: N | HIGH: N | MEDIUM: N | Coverage gaps: N

### Risk table
(from Step 2)

### Function verdicts (HIGH only)
(from Steps 3–4)

### Go / No-Go
- ✅ **Safe to merge** — no HIGH-risk uncovered functions
- ⚠️ **Merge with caution** — HIGH-risk functions exist but covered by direct tests
- 🛑 **Do not merge** — HIGH-risk uncovered functions with frozen interfaces or external boundaries

---

## Absolute constraints

- Never skip Step 3 for HIGH-risk functions — riskScore alone is not enough
- Always interpret `callType` — determines whether interface change is breaking
- Always interpret `testedBy.confidence` — `"imported"` is not strong coverage
- Do not recommend merging any function with `riskScore ≥ 5`, zero direct tests, and an external callee
