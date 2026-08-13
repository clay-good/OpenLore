## 1. Turn-intent gate for the pre-turn injection

- [x] 1.1 Add a deterministic turn-intent classifier (pure, no LLM, no network) to `orient-inject-render.ts` with an explicit management-intent pattern set and a fail-open default to code work.
- [x] 1.2 Run the intent gate before the relevance gate in `buildInjection`; withhold to the pointer line on management intent.
- [x] 1.3 Extend the gate-evaluation result with a stable `reason` (`management-intent`, `weak-relevance`, `no-graph`, `empty-prompt`, `error`) and emit it in the injection telemetry event.
- [x] 1.4 Add a `contextInjection.intentGate` config switch (default on) resolved in `resolveInjectionConfig`.
- [x] 1.5 Make the pointer line reason-bearing in agent-visible text: one variant per withhold cause, each naming the manual orientation call, so absence never reads the same for "not code work" and "nothing matched".
- [x] 1.6 Assert the never-silent invariant while injection is enabled: every path, including every failure path, emits non-empty output; only `mode: "off"` emits nothing.
- [x] 1.7 Tests: management turns ("push and open the PR", "the PR was merged", "cut a release", "write the changelog") withhold; code-work turns are unaffected; an unclassifiable turn keeps today's path; the withhold reason is attributable; a misclassified code-work turn still receives a reason-bearing pointer line.

## 2. Scope-aware memory staleness

- [x] 2.1 Thread the existing drift scope (diff / changed files / file pattern) into the memory-staleness pass of `drift-detector.ts`.
- [x] 2.2 Enumerate only in-scope anchors; aggregate out-of-scope drifted anchors into a counted `out-of-scope` summary field.
- [x] 2.3 Prove scoping changes no verdict: the same anchor yields the same freshness whether enumerated or counted.
- [x] 2.4 Update CLI/MCP rendering of the drift summary to show the out-of-scope count without listing it.

## 3. Terminal state for a deleted anchor

- [x] 3.1 Add a retired disposition with reason `anchor-file-deleted` to the anchored-fact store (append-only, recorded text untouched).
- [x] 3.2 Retire an orphaned anchor only when its file is absent from both the working tree and `HEAD`; leave an uncommitted deletion orphaned.
- [x] 3.3 Suppress retired records from subsequent drift findings while keeping them served by `recall` under `asOf` with the retired disposition.
- [x] 3.4 Tests: retire-once behavior across two runs, uncommitted-deletion exemption, `asOf` retrieval of a retired record, and no rewrite of recorded text.

## 4. Verification

- [x] 4.1 Run the tests reaching the injection, drift, and memory-store paths (`select_tests` on the changed symbols).
- [x] 4.2 Re-run the affected repository on a management turn and a code-work turn to confirm the observed behavior end to end.
