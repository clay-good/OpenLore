## Configuration

`openlore init` creates `.openlore/config.json`:

```json
{
  "version": "1.0.0",
  "projectType": "nodejs",
  "openspecPath": "./openspec",
  "analysis": {
    "maxFiles": 500,
    "includePatterns": [],
    "excludePatterns": []
  },
  "generation": {
    "model": "claude-sonnet-4-20250514",
    "domains": "auto"
  }
}
```

### Environment Variables

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | `anthropic` | Anthropic API key |
| `ANTHROPIC_API_BASE` | `anthropic` | Custom base URL (proxy / self-hosted) |
| `OPENAI_API_KEY` | `openai` | OpenAI API key |
| `OPENAI_API_BASE` | `openai` | Custom base URL (Azure, proxy...) |
| `OPENAI_COMPAT_API_KEY` | `openai-compat` | API key for OpenAI-compatible server |
| `OPENAI_COMPAT_BASE_URL` | `openai-compat` | Base URL, e.g. `https://api.mistral.ai/v1` |
| `GEMINI_API_KEY` | `gemini` | Google Gemini API key |
| `COPILOT_API_BASE_URL` | `copilot` | Base URL of the copilot-api proxy (default: `http://localhost:4141/v1`) |
| `COPILOT_API_KEY` | `copilot` | API key if the proxy requires auth (default: `copilot`) |
| `EMBED_BASE_URL` | embedding (remote) | Base URL for a remote OpenAI-compatible embedding API (e.g. `http://localhost:11434/v1`) |
| `EMBED_MODEL` | embedding (remote) | Remote embedding model name (e.g. `nomic-embed-text`) |
| `EMBED_API_KEY` | embedding (remote) | API key for the remote embedding service (defaults to `OPENAI_API_KEY`) |
| `DEBUG` | -- | Enable stack traces on errors |
| `CI` | -- | Auto-detected; enables timestamps in output |
| `OPENLORE_NO_AUTO_ANALYZE` | -- | Disable the MCP server's cold-start self-bootstrap (no background index build on first run) |
| `OPENLORE_NO_UPDATE_NOTIFIER` | -- | Silence the passive "update available" banner (`NO_UPDATE_NOTIFIER` is also honored) |
| `OPENLORE_SKIP_POSTINSTALL` | -- | Suppress the post-install next-step hint |

