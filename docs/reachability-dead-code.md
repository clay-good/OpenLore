# Reachability & Dead-Code Analysis

> Spec 20. Cross-language. Deterministic, offline, no API key.
> **Candidates, never deletion authority.**

`find_dead_code` answers three graph-reachability questions grep can't (it sees text, not reach)
and the model burns tokens guessing at:

- **"What code is unreachable / dead?"** — mark-and-sweep from roots; the unreached remainder.
- **"Is anything calling X?"** — reachability from every entry point.
- **"What becomes dead if I delete X?"** — the set reachable *only* through X.

Prior art is knip / ts-prune (mark-and-sweep from entry points) — but **TypeScript/JavaScript-only**.
This is the cross-language version over the unified tree-sitter graph (15+ languages).

## Read this first — honest limits

Static reachability **cannot see** dynamic entry points, framework magic (routes, DI, plugin
registries), reflection, or public API consumed *outside* the repo. All of these produce false
"dead" positives. So `find_dead_code`:

- treats **tests, imported symbols, route handlers, and `main`** as roots,
- returns **confidence-tagged candidates with a reason**, never a verdict,
- and **never auto-deletes**.

Every response carries `soundness.posture: "candidates-not-authority"` and explicit caveats. Treat
it as a lead generator for a human/agent to verify — not a delete list.

### The blind spot is now named per answer, not per README

The paragraph above is a *standing* caveat: it cannot say which answer is affected. The analyzer now
records each construct the resolver cannot follow — a **dynamic-boundary site** — during the same
parse that builds the graph, so a conclusion can name the specific line that bounds it:

- a candidate with a site that can **name** it is capped at `low`, and the stated reason is
  `a computed member dispatch at src/cli/commands/doctor.ts:742 can reach this symbol without a
  graph edge` rather than only "dynamic language";
- the answer's `confidenceBoundary.knownUnknowable` carries a `dynamic-boundary` crossing listing
  the file, line and kind of every site inside the subgraph the answer traversed — bounded,
  deduplicated by kind and file, with the omitted count stated;
- `report_coverage_gaps` **withholds** its `also-dead` label for such a symbol (that label asserts
  the absence of any caller), and `verify_claim` resolves a `dead` or `safe-to-change` claim to
  `unverifiable` instead of `confirmed`.

Scope is computable, not repository-wide: a site qualifies a candidate only in the candidate's own
file or in a file whose transitive import closure can name it, in the candidate's own language, and
only for the kinds that can hide a *caller* (`reflective-invoke`, `computed-member`,
`container-resolution`). Sites outside that closure are left to the standing caveat above.

It is **disclosure only** — never resolution, and never the opposite conclusion. A boundary can
withhold a negative claim; it can never report a symbol as live, tested, or unsafe. Recovering the
statically-decidable subset is a separate change (`resolve-literal-reflective-dispatch`). A language
with no matcher records no site and is reported as *unsupported* by the capability registry, never as
containing no dynamic dispatch.

## How roots and confidence work

A node is a **root** (assumed live) if it is a test, is imported by name from another file, is a
detected HTTP route handler, or is `main`-like. Reachability is a forward BFS from those roots.

Confidence is deliberately conservative — the bias is toward **false-live over false-dead**:

| Confidence | When |
|------------|------|
| `high` | static language · no internal caller · not imported by name · **and its module is not imported anywhere** |
| `medium` | reachable only from other dead code, or no dependency-graph signal available |
| `low` | dynamic language (Python/Ruby/PHP/…), **or its module is imported elsewhere** (namespace/default/re-export usage the named-import scan can't resolve), **or a dynamic-boundary site can name it** |

That last rule matters: on a real repo it cut high-confidence candidates from ~470 to ~35 — a
symbol living in a module something else imports is never flagged `high`, because the specific
usage may be a namespace or default import this static scan doesn't resolve.

### Re-export / barrel resolution raises recall (fewer false-dead)

A reachability conclusion is only as sound as the call graph is complete. The TS/JS import resolver
follows re-export chains — `export { x } from './impl'`, `export * from './x'` (and TypeScript's ESM
`.js` specifiers) — through any depth of barrel to a symbol's **true definition**, and that resolution
runs on every cross-file *call edge* (not just base classes). A call imported through a barrel resolves
to the real target (labelled `re_export`) instead of stalling at the barrel and falling through to the
ambiguous first-same-named-candidate (`name_only`). Concretely, dogfooding this repo moved **29 symbols
off the false-dead / false-entry-point list** — e.g. `EdgeStore.open` went from a reported *zero
callers* to its real 22 — because a method/static call through an imported receiver now binds to its
definition. See [openspec/changes/add-call-resolution-recall/](../openspec/changes/add-call-resolution-recall/).

## Tool contract

```jsonc
// Candidate dead-code report
{ "directory": "/abs/path", "maxResults": 100, "filePattern": "src/" }

// "What becomes dead if I delete X?"
{ "directory": "/abs/path", "ifDeleted": "parseConfig" }
```

Report output:

```jsonc
{
  "stats": { "analyzed": 1455, "roots": 399, "reachable": 790, "candidateDead": 665 },
  "rootKinds": { "tests": 0, "imported": 393, "httpHandlers": 0 },
  "byConfidence": { "high": 35, "medium": 35, "low": 595 },
  "candidateDead": [
    { "name": "isValidEmail", "file": "src/utils/validation.ts", "language": "TypeScript",
      "fanIn": 0, "confidence": "high",
      "reason": "no internal caller; not imported by name from any other file; not a test, route handler, or main entry" }
  ],
  "coverage": { "languages": ["TypeScript", "Python", "Go"], "exportSignal": "dependency-graph" },
  "soundness": { "posture": "candidates-not-authority", "caveats": ["These are CANDIDATES…", "…"] }
}
```

Delete-impact output:

```jsonc
{
  "target": "handler",
  "becomesDeadIfDeleted": [{ "name": "helper", "file": "src/app.ts", "language": "TypeScript", "fanIn": 1 }],
  "count": 1,
  "note": "These nodes are reachable only through the target. Deleting it orphans them — verify before removing."
}
```

## How it works

Pure read over the existing graph — **no schema change**:

- **Reachability** — forward BFS over [`buildAdjacency`](../src/core/services/mcp-handlers/graph.ts)'s
  forward map from the root set; candidate-dead = code nodes not reached. External and
  infrastructure (IaC) nodes are excluded.
- **Liveness signals** — tests + HTTP route handlers + `main`, plus the dependency graph's
  imported names (symbol-level) and imported files (module-level) for the cross-language
  "used elsewhere" signal.
- **Delete-impact** — recompute reachability with the target removed from both seeds and the
  graph, and diff against the baseline reached set.

Implementation: [`reachability.ts`](../src/core/services/mcp-handlers/reachability.ts). Tested over
a two-language fixture with known live regions, a dead orphan, a dead cluster, and a
delete-impact diff in
[`reachability.test.ts`](../src/core/services/mcp-handlers/reachability.test.ts).

> Accuracy depends on a current `analyze_codebase` that includes tests and produces the dependency
> graph. Without test nodes as roots, test-only code is flagged; without the dependency graph,
> confidence is reduced and the response says so.

> **Index integrity.** When the persisted index does not reconcile against its build-time attestation —
> materially smaller than the build committed (`degraded`) or built at a different schema (`mismatched`) —
> the response carries that verdict in `confidenceBoundary.integrity` and is not marked `complete`. A
> "dead" conclusion over a half-built index is the most dangerous false negative, so "looks dead to a
> broken index" is labeled, never asserted. Re-run `analyze_codebase` to rebuild.
