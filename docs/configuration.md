## Configuration

> This page documents `.openlore/config.json`. For the LLM **provider** table (keys, env vars,
> default models), see [providers.md](providers.md). To list opt-in features and how to enable each,
> run `openlore features`.

`openlore init` creates `.openlore/config.json`:

```json
{
  "version": "1.1.0",
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
| `OPENLORE_LLM_LOGS` | LLM commands/API | Set to exactly `1` to persist redacted prompts and responses under `.openlore/logs/`; disabled by default, new opted-in logging is bounded to six files or 300 MB (older logs are pruned on the next opted-in save) |
| `OPENLORE_NO_WORKERS` | `analyze` | Run per-file extraction on a single thread instead of the worker pool. Both lanes produce byte-identical analysis output, so this only costs wall-clock — set it to isolate a worker-related problem, or in an environment where extra threads are unwelcome |
| `OPENLORE_NO_FACT_CACHE` | `analyze` | Re-extract every file instead of reusing the per-file extraction cache, exactly as `--force` does (and, like `--force`, the cache is refilled afterwards). Both lanes produce byte-identical analysis output, so this only costs wall-clock — reach for it when a CLI flag is not available, e.g. from an embedded caller |
| `OPENLORE_NO_AUTO_HEAP` | CLI | Disable [adaptive heap sizing](#analyzing-at-any-repository-size) — the CLI runs at Node's default heap (or whatever you set) with no re-exec, exactly as before this feature existed |
| `OPENLORE_HEAP_MB` | CLI | Force the analyzer's V8 old-space heap to this many MB (skips auto-detection). Equivalent to setting `--max-old-space-size` yourself, but as an env knob |
| `OPENLORE_HEAP_FRACTION` | CLI | Fraction of available memory used for the heap when sizing automatically (default `0.75`) |
| `OPENLORE_FORCE_MEMORY_TIER` | `analyze` | Force the [graceful-degradation tier](#analyzing-at-any-repository-size): `full`, `shed-overlay`, or `shed-overlay-and-deep-analysis`. Overrides the pre-flight estimate — for a memory-constrained CI job that wants reduced fidelity deterministically, or to reproduce the degraded path |

> **The extraction cache costs disk.** `analyze` memoizes each file's extracted facts inside
> `call-graph.db`, keyed by content hash, so a later run re-parses only what changed. It is
> the largest table in the store — roughly **10 MB per 800 source files** (about +55% on the
> graph index). It is a pure cache: deleting `.openlore/analysis/` reclaims it and costs only
> time, never correctness. (`analyze --force` re-extracts everything and then *refills* the
> cache, so it reclaims nothing — it is the correctness escape, not the disk one.) The cache
> is stripped from `openlore export` bundles, which carry the graph and not this machine's
> build cache.

### Trusted bundle producers

Signed bundle import is opt-in. Each trusted signer is an inline Ed25519 public key in SPKI PEM
form; an optional label is display-only, while OpenLore derives identity from the key fingerprint.
Because this repository-controlled file defines the trust root, review changes to it like any
other security-sensitive configuration.

```json
{
  "bundle": {
    "trustedSigners": [
      { "label": "release", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----" }
    ]
  }
}
```

> The `EMBED_*` variables configure the **remote** embedding provider only. For on-device embeddings with no endpoint or key, run `openlore embed --local` (or set `embedding.provider: "local"` in `.openlore/config.json`). Keyword (BM25) search is the first-class default and needs none of these. See [docs/semantic-search.md](semantic-search.md#retrieval-modes) for the full embedding/retrieval-mode reference.

### Repository secret redaction

OpenLore redacts credential-shaped repository content before source-carrying tool results reach an
agent. Redacted results include a count and the matched credential kinds. Persisted LLM request logs
use the same pattern set for both prompts and responses and record the redaction count per request.

The tool-output boundary is enabled by default. Repository config cannot disable it because cloned
code is not trusted to choose whether source secrets are disclosed. A trusted solo operator who
requires byte-exact tool output can opt out explicitly for one process:

```bash
OPENLORE_UNREDACT_TOOL_OUTPUT=1 openlore mcp
```

This opt-out does not disable redaction in LLM logs, errors, or telemetry.

### Analyzing at any repository size

**The promise: `openlore analyze` works to your machine's capacity, degrades gracefully and transparently beyond it, and never crashes — with no flags and no attention.** Two mechanisms deliver that, both on by default:

1. **Adaptive heap sizing.** A very large repository's call graph can outgrow Node's default V8 heap, and the old recourse was knowing to pass `--max-old-space-size` by hand. The CLI now sizes its own heap: the finite graph-building commands (`analyze`, `install`, `prove`, `import`, `run`) re-execute themselves **once** at startup with a heap set to a generous fraction (`0.75`) of the memory *available to the process* — the container/cgroup limit when there is one (walking the cgroup hierarchy for the tightest cap, so a CI or container job sizes to its own limit, not the host's, and is not OOM-killed), otherwise host RAM. It is quiet and safe: at most once (a marker prevents any loop), skipped when you already set the heap (`--max-old-space-size` / `NODE_OPTIONS`) or opted out (`OPENLORE_NO_AUTO_HEAP`), and the one-line disclosure goes to **stderr**, never stdout. The query hot paths (`orient`, `search`, …) and the long-lived daemons (`mcp`, `serve`) are **not** re-executed — the hot paths read bounded data and must not pay an extra process spawn, and a daemon must not run behind a blocking supervisor that could orphan it on a directed signal; give a daemon on a huge repo a heap the ordinary way (`--max-old-space-size` or `OPENLORE_HEAP_MB`, both honored). Turn sizing off with `OPENLORE_NO_AUTO_HEAP=1`; pin an exact size with `OPENLORE_HEAP_MB`; change the fraction with `OPENLORE_HEAP_FRACTION`.

2. **Graceful degradation, disclosed.** Before the heavy passes, the analyzer estimates the memory the graph will need from the repository's own size (file count + bytes). If even the largest sane heap will not hold full-fidelity analysis, it sheds the most expensive, least-essential work first — the **CFG/def-use overlay**, then **LLM deep-analysis breadth** — and still produces a usable index (call graph + search intact), rather than aborting with a raw out-of-memory fatal. Whatever it reduced is disclosed in `parse-health.json` (a `memoryDegradation` record) and in one CLI line, so a downstream conclusion reads reduced coverage as *reduced*, never as genuine structural absence.

**Determinism is preserved.** Heap size and buffer-versus-spill choices never change the produced artifact: two full-fidelity runs of the same repository are byte-identical regardless of how much RAM each machine had. Only the degradation ladder reduces content, and only as a function of *declared* constraints (available memory, repository size) — disclosed and reproducible, never a silent machine-dependent difference between two "full" runs.

**Embeddable API path.** The in-process API (`import { analyze } from 'openlore'`) cannot re-execute the host process, so it does **not** resize the heap — the host owns that. The degradation ladder still applies within whatever heap the host provides, so an over-capacity repository degrades gracefully there too instead of crashing. Because the pre-flight estimate is deliberately conservative (it over-estimates so degradation triggers *before* a crash), an embedding host running at Node's default heap may shed the overlay on a large-but-manageable repository. If you want full fidelity there, give the host process a real heap (`--max-old-space-size`, or `OPENLORE_HEAP_MB`), or force the tier with `OPENLORE_FORCE_MEMORY_TIER=full` when you know it fits.

**Not yet in scope:** an out-of-core (streaming) graph — a graph *larger than RAM*, persisted and never held whole. Adaptive heap plus graceful degradation cover the practical need; a genuine RAM-ceiling case at normal function density would earn its own proposal.

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

An optional `enforcement.policy` block is the **single source of truth** for what blocks a commit, freezes existing debt, merely advises, or is deliberately silenced. It maps a stable governance finding **code** to one enforcement class — `blocking`, `frozen`, `advisory`, or `off` — decoupling a finding's *intrinsic severity* (owned by the source that computes it) from this repository's *risk posture* (owned here). It is consumed by [`openlore enforce`](cli-reference.md#enforcement-gate), the unified gate.

```json
{
  "enforcement": {
    "policy": {
      "stale-decision-reference": "blocking",
      "surface-critical": "frozen",
      "orphans-anchored-memory": "off"
    }
  }
}
```

- **Additive and optional.** An absent or empty policy preserves today's behavior exactly — every finding stays **advisory by default**, so nothing newly blocks.
- **Brownfield ratchet.** `frozen` records the code's current finding identities in `.openlore/enforcement-baseline.jsonl`; later findings absent from that committed baseline block, and fixed identities are removed. Run `openlore enforce` outside hook mode to initialize or shrink the baseline. Review the result, then run `git add .gitignore` and `git add .openlore/config.json .openlore/enforcement-baseline.jsonl` before enabling the hook. Hooks and PR review never initialize debt from the candidate change, and PR review never shrinks the baseline.
- **Stable identity.** Baseline matching uses code + subject + a source-owned discriminator where needed. It never uses message wording or file:line, so moving a violation does not un-freeze it.
- **Reviewable progress.** A hook that ratchets the baseline keeps the commit blocked until the changed baseline is staged. Read-only PR review reports identities that would retire and directs the operator to run `openlore enforce` locally. An invalid candidate config cannot silently disable a frozen policy from the trusted base. Downgrading `frozen` to `advisory` through a valid config leaves its baseline bytes untouched; re-upgrading resumes from them.
- **Deterministic precedence.** A finding's class is a pure function of `(code, policy)`: a direct `enforcement.policy` value (`blocking`, `frozen`, `advisory`, or `off`) wins over legacy sugar, and legacy sugar wins over the source-declared default. Each code has one effective class; there is no priority ordering among explicit class values.
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
| `tokenBudget` | `600` | Hard cap on the injected block, in estimated tokens, with a 68-token minimum for the mandatory framed task and stale-index disclosure. Lower positive values are clamped to `68`; lower-priority detail (functions → files → call neighbours → specs → tools) is dropped to stay within budget. |
| `relevanceMinMatches` | `2` | Relevance gate: minimum matched-function count unless the prompt names a matched identifier exactly (below it → a one-line pointer). |
| `relevanceMinFanIn` | `2` | Relevance gate: a match with at least this fan-in (or a hub) clears the gate structurally. Exact identifier mentions and scale-free top-match identifier overlap can also clear the gate. |
| `relevanceMinScore` | `0.3` | Relevance gate: minimum top match score — used **only** on the bounded semantic/hybrid score scale (BM25-fallback scores are corpus-relative and the score path is disabled there). |

The relevance gate is deterministic and never learned: when a task's graph match is weak (the small/familiar/shallow case), injection degrades to a single pointer line rather than taxing a task that needs no orientation. Injection is fail-open — any failure (no graph, parse error, empty/weak match) emits the pointer line and exits 0, so the hook can never break the agent's turn. Set `OPENLORE_INJECT_DEBUG=1` to write the gate verdict and applicable failed criteria to stderr; stdout remains injection-only.

> **Without embeddings** (the default keyword/BM25 index) the gate never compares the unbounded, corpus-relative BM25 score to a fixed threshold. It uses matched-function count plus scale-free evidence: an exact identifier mention, top-match identifier-token overlap, or fan-in/hub centrality. Running `openlore embed --local` (one command, on-device, no API key) — or configuring a remote `EMBED_*` endpoint — additionally enables the bounded semantic-score path (`relevanceMinScore`). The injected block is always explicitly ignorable, so a false positive costs only a few tokens.
