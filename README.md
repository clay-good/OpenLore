<h1 align="center">OpenLore</h1>

<p align="center">
  <strong>Deterministic, local-first memory and guardrails for AI coding agents — no LLM in the hot path.</strong><br>
  Install once. From then on it runs in the background, keeping your agent oriented and its changes safe.<br>
  No API key. Same answer every time.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openlore"><img src="https://img.shields.io/npm/v/openlore?color=2563eb&label=npm&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/clay-good/OpenLore/actions/workflows/ci.yml"><img src="https://github.com/clay-good/OpenLore/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/openlore?color=22c55e" alt="MIT License"></a>
  <img src="https://img.shields.io/node/v/openlore?color=339933&logo=node.js&logoColor=white" alt="Node >=22.22">
  <br>
  <img src="https://img.shields.io/badge/MCP-ready-7c3aed?logo=anthropic&logoColor=white" alt="MCP ready">
  <img src="https://img.shields.io/badge/languages-21%20%2B%2012%20IaC-f97316" alt="21 languages + 12 IaC ecosystems">
  <img src="https://img.shields.io/badge/tests-5500%2B-success" alt="5500+ tests">
  <img src="https://img.shields.io/badge/API_key-not_required-0ea5e9" alt="No API key required">
  <a href="https://github.com/clay-good/OpenLore/stargazers"><img src="https://img.shields.io/github/stars/clay-good/OpenLore?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <code>install</code> wires your agent and indexes the repo → <code>orient</code> returns the code a task touches → <code>review</code> catches the change that breaks a contract. All local, no API key.
</p>

<p align="center">
  <strong><a href="#install-once-then-forget-it">Install</a> · <a href="#what-you-get">What you get</a> · <a href="#value-scorecard--does-it-pay-for-itself">Benchmarks</a> · <a href="#openlore-vs-alternatives">vs. Alternatives</a> · <a href="#documentation">Docs</a></strong>
</p>

---

AI coding agents are **amnesiac and ungoverned**. Every task restarts by re-reading the same files, long sessions drift onto stale assumptions, and nothing warns the agent when a change is about to break a contract or cross a boundary.

OpenLore fixes both halves, and then gets out of your way. A **one-time static analysis** builds a live knowledge graph of your repo — call structure, types, tests, decisions, IaC. From then on your agent is **already oriented at the start of every task** and its changes are **certified before they land** — automatically, deterministically, with **no LLM in the hot path**, so the same question returns the same grounded answer and the agent is *told when a fact goes stale* instead of served a confident guess.

## Install once, then forget it

```bash
npm install -g openlore && openlore install
```

That is the only command most people ever run. It **auto-detects your agent** (Claude Code, Cursor, Cline, Continue, Pi, AGENTS.md), wires it, registers the MCP server, and builds the index — no API key, no config, no prompts. After that, **it's on in the background and you don't think about it:**

- 🔄 **Every task starts oriented, automatically** — a compact architecture digest is injected into your agent's context at the start of each session, and your agent calls `orient()` and the other tools itself over MCP. You don't type anything.
- 🌱 **Every repo, not just this one** — `install` wires your user account too, so each new git repo you open indexes itself in the background on first touch. "Install once" is literal.
- 🩹 **Always fresh** — a file watcher re-indexes as you edit and converges to a full analysis; anything it can't recompute in time is marked explicitly stale, never silently wrong.
- 🛡️ **Changes get checked before they land** — the governance tools (and `openlore review` on a PR) run deterministically with no API key.

The CLI below exists for humans and CI — `prove`, `review`, `doctor`, `features`. The everyday path is: install, then let your agent use it.

> **Zero config.** Run **`openlore features`** to see every opt-in capability (embeddings, the commit gate, the spec store…), whether it's on, and the one command to enable it. `openlore doctor` verifies the wiring.

---

## What you get

Two things, both deterministic and local:

**🧠 Memory — your agent starts every task already oriented**

- **Orient in one call** — `orient(task)` returns the relevant functions, callers, specs, tests, and insertion points (**~430µs p50** on a 15k-node graph) instead of a dozen exploratory file reads.
- **Survives refactors** — anchored notes and decisions carry forward when a symbol is renamed or moved, instead of orphaning.
- **One graph for everything** — application code, Infrastructure-as-Code, and architectural decisions share one graph, so a single query spans all three.
- **Told when a fact is stale** — every response carries a brief, **factual freshness note** (the Epistemic Lease) once a cached fact has aged or the repo moved, so a long session can't drift onto a confident guess.

