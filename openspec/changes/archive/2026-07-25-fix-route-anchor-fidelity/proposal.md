# Fix TS/JS route line fidelity: skeleton-relative lines anchored against original file bytes

> Status: SHIPPED (2026-07-19). `extractTsRouteDefinitions` now masks comments length-preservingly
> (blank-to-spaces, newlines kept) instead of skeletonizing, so every `route.line` is byte-aligned
> with the original file and exact by construction — the dropped/mis-attributed route-handler edge
> and false dead-code candidate are both fixed. Orphaned `getSkeletonContent`/`detectLanguage`
> imports removed. Spec `analyzer` gained `RouteLineFidelityIsLengthPreserving`. Regression proof:
> unit line-fidelity + false-positive-suppression (ts-route-extractor.test.ts), route-handler edge
> wired through the real builder despite the drift (edge-synthesis.test.ts), and a full
> build → find_dead_code e2e (reachability-synthesis.test.ts) — all four fail without the fix.
>
> Original (PROPOSED 2026-07-08, e2e audit fifth pass): TS/JS route lines are computed against a
> SHRUNKEN skeleton but consumed against ORIGINAL file bytes — dropped or mis-attributed
> route-handler edges, and live Express/Fastify handlers surfacing as false dead-code candidates
> (empirically reproduced). The length-preserving discipline already exists in the same file.

## The defect(s)

**Skeleton-relative lines, original-byte consumers.** `extractTsRouteDefinitions`
(`http-route-parser.ts:1055`) parses `getSkeletonContent(...)` (`http-route-parser.ts:1062`) —
which REMOVES pure-comment lines, log lines, and non-JSDoc block comments and collapses blank
runs (`code-shaper.ts:65-120`: "The returned skeleton is always shorter than or equal to the
original") — and computes every `route.line` against the shrunken text. The code admits it:
"Line numbers in the result are approximate (skeleton line positions)"
(`http-route-parser.ts:1061`). `synthesizeRouteHandlerEdges` (`call-graph.ts:3632`) then anchors
that approximate line into the ORIGINAL file:
`findEnclosingFunction(nodesByFile.get(route.file) ?? [], offsetOfLine(content, route.line))`
(`call-graph.ts:3665`).

**Empirical repro.** A 5-line copyright block + one comment + one `console.log` above
`setupRoutes` → `app.get('/users', listUsers)` is reported at line 9, actual line 16.
`offsetOfLine` lands ABOVE `setupRoutes` → no enclosing function → the edge is silently dropped
(`continue`, `call-graph.ts:3666`). A different drift amount lands INSIDE the PREVIOUS function →
the edge is attributed to the wrong caller.

**Downstream blast radius.** `externallyInvokedHandlerIds`
(`src/core/services/mcp-handlers/reachability.ts:90-100`) seeds dead-code liveness roots from the
targets of these very edges (`synthesizedBy === 'route-handler'`, `reachability.ts:95`) — a
dropped edge makes a live, framework-invoked Express/Fastify handler a false `find_dead_code`
candidate, and `blast_radius`/fan-in loses the registration-site caller.

**The discipline already exists in this file — three times.**
- The Python extractor's masking is explicitly length-preserving because line fidelity is
  "load-bearing" (`http-route-parser.ts:316-323`: "the masked string must stay byte-aligned with
  `content` or the reported line … drifts").
- Comment-masking in `extractHttpCalls` was already CONVERTED to length-preserving for exactly
  this failure class (`http-route-parser.ts:184-194`: "Removing comment text instead (the old
  behavior) shifted offsets … which then mis-resolved or dropped its enclosing-function edge").
- PR #211 fixed a 1-line special case of the same family (`recOffset`,
  `http-route-parser.ts:1178`: the leading-newline match landing "one line early").

The systematic N-line drift from the skeleton remains.

## What changes

Replace `getSkeletonContent` in `extractTsRouteDefinitions` with a length-preserving comment
mask, keeping the original false-positive protection (route pattern strings inside comments must
still not match) without the line drift:

- Mask block comments with the existing `blankKeepNewlines` (`http-route-parser.ts:891`) and
  line comments with the existing prefix-preserving replacement already used by
  `extractHttpCalls` (`http-route-parser.ts:192-194`) — same regexes, same file, zero new
  masking logic.
- Log-line stripping (a skeleton feature irrelevant to route regexes) is simply not applied —
  a `console.log` line cannot match a route registration pattern.
- Delete the "approximate line" caveat comment; `route.line` becomes exact by construction.
- Regression fixtures: the repro file (copyright block + comment + log line above a routed
  function) pins that the edge lands on `setupRoutes`, and that a handler registered after long
  comments is never a dead-code candidate.

## Why this is in scope

Route-handler synthesis exists to keep framework-invoked handlers structurally honest — live in
`find_dead_code`, visible in `blast_radius`. A line computed in one coordinate system and
consumed in another is a deterministic bug producing quiet wrong answers (a silently dropped
liveness root is the worst kind: it flips a conclusion tool's verdict). The fix is precision work
on an existing capability using the file's own established length-preserving discipline — no new
constants, no new heuristics, no LLM (decision `c6d1ad07`).

## Impact

- Files: `src/core/analyzer/http-route-parser.ts` (`extractTsRouteDefinitions` masking); repro
  fixture + tests. `call-graph.ts` / `reachability.ts` consumers are untouched — they were
  correct; their input was wrong.
- Consumers improve for free: route-handler edge synthesis, `find_dead_code` liveness roots,
  `blast_radius` fan-in, route inventory line numbers, and the handler-name lookup that reads
  `lines[routeLine - 1]` (`http-route-parser.ts:1182`) — currently reading the wrong original
  line for any drifted route.
- Specs: `analyzer` — 1 ADDED requirement (RouteLineFidelityIsLengthPreserving).
- Tool surface: unchanged.
- Risk: low. Masking is strictly weaker than skeletonization for false-positive protection only
  in the comment-example case, which the mask still covers; NestJS/Next.js branches share the
  same `source` and inherit exact lines.