> The `EMBED_*` variables configure the **remote** embedding provider only. For on-device embeddings with no endpoint or key, run `openlore embed --local` (or set `embedding.provider: "local"` in `.openlore/config.json`). Keyword (BM25) search is the first-class default and needs none of these. See [docs/semantic-search.md](semantic-search.md#retrieval-modes) for the full embedding/retrieval-mode reference.

### Spec-store binding

An optional `specStore` block in `.openlore/config.json` binds this repository to an external **spec store** — a standalone repository that holds specs/changes — and declares the code repositories its plans are about. It is configuration only: OpenLore reads the declared relationships and never clones, writes to, syncs, or fences the store or any target. Omit the block entirely for unchanged single-repository behavior.

```json
{
  "specStore": {
    "name": "team-plans",
    "path": "../team-plans",
    "targets": ["api", "web"],
    "references": ["design-system"]
  }
}
```

| Field | Required | Meaning |
|-------|:---:|---------|
| `name` | yes | a stable, user-facing name for the store |
| `path` | yes | absolute or repo-relative path to the external spec repository |
| `targets` | yes | federation-registered names of the code repositories the store's work is *about* |
| `references` | no | federation-registered names of repositories the store draws on for *context* |

`targets` and `references` are **names**, not paths: each must match a repository registered with `openlore federation add … --name <name>` (see [Federation](federation.md)). Check the binding's health with `openlore spec-store status` ([CLI reference](cli-reference.md#spec-store-binding)); it reports per-target resolution, index freshness, reference presence, and store-path presence as findings with stable codes, and never blocks.

### Covering surfaces (change-impact certificate)

An optional `impactCertificate` block declares the **covering surfaces** the change-impact certificate assesses a diff against — semantic or governance boundaries (a client surface, a data-handling surface, a regulated interface), not directory globs. Omit it entirely and the certificate still reports blast radius, drifted specs, and tests; declaring surfaces additionally reports the paths a change *newly opens* into each. See [`openlore impact-certificate`](cli-reference.md#change-impact-certificate) and the [`change_impact_certificate` MCP tool](mcp-tools.md).

```json
{
  "impactCertificate": {
    "surfaces": [
      {
        "name": "client",
        "severity": "critical",
        "members": [
          { "symbol": "renderResponse" },
          { "file": "src/api/public.ts" }
        ]
      }
    ],
    "block": ["critical"]
  }
}
```

| Field | Required | Meaning |
|-------|:---:|---------|
| `surfaces[].name` | yes | a stable, user-facing surface name (must be unique; empty names and duplicates are dropped) |
| `surfaces[].members` | yes | the boundary's members: each is a `{ "symbol": "<name>" }` (resolved to exactly one indexed symbol — ambiguous/unknown becomes a finding, never guessed) and/or a `{ "file": "<repo-relative path>" }` (all of the file's symbols). A member may set both. |
| `surfaces[].severity` | no | `info` \| `warn` \| `critical` (default `warn`); any other value is coerced to `warn` |
| `block` | no | severities the **advisory git hook** should fail a commit on (e.g. `["critical"]`). Empty/absent = advisory-only (the default). Infrastructure failure never blocks. Now thin legacy sugar that lowers onto [`enforcement.policy`](#enforcement-policy) (`["critical"]` ≡ `{ "surface-critical": "blocking" }`); a direct policy entry wins. |

A surface is resolved against the indexed graph (plus any symbol the same diff just added). The certificate is advisory by default and decays via the code-anchored freshness lease; when an anchored symbol later moves, `openlore spec-store status` re-fires a persisted certificate as a `certificate-stale` finding.

### Enforcement policy

An optional `enforcement.policy` block is the **single source of truth** for what blocks a commit, what merely advises, and what is deliberately silenced. It maps a stable governance finding **code** to one enforcement class — `blocking`, `advisory`, or `off` — decoupling a finding's *intrinsic severity* (owned by the source that computes it) from this repository's *risk posture* (owned here). It is consumed by [`openlore enforce`](cli-reference.md#enforcement-gate), the unified gate.

```json
{
  "enforcement": {
    "policy": {
      "stale-decision-reference": "blocking",
      "surface-critical": "blocking",
      "orphans-anchored-memory": "off"
    }
  }
}
```

- **Additive and optional.** An absent or empty policy preserves today's behavior exactly — every finding stays **advisory by default**, so nothing newly blocks.
- **Deterministic precedence.** A finding's class is a pure function of `(code, policy)`: an explicit `off` wins over an explicit `blocking`, which wins over an explicit `advisory`, which wins over the source-declared default. Resolution is order-independent.
- **Severity is never changed.** The policy decides *enforcement class* only; the emitting source remains the sole authority on a finding's intrinsic severity.
- **`off` is visible, not invisible.** A silenced finding is still listed in the gate output (marked `off`), so a deliberate silence is auditable.
- **Legacy `block` sugar lowers onto it.** `blastRadius.block: ["orphans-anchored-decision"]` and `impactCertificate.block: ["critical"]` are thin equivalents of `enforcement.policy: { "orphans-anchored-decision": "blocking" }` and `{ "surface-critical": "blocking" }`. A direct `enforcement.policy` entry always wins over inherited legacy sugar.
- **Unknown codes are retained.** Naming a code no installed source emits yet is not an error — the entry is kept and surfaced as an informational note, so a policy may name a code before its source ships.

The governable finding codes (the **finding-code catalogue** — every code defaults to `advisory`; blocking is always opt-in):

| Code | Source | Default | Meaning |
|------|--------|---------|---------|
| `stale-decision-reference` | stale-decision-reference | advisory | A live, authoritative artifact (approved decision, non-orphaned anchored memory, or spec requirement) references a decision that has since been superseded. |
| `orphans-anchored-memory` | blast-radius | advisory | The change orphans one or more code-anchored memories. |
| `orphans-anchored-decision` | blast-radius | advisory | The change orphans one or more anchored architectural decisions. |
| `surface-info` | impact-certificate | advisory | The change opens a new path into a declared covering surface marked `info`. |
| `surface-warn` | impact-certificate | advisory | The change opens a new path into a declared covering surface marked `warn`. |
| `surface-critical` | impact-certificate | advisory | The change opens a new path into a declared covering surface marked `critical`. |
| `parallel-work-conflict` | plan-parallel-work | advisory | Two tasks proposed for concurrent work have a write-write (WAW) conflict; `plan_parallel_work` schedules them into different waves. |
| `parallel-work-cycle` | plan-parallel-work | advisory | A set of proposed tasks forms an unorderable read-after-write cycle; `plan_parallel_work` schedules the members mutually exclusive and the circular dependency should be resolved. |
| `cross-actor-conflict` | interference-map | advisory | Two in-flight changes (branches/PRs/agent tasks, within or across a federation) have a write-write (WAW) conflict on a shared symbol; `map_in_flight_conflicts` reports them as must-not-land-concurrently. A CI check can name this code to warn when a new PR collides with an open one. |

> **Note on the surface codes.** The change-impact certificate's *own* `--json` finding codes are `surface-newly-reached` / `surface-critical` (see [mcp-tools.md](mcp-tools.md)); the enforcement gate governs the **per-severity** codes `surface-info` / `surface-warn` / `surface-critical` (one per declared surface severity). To block a surface via `enforcement.policy`, name the per-severity code (e.g. `"surface-critical": "blocking"`), not `surface-newly-reached` — an unrecognized code is retained but governs nothing.

> **Note on the parallel-work / cross-actor codes.** `parallel-work-conflict` / `parallel-work-cycle` (from `plan_parallel_work`) and `cross-actor-conflict` (from `map_in_flight_conflicts`) are emitted **only** by those MCP tools, which `openlore enforce` never runs (the gate is diff-based; these tools need a caller-supplied task list or live git/PR state). Naming them in `enforcement.policy` lets the **caller that invokes the tool** classify its `findings[]` with `resolveEnforcementClass` and block in its own CI — e.g. a CI check that warns when a new PR's footprint collides with an open one; the bundled commit gate never produces or blocks on them.

### Task-scoped context injection

An optional `contextInjection` block controls the per-task orientation that `openlore install` wires as a Claude Code `UserPromptSubmit` hook (`openlore orient --inject`). It runs `orient` against your submitted prompt and places a bounded, ignorable orientation block in context *before the agent's first turn*, so the common task begins already oriented without a manual `orient` call — amortizing the per-task round-trip the [Value Scorecard](AGENT-BENCHMARKS.md) attributes the small/familiar loss case to. Omit the block entirely for the defaults below (injection enabled). See [`openlore install`](install.md#task-scoped-context-injection).

```json
{
  "contextInjection": {
    "mode": "task-scoped",
    "tokenBudget": 600,
    "relevanceMinMatches": 2,
    "relevanceMinFanIn": 2,
    "relevanceMinScore": 0.3
  }
}
```

| Field | Default | Meaning |
|-------|:---:|---------|
| `mode` | `task-scoped` | `task-scoped` enables injection; `off` makes `orient --inject` a no-op (exit 0). Disabling does **not** affect the MCP server or the `SessionStart` primer. |
| `tokenBudget` | `600` | Hard cap on the injected block, in estimated tokens. The mandatory header + task line is the floor; lower-priority detail (functions → files → call neighbours → specs → tools) is dropped to stay within budget. |
| `relevanceMinMatches` | `2` | Relevance gate: minimum matched-function count to emit a full block (below it → a one-line pointer). |
| `relevanceMinFanIn` | `2` | Relevance gate: a match with at least this fan-in (or a hub) clears the gate structurally. |
| `relevanceMinScore` | `0.3` | Relevance gate: minimum top match score — used **only** on the bounded semantic/hybrid score scale (BM25-fallback scores are corpus-relative and the score path is disabled there). |

The relevance gate is deterministic and never learned: when a task's graph match is weak (the small/familiar/shallow case), injection degrades to a single pointer line rather than taxing a task that needs no orientation. Injection is fail-open — any failure (no graph, parse error, empty/weak match) emits the pointer line and exits 0, so the hook can never break the agent's turn.

> **Without embeddings** (the default keyword/BM25 index) the gate is *structural only* — it uses matched-function count and fan-in/hub centrality, not score. A central function can be matched by spurious keyword overlap, so an off-topic prompt may occasionally still emit a block. Running `openlore embed --local` (one command, on-device, no API key) — or configuring a remote `EMBED_*` endpoint — enables the semantic-score path (`relevanceMinScore`), which discriminates relevance far better. The injected block is always explicitly ignorable, so a false positive costs only a few tokens.