**🛡️ Governance — guardrails on what the agent changes**

- **Breaking-change verdict** — `certify_public_surface` classifies every changed export `breaking / non-breaking / potentially-breaking` and **names the consumers each break hits**. Never silently "safe."
- **Sensitive-boundary check** — `change_impact_certificate` flags when a diff **opens a new path into a boundary you declared** (reachable after the change, not before).
- **Grounded claims** — `verify_claim` returns `confirmed / refuted / unverifiable` with a citation, before an agent asserts "X is dead" or "Y is safe to change."
- **One commit gate** — `openlore enforce` blocks on findings you mark `blocking`. Advisory by default, no API key.

**The one line to remember:** an agent's expensive failure mode isn't ignorance — it's *confidence*. A model that doesn't know a function exists will go look. A model that "knows" a stale fact builds on it, and you pay at review time. OpenLore is built so the agent can be told *"that fact is stale"* and *"this change opens a path you said was sensitive"* — deterministically, with no second model guessing about the first.

---

## Value Scorecard — does it pay for itself?

OpenLore only earns its place if an agent **with** it reaches a correct answer for less total cost than the same agent **without** it. We measure that and publish it — wins **and** losses. Numbers from the Spec 14 benchmark (`claude -p`, sonnet, N=4 medians, pinned SHAs), measured **2026-06-01**.

| Scenario | Cost Δ | Round-trips Δ | Verdict |
|---|---|---|---|
| **Large/unfamiliar repo · deep "how does X flow through Y"** *(its target)* | **−7% to −21%** | **−26%** | ✅ helps — and the win grows with repo size |
| Small/familiar repo · shallow "who calls X" | task-dependent *(Round 1: +43%)* | +38% | ❌ often **adds overhead** — measure first |

The win scales with codebase size (round-trips without → with):

| Repo (size) | Cost Δ | Round-trips |
|---|---|---|
| excalidraw (~640 files) | **−21%** | 25 → 16 |
| tokio (~790 files) | **−21%** | 17 → 13 |
| okhttp | **−13%** | 13 → 11 |
| django (~3k files) | **−7%** | 21 → 15 |
| gin (110 files, smallest) | +4% *(≈even)* | 10 → 9 |

> **Re-confirmed live 2026-06-03:** the deep-task win reproduces (okhttp **−13%**); the small/familiar case is task-dependent, not a flat loss (chalk **−32%** win vs. express **+59%** loss). Don't guess from our repos — run **`openlore prove --estimate`** on yours (seconds, no API key).

> **Honesty contract.** We never publish a savings number the benchmark didn't produce, we always show the losses next to the wins, and every claim traces to a command you can run. Methodology: [docs/AGENT-BENCHMARKS.md](docs/AGENT-BENCHMARKS.md).

---

## Is OpenLore for you?

| | |
|---|---|
| ✅ **Strong fit** | A codebase too big to hold in your head — and the model's. Private or niche code the model never memorized. Long sessions where stale assumptions compound. Polyglot repos, or code plus the IaC that deploys it. |
| 🤔 **Try it, measure** | Mid-size repos and mixed workloads. Run **`openlore prove --estimate`** (seconds, no key) before you commit. |
| ❌ **Probably not** | A small repo the model already knows, answering shallow questions — your agent's built-in search is cheaper, and we [publish the measurement that says so](#value-scorecard--does-it-pay-for-itself). Also: OpenLore locates and certifies, it never edits your code. |

---

## What your agent reaches for (you rarely type these)

Once wired, your agent calls these over MCP on its own. The default surface is the **`substrate`** preset — **15 tools**: the navigation core, the highest-value governance reads (`recall`, `verify_claim`, `blast_radius`), and the spec composites. The lean **`navigation`** preset (10 tools) and the full **80 tools** (`--preset full`) are one flag away.

| When the agent needs to… | Tool |
|-----------|------|
| Start any task | `orient(task)` — functions, callers, specs, insertion points in one call |
| Find which file/function handles X | `search_code` |
| Know the blast radius of a change | `analyze_impact` — risk + up/downstream chain + governing decisions |
| Trace how request X reaches function Y | `trace_execution_path` |
| Pick the tests a change should run | `select_tests` — backward reachability to the reaching tests |
| Find dead code / what dies if X is deleted | `find_dead_code` — cross-language reachability |
| Check a whole diff before commit | `blast_radius` — callers, tests, specs that drift |
| Tell if a diff opens a sensitive boundary | `change_impact_certificate` |
| Tell if a change breaks a consumer's API | `certify_public_surface` — verdict, consumers named |
| Verify a fact before asserting it | `verify_claim` — deterministic verdict + citation |
| Record an architectural choice | `record_decision` **before** writing the code |

