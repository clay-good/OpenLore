# Tasks — adopt-mcp-tasks-and-cache-hints

## Implementation
- [ ] Stage 0 gate: track the 2026-07-28 RC → final transition (spec revision + SDK release);
      record the go/no-go in this change before any code lands — nothing ships against the
      moving spec
- [ ] Stage 1: derive `ttlMs`/`cacheScope` from the lease's existing thresholds
      (`epistemic-lease.ts:10`) beside the prose note (`:777-807`) — hint only ever more
      conservative than the lease; watcher-event-bound results (recall, certificates) declare the
      no-store-equivalent scope; no new tuning constant
- [ ] Stage 2: task handles for `analyze_codebase` and the cold-start bootstrap
      (`mcp.ts:2441-2452`) when the client negotiates the tasks capability — progress via
      `tasks/get`, cancel via `tasks/cancel`; capability absent → byte-identical behavior
- [ ] Stage 3: `find_clones` `symbol` XOR `snippet` as 2020-12 `oneOf` (`mcp.ts:1763-1773`,
      prose XOR at `:1767-1768`); sweep all prose-only exclusivity constraints; keep
      `validateToolArgs` (`mcp.ts:2476-2481`) as defense in depth
- [ ] Stage 4: retire the custom initialize handler (`mcp.ts:2402-2423`); re-home the breadth
      pointer, version report, and client-identity capture on the final spec's carriers, keeping
      the old path for pre-RC protocol versions the SDK still pins
- [ ] Addendum 2026-10-31: gate on SDK support; required `ttlMs`/`cacheScope` on `tools/list`
      (+ resources if served); guard test pinning deterministic `tools/list` order; tasks follow the
      redesigned extension (`tasks/get`/`tasks/update`)

## Verification
- [ ] Conformance test: every emitted cache hint is ≤ the lease's own validity for the same
      response state (fresh/degraded/stale table-driven), and the prose note is byte-identical to
      today's for every state
- [ ] Task lifecycle test: `analyze_codebase` under the tasks capability returns a handle;
      `tasks/get` reports progress; `tasks/cancel` stops the build without corrupting the store;
      without the capability the blocking behavior is unchanged
- [ ] Schema test: `find_clones` with both `symbol` and `snippet` (or neither) is rejected by
      schema validation before dispatch; each alone passes; error text remains actionable
- [ ] Handshake matrix: a pre-RC client negotiates the legacy initialize path and still receives
      the lean-default breadth pointer; a final-spec client gets it via the new carrier
- [ ] tools/list payload budget re-asserted (`mcp-presets.test.ts:582-584`, full < 88k) with the
      per-bump rationale if `oneOf` grows schemas
- [ ] Full suite green; no conclusion output changes anywhere (snapshot pins on the substrate
      preset's 13 tools)

## Spec
- [ ] `mcp-quality` delta: ADD RcAdoptionGatedOnFinalization, SchemasExpressParameterExclusivity
- [ ] `mcp-handlers` delta: ADD CacheHintsNeverOutrunTheLease, LongOperationsAreTasksWhenNegotiated
