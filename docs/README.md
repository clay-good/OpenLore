# OpenLore documentation — index

> The map from **what you want to do** to the **one canonical page** that answers it. When two pages
> cover the same concept, the one marked **canonical** is the source of truth; the other cross-links to
> it. (Change: `refine-happy-path-and-defaults` / DocumentationSingleSourceOfTruth.)

New here? Start with [install.md](install.md) — one command wires your agent and builds the index.

## Get started

| I want to… | Canonical page |
|------------|----------------|
| Install OpenLore and wire my coding agent (one command) | **[install.md](install.md)** |
| Understand *why* to wire an agent and what it gains | [agent-setup.md](agent-setup.md) (concept; setup steps live in [install.md](install.md)) |
| Turn on an opt-in feature ("where do I turn on X?") | `openlore features` — see [cli-reference.md](cli-reference.md#features-whats-on-and-how-to-turn-on-the-rest) |
| Configure `.openlore/config.json` | **[configuration.md](configuration.md)** |
| Choose / configure an LLM provider (optional) | **[providers.md](providers.md)** |
| Fix a setup problem | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) (and `openlore doctor`) |

## Navigate the code (the read face)

| I want to… | Canonical page |
|------------|----------------|
| Use the MCP tools (orient, search, impact, …) | **[mcp-tools.md](mcp-tools.md)** |
| Search code by meaning (semantic / GraphRAG) | [semantic-search.md](semantic-search.md) |
| Find unreachable / dead code | [reachability-dead-code.md](reachability-dead-code.md) |
| Pick the tests a change should run | [test-impact-selection.md](test-impact-selection.md) |
| Find important code no test reaches | [coverage-gaps.md](coverage-gaps.md) |
| See what changes together / churn | [change-coupling.md](change-coupling.md) |
| Review a diff structurally | [structural-diff.md](structural-diff.md) |
| Trace impact across code ↔ infrastructure | [cross-domain-impact.md](cross-domain-impact.md) |
| Map cross-service API topology | [cross-service-topology.md](cross-service-topology.md) |

## Govern a change (the write / check face)

| I want to… | Canonical page |
|------------|----------------|
| Enforce import-boundary / architecture rules | [architecture-invariants.md](architecture-invariants.md) |
| Detect spec ↔ code drift | [drift-detection.md](drift-detection.md) |
| Drive spec-tagged tests | [spec-tests.md](spec-tests.md) |
| Gate commits / wire CI | [ci-cd.md](ci-cd.md) · [preflight.md](preflight.md) |
| Dogfood the governance gates | [governance-dogfooding.md](governance-dogfooding.md) |

## Languages & infrastructure

| I want to… | Canonical page |
|------------|----------------|
| Know what OpenLore extracts per language (matrix, add-a-language) | **[language-support.md](language-support.md)** |
| Read the per-language narrative / examples | [languages.md](languages.md) (cross-links to the canonical matrix above) |
| Understand Infrastructure-as-Code support | [iac.md](iac.md) |

## Specs & OpenSpec

| I want to… | Canonical page |
|------------|----------------|
| Learn the OpenSpec file format | [OPENSPEC-FORMAT.md](OPENSPEC-FORMAT.md) |
| Integrate OpenSpec into a workflow | [OPENSPEC-INTEGRATION.md](OPENSPEC-INTEGRATION.md) |

## Reference & internals

| Topic | Page |
|-------|------|
| CLI commands (full reference) | [cli-reference.md](cli-reference.md) |
| Programmatic API | [api.md](api.md) |
| Output formats | [output.md](output.md) |
| Pipeline / architecture | [pipeline.md](pipeline.md) · [ARCHITECTURE.md](ARCHITECTURE.md) |
| Core algorithms | [ALGORITHMS.md](ALGORITHMS.md) |
| Design philosophy | [PHILOSOPHY.md](PHILOSOPHY.md) |
| Local provenance (git/PR metadata) | [provenance.md](provenance.md) |
| SCIP export | [scip-export.md](scip-export.md) |
| Shareable graph bundle | [shareable-bundle.md](shareable-bundle.md) |
| Multi-repo federation | [federation.md](federation.md) |
| Interactive graph viewer | [viewer.md](viewer.md) |
| Refactoring workflow | [REFACTORING-WORKFLOW.md](REFACTORING-WORKFLOW.md) |
| Agentic workflows | [agentic-workflows.md](agentic-workflows.md) |

## Project & historical

Maintainer- or history-facing notes, kept for the record (not part of the user happy path):
[publishing.md](publishing.md) · [AGENT-BENCHMARKS.md](AGENT-BENCHMARKS.md) ·
[AGENT-ADOPTION.md](AGENT-ADOPTION.md) · [RIG-IMPROVEMENTS.md](RIG-IMPROVEMENTS.md) ·
[plan-rag-improvements.md](plan-rag-improvements.md) · [RENAME-TO-OPENLORE.md](RENAME-TO-OPENLORE.md)

Generation/Repair architecture history: [resume point and companion documents](specs/generation-repair/openlore-resume-point.md).
