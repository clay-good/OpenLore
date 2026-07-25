# Tasks — fix route anchor fidelity

## Implementation
- [x] `extractTsRouteDefinitions` (http-route-parser.ts:1055-1062): replace `getSkeletonContent`
      with a length-preserving comment mask — `blankKeepNewlines` (:891) for block comments +
      the prefix-preserving line-comment replacement already used in `extractHttpCalls`
      (:192-194); no new masking logic
- [x] Remove the "Line numbers in the result are approximate" caveat (:1059-1061) — lines are
      exact by construction after the change
- [x] Confirm the NestJS decorator and Next.js App Router branches (same `source`) inherit
      exact lines; confirm `recOffset` (:1178) still composes correctly with the mask
- [x] Verify the handler-name lookup (`lines[routeLine - 1]`, :1182) now reads the true
      registration line

## Verification
- [x] Repro fixture pinned: copyright block + comment + `console.log` above
      `setupRoutes` containing `app.get('/users', listUsers)` → route reported at the true line;
      `synthesizeRouteHandlerEdges` wires `setupRoutes` → `listUsers` (edge neither dropped nor
      attributed to the previous function)
- [x] Dead-code regression: the routed handler in the repro fixture is NOT a `find_dead_code`
      candidate (liveness root present via `externallyInvokedHandlerIds`)
- [x] False-positive protection retained: a route pattern string inside a comment
      (`// app.get('/example', h)`) still produces no route
- [x] Existing route-parser + cross-service-edge suites green
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD RouteLineFidelityIsLengthPreserving