Full reference — all 80 tools: [docs/mcp-tools.md](docs/mcp-tools.md). Ships as a Claude Code [Skill](https://docs.claude.com/en/docs/claude-code/skills) at [`skills/openlore-orient/`](skills/openlore-orient/).

---

## OpenLore vs. alternatives

Everyone in this category answers the same first question: **how does the agent see the codebase without reading it file by file?** LSP toolkits answer with symbols, graph MCP servers with a parsed graph, search platforms with an index. OpenLore answers it too — then keeps going into the **second question almost nobody answers: what happens when the agent starts writing?** A retrieval layer makes an agent *informed*; it doesn't make it *safe*. That second half — **governance on the same graph, no LLM in the loop** — is what OpenLore is for.

| | Agent built-ins | LSP toolkits | Graph MCP | Search platforms | **OpenLore** |
|---|---|---|---|---|---|
| Structural context instead of file reads | ❌ grep | ✓ symbols | ✓ graph | ✓ index | ✓ call graph + **IaC + decisions on one graph** |
| Local, no API key, deterministic | Partial | ✓ | ✓ | ❌ hosted | ✓ no LLM in the hot path |
| Cross-session memory anchored to code | ❌ | Partial | ✓ notes | ❌ | ✓ **carried across renames** |
| Told when a cached fact goes **stale** | ❌ | ❌ | ❌ | ❌ | ✓ Epistemic Lease |
| Breaking-change **verdict** over a diff | ❌ | ❌ | Partial | ❌ | ✓ per export, **consumers named** |
| "Did this diff open a sensitive path?" | ❌ | ❌ | ❌ | ❌ | ✓ differential, pre-commit |
| Cost effect **published with the losses** | ❌ | ❌ | ❌ | ❌ | ✓ −26% round-trips on deep tasks |

**Use the other tool when it's the right one:** symbol-level *edits* (rename across files) are an LSP toolkit's home turf — OpenLore is deliberately read-only, and the two compose. Org-wide search across hundreds of repos is a search platform. Just-fast-graph-retrieval is a smaller graph MCP server. And a small, familiar repo with shallow questions is cheaper with your agent's built-in search. OpenLore also [exports SCIP](docs/scip-export.md), so it sits alongside these tools, not against them.

*Comparisons reflect each project's publicly documented capabilities as of July 2026; a correction PR is always welcome.*

---

## What it costs

Measured on a fresh clone of [ripgrep](https://github.com/BurntSushi/ripgrep) with published `openlore@2.1.6`:

| What it costs | On ripgrep (232 files) |
|---|---|
| **One-time index build** | **13.6 s**, entirely local — no API key, no network |
| **Disk** | **27 MB** under `.openlore/` (gitignorable; rebuildable from source) |
| **Per-query latency** | **~430 µs p50** in-process via the MCP server |
| **Your source code** | never leaves the machine — no account, no telemetry (opt-in only) |
| **Lock-in** | none — delete `.openlore/` and nothing about your repo has changed |

Large monorepos take minutes rather than seconds, stated plainly in [Known limitations](#known-limitations). Platform: Linux and Windows are exercised in CI; macOS is supported.

> **Fully local — nothing phones home.** No account, no network call; your source, the index, and every query stay on your machine. The only diagnostics that exist are **opt-in and local-only**, off by default and never transmitted: `OPENLORE_TELEMETRY=1` records tool calls, agent identity, latency, error messages, decision titles, and lease events to the gitignored `.openlore/telemetry/` directory, and `OPENLORE_LLM_LOGS=1` stores prompts and responses (after secret redaction) in the gitignored `.openlore/logs/` directory. → [docs/configuration.md](docs/configuration.md)

---

## Languages & Infrastructure-as-Code

**Languages**: TypeScript · JavaScript · Python · Go · Rust · Ruby · Java · C++ · Swift · C# · Kotlin · PHP · C · Scala · Dart · Lua · Elixir · Bash — call graphs ride the same primitives for every language. → [docs/language-support.md](docs/language-support.md)

**Infrastructure-as-Code**: Terraform/HCL · Kubernetes · Helm · CloudFormation · Ansible · Pulumi · AWS CDK · CDKTF · Dockerfile · Docker Compose · GitHub Actions · Azure Bicep — IaC resources project onto the **same graph** as application code, so `orient`, `search_code`, and `analyze_impact` answer "what's the blast radius of changing this security group / IAM role / base image / CI job?" with zero new tooling. → [docs/iac.md](docs/iac.md)

---

## Known limitations

We'd rather you know these up front.

- **Static analysis only.** Polymorphic dispatch, event channels, and route→handler bindings *are* recovered (provenance-labeled `synthesized`). What isn't: reflective invocation with a non-literal target (`getattr(o, name)()`), `eval`, and DI/plugin registries with no visible binding — silently absent from the graph.
- **LLM spec quality varies.** Generated spec *prose* reflects the model's understanding — review complex business logic. Structure, format, coverage, and drift are checked deterministically.
- **Keyword (BM25) search is the default; semantic is an opt-in upgrade.** `orient`/`search_code` work immediately with no key. Add hybrid dense+BM25 with `openlore embed --local` (bundled, CPU-only, ~23 MB).
- **Large monorepos** analyze one package at a time after the first full build (`openlore analyze --shard <name>`); the initial index is still a full analysis.
- **Incremental updates converge or flag, never silently diverge.** When a change exceeds the per-save budget, the rest is marked explicitly stale and self-heals on later edits or a background re-analyze.

---

## Documentation

**Start here:** the [documentation index](docs/README.md) maps every task to the one canonical page that answers it. The essentials:

| I want to… | Doc |
|------------|-----|
| **Install & wire my agent** (one command) | [install.md](docs/install.md) |
| Understand *why* wiring an agent helps | [agent-setup.md](docs/agent-setup.md) |
| See all **80 MCP tools** + parameters | [mcp-tools.md](docs/mcp-tools.md) |
| Run the full **CLI reference** | [cli-reference.md](docs/cli-reference.md) |
| Configure `.openlore/config.json` (incl. `enforcement.policy`) | [configuration.md](docs/configuration.md) |
| Choose / configure an LLM provider (optional) | [providers.md](docs/providers.md) |
| Fix a setup problem | [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Read the **benchmark methodology** + per-task numbers | [AGENT-BENCHMARKS.md](docs/AGENT-BENCHMARKS.md) |
| Search code by meaning (semantic / GraphRAG) | [semantic-search.md](docs/semantic-search.md) |
| Pick the tests a change should run | [test-impact-selection.md](docs/test-impact-selection.md) |
| Find dead code / coverage gaps | [reachability-dead-code.md](docs/reachability-dead-code.md) · [coverage-gaps.md](docs/coverage-gaps.md) |
| Detect spec ↔ code drift | [drift-detection.md](docs/drift-detection.md) |
| Enforce architecture / import rules | [architecture-invariants.md](docs/architecture-invariants.md) |
| Gate commits / wire CI & PR review | [ci-cd.md](docs/ci-cd.md) · [preflight.md](docs/preflight.md) |
| Understand IaC & cross-domain impact | [iac.md](docs/iac.md) · [cross-domain-impact.md](docs/cross-domain-impact.md) |
| Query across repos (federation) | [federation.md](docs/federation.md) |
| Share the index as a bundle | [shareable-bundle.md](docs/shareable-bundle.md) |
| Export to Sourcegraph / SCIP tools | [scip-export.md](docs/scip-export.md) |
| Read the internals | [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [ALGORITHMS.md](docs/ALGORITHMS.md) · [PHILOSOPHY.md](docs/PHILOSOPHY.md) |

---

## Development

```bash
npm install
npm run build
npm run test:run  # 5500+ unit tests, one-shot (npm test is watch mode)
npm run typecheck
```

New contributor? See **[CONTRIBUTING.md](CONTRIBUTING.md)** for setup, MCP wiring, and the commit gate. Please also read our [Code of Conduct](CODE_OF_CONDUCT.md); to report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Community

If OpenLore saves your agents from re-reading the same files — or catches one risky change before it lands — **star the repo**. It's the signal that tells us to keep building, and it helps other engineers find it.

- ⭐ **Star** to follow along: [github.com/clay-good/OpenLore](https://github.com/clay-good/OpenLore)
- 🐛 **Bug or idea?** Open an [issue](https://github.com/clay-good/OpenLore/issues).
- 🤝 **Contribute?** Start with [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Links

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) — spec-driven development framework
- [AGENTS.md](AGENTS.md) — system prompt for direct LLM prompting
- [Examples](examples/) — BMAD, Vibe, GSD, drift-demo, spec-kit integrations
