<h1 align="center">OpenLore</h1>

<p align="center">
  <strong>Your coding agent forgets your codebase between tasks. OpenLore remembers it for them.</strong><br>
  Local, deterministic facts about your code, delivered to the agent at the moment it can use them.<br>
  No API key. No LLM in the loop. Your code never leaves your machine.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openlore"><img src="https://img.shields.io/npm/v/openlore?color=2563eb&label=npm&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/clay-good/OpenLore/actions/workflows/ci.yml"><img src="https://github.com/clay-good/OpenLore/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/openlore?color=22c55e" alt="MIT License"></a>
  <img src="https://img.shields.io/node/v/openlore?color=339933&logo=node.js&logoColor=white" alt="Node >=22.22">
  <br>
  <img src="https://img.shields.io/badge/MCP-ready-7c3aed?logo=anthropic&logoColor=white" alt="MCP ready">
  <img src="https://img.shields.io/badge/languages-21%20%2B%2013%20IaC-f97316" alt="21 languages + 13 IaC ecosystems">
  <img src="https://img.shields.io/badge/tests-5500%2B-success" alt="5500+ tests">
  <img src="https://img.shields.io/badge/API_key-not_required-0ea5e9" alt="No API key required">
  <a href="https://github.com/clay-good/OpenLore/stargazers"><img src="https://img.shields.io/github/stars/clay-good/OpenLore?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <strong><a href="#install">Install</a> · <a href="#what-the-agent-gets">What the agent gets</a> · <a href="#value-scorecard">Benchmarks</a> · <a href="#how-it-compares">Comparison</a> · <a href="#documentation">Docs</a></strong>
</p>

---

## The problem

Every time you start a task, your agent rediscovers your codebase. It greps, opens a dozen files,
and builds a picture of how things fit together. Then the session ends and the picture is gone.

The rediscovery costs time and tokens, but that is not the expensive part. The expensive part is
what happens when the agent is confident and wrong. It believes a function has no other callers.
It renames an export that three services import. It weakens a test to get it green. It calls a
helper that does not exist. You find out at review time, or later.

## What OpenLore does

OpenLore builds a map of your repository once: every function, who calls it, which tests reach
it, which specs and decisions govern it, and which infrastructure deploys it. It keeps that map
current as you edit.

Then it stays out of the way. It does not ask you to learn new commands. It hands your agent
short, specific facts at four points in a session:

| When | What the agent sees |
|------|---------------------|
| A session starts | A short primer on the repository. After a context compaction, a handoff of what the session already did. |
| You submit a prompt | The functions, callers, specs, and insertion points that matter for that prompt. |
| The agent edits a file or runs a command | Anything new and real: a call to a symbol that does not exist, a test that just got weaker, an edit to a generated file. |
| The agent is about to stop | One receipt: what changed, which tests reach it, and which specs drifted. |

Every finding comes with proof: a file, a line, a call edge. If there is nothing new to say,
OpenLore says nothing.

The agent can also ask questions directly, over MCP. "Who calls this?" "What breaks if I change
this?" "Is this function really dead?" Each answer is computed from the map, not guessed by a
model, so the same question gets the same answer every time.

## Install

**Claude Code** (recommended). One plugin, no config:

```bash
claude plugin marketplace add clay-good/OpenLore
claude plugin install openlore@openlore
```

The plugin brings the hooks and the MCP server. On first use it installs its runtime in the
background, and the first prompt in each repository starts the index build. The
[plugin README](plugin/README.md) lists exactly what it runs, writes, and fetches.

**Any other agent** (Cursor, Cline, Continue, Codex, Pi, or anything that reads `AGENTS.md`):

```bash
npm install -g openlore && openlore install
```

`openlore install` detects the agents on your machine, wires each one, and builds the index. It
also wires your user account, so each new repository you open indexes itself the first time you
use it there.

**Any MCP client.** OpenLore is a standard stdio MCP server:

```json
{
  "mcpServers": {
    "openlore": { "command": "npx", "args": ["-y", "openlore", "mcp"] }
  }
}
```

**Pi.** Pi loads extensions rather than MCP servers. Use `pi install npm:openlore`, or
`openlore install --agent pi`. See [the Pi guide](docs/install.md#pi-pidev).

Requires Node.js 22.22 or later. Run `openlore doctor` to check the wiring and `openlore features`
to see what is on and how to turn on the rest.

## What the agent gets

### It starts every task oriented

`orient(task)` returns the code a task touches in one call, about 430 microseconds at the median
on a 15k-node graph. The agent gets the relevant functions, their callers and callees, the
tests that reach them, and the best places to add new code. It skips the exploratory file reads.

### It knows when a fact has gone stale

Long sessions drift. A fact that was true an hour ago may not be true now. Each response carries a
short, factual freshness note (the Epistemic Lease) once the agent's cached picture has aged or the
repository has moved. The agent re-checks instead of building on a stale belief.

### Its notes survive refactors

Decisions and notes are anchored to code. When a function is renamed or moved, the note follows
it. When the code it describes changes, the note is marked stale instead of quietly misleading the
next session.

### It checks a change before claiming it is done

- `blast_radius` lists the callers, tests, and specs a diff affects.
- `verify_claim` returns `confirmed`, `refuted`, or `unverifiable` for a statement like "this
  function is unused," with the evidence.
- `certify_public_surface` classifies each changed export as breaking or not and names the
  consumers it breaks.
- `change_impact_certificate` flags a diff that opens a new path into a boundary you marked as
  sensitive.
- `openlore review` posts the same checks on a pull request, with no API key.

All of this is advisory by default. If you want a hard gate, mark the findings you care about as
blocking and run `openlore enforce` before commit.

### Application code, infrastructure, and contracts in one graph

Terraform resources, Kubernetes manifests, CI jobs, and Dockerfiles sit in the same graph as your
functions. So do the operations declared in OpenAPI, protobuf, and GraphQL files, linked to the
handlers that serve them and the code that calls them. One question, such as "what is affected if
I change this IAM role?", reaches across all of it.

## Value Scorecard

OpenLore is only worth it if an agent with it reaches a correct answer for less than the same
agent without it. We measured that and we publish the losses next to the wins. Numbers are from the
Spec 14 benchmark (`claude -p`, sonnet, N=4 medians, pinned SHAs), measured 2026-06-01.

| Scenario | Cost change | Round-trips change | Verdict |
|---|---|---|---|
| Large or unfamiliar repo, deep "how does X flow through Y" | -7% to -21% | -26% | Helps, and the win grows with repo size |
| Small or familiar repo, shallow "who calls X" | Task-dependent (Round 1: +43%) | +38% | Often adds overhead. Measure first. |

Round-trips per task, without OpenLore and then with it:

| Repo (size) | Cost change | Round-trips |
|---|---|---|
| excalidraw (~640 files) | -21% | 25 → 16 |
| tokio (~790 files) | -21% | 17 → 13 |
| okhttp | -13% | 13 → 11 |
| django (~3k files) | -7% | 21 → 15 |
| gin (110 files, the smallest) | +4% (about even) | 10 → 9 |

We re-ran it live on 2026-06-03. The deep-task win held (okhttp -13%). On small repos the result
depends on the task: chalk came out 32% cheaper and express 59% more expensive.

Your repo is not ours. Run `openlore prove --estimate` to get an estimate for your own code in a
few seconds, with no API key. The method is in [docs/AGENT-BENCHMARKS.md](docs/AGENT-BENCHMARKS.md).
Every number here traces to a command you can run.

## Is it for you?

**A strong fit** if your codebase is too big to hold in your head, if it is private or niche code a
model never saw in training, if your sessions run long, or if your repo mixes languages or ships its
own infrastructure.

**Try it and measure** on mid-size repos and mixed work.

**Probably not** for a small repo the model already knows well, with mostly shallow questions.
Your agent's built-in search is cheaper there, and the scorecard above says so.

OpenLore reads and reports. It never edits your code.

## How it compares

Most tools in this space solve the first half: give the agent a way to see the codebase without
reading every file. OpenLore does that too. It also covers the second half, which few tools touch:
checking what the agent changes against the same map.

| | Agent built-ins | LSP toolkits | Graph MCP servers | Hosted search | OpenLore |
|---|---|---|---|---|---|
| Structure instead of file reads | grep | symbols | graph | index | call graph, infrastructure, and decisions in one graph |
| Local, no API key, deterministic | partly | yes | yes | no | yes |
| Memory that survives renames | no | partly | notes | no | yes |
| Says when a cached fact is stale | no | no | no | no | yes |
| Breaking-change verdict on a diff | no | no | partly | no | yes, with consumers named |
| Flags a new path into a sensitive area | no | no | no | no | yes |
| Publishes its losses | no | no | no | no | yes |

Use the other tool when it fits better. An LSP toolkit is the right choice for edits like a
cross-file rename, and it works well next to OpenLore. Hosted search wins for searching hundreds of
repositories at once. OpenLore also [exports SCIP](docs/scip-export.md), so it fits next to the tools
you already use.

*Comparisons reflect each project's public documentation as of July 2026. Corrections are welcome.*

## What it costs

Measured on a fresh clone of [ripgrep](https://github.com/BurntSushi/ripgrep) (232 files):

| | |
|---|---|
| First index build | 13.6 seconds, all local |
| Disk | 27 MB in `.openlore/`, which you can delete and rebuild |
| Query time | about 430 microseconds at the median |
| Network | none. No account, no telemetry. |
| Lock-in | none. Delete `.openlore/` and your repo is as it was. |

Large monorepos take minutes for the first build, not seconds.

Nothing is sent anywhere. There are two diagnostics, both off by default and both stored only on
your machine. `OPENLORE_TELEMETRY=1` records tool calls, agent identity, latency, error messages,
decision titles, and lease events to `.openlore/telemetry/`. `OPENLORE_LLM_LOGS=1` stores the
prompts and responses of the optional spec-generation commands, after secret redaction, in
`.openlore/logs/`. Both folders are gitignored. See [docs/configuration.md](docs/configuration.md).

## The tools

Your agent calls these on its own. You rarely type them. The default set is the `substrate`
preset, 15 tools: the navigation core, the spec preparation tools, and three governance reads
(`recall`, `verify_claim`, `blast_radius`). A leaner `navigation` preset has 10 tools, and
`--preset full` exposes all 84 tools.

| When the agent needs to | Tool |
|---|---|
| Start a task | `orient` |
| Find the code that handles something | `search_code` |
| See what a change to a function affects | `analyze_impact` |
| Trace how a request reaches a function | `trace_execution_path` |
| Check a whole diff before commit | `blast_radius` |
| Confirm a fact before stating it | `verify_claim` |
| Recall what earlier sessions learned | `recall` |
| Pick the tests a change needs (full preset) | `select_tests` |
| Find dead code (full preset) | `find_dead_code` |

The full reference is in [docs/mcp-tools.md](docs/mcp-tools.md).

## Languages

**Code:** TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, Kotlin, PHP, C#, C++, C, Swift,
Scala, Dart, Lua, Elixir, Bash, Vue, Svelte, Astro. See [docs/language-support.md](docs/language-support.md)
for what each one supports.

**Infrastructure:** Terraform, Kubernetes, Helm, CloudFormation, Ansible, Pulumi, AWS CDK, CDKTF,
Dockerfile, Docker Compose, GitHub Actions, Azure Bicep, Serverless Framework. See [docs/iac.md](docs/iac.md).

**Contracts:** OpenAPI 3.x, Swagger 2.0, protobuf, GraphQL. See [docs/contracts.md](docs/contracts.md).

**Spec workflows:** OpenSpec is supported first-class, but none is required. A repo with no specs
still gets the full value from its code, tests, and decisions.

## Known limitations

- **Static analysis only.** OpenLore recovers polymorphic dispatch, event channels, and route
  handlers. It cannot see calls made through `eval`, through reflection with a computed name, or
  through a plugin registry with no visible binding. Where it knows it cannot see, it says so.
- **Generated spec prose is written by an LLM** and should be reviewed. Only the optional
  spec-generation commands use a model. Structure, coverage, and drift checks are deterministic.
- **Keyword search answers first.** Local semantic search can be added in the background with an
  optional package. Turn it off with `"embedding": { "provider": "none" }`.
- **Large monorepos** need one full build first. After that, `openlore analyze --shard <name>`
  rebuilds one package at a time.
- **Incremental updates converge or flag.** When an edit is too large to re-index in time, the
  affected parts are marked stale and catch up on the next edit or background build.

## Documentation

Start with the [documentation index](docs/README.md). The most used pages:

| I want to | Read |
|---|---|
| Install and wire my agent | [install.md](docs/install.md) |
| See every MCP tool | [mcp-tools.md](docs/mcp-tools.md) |
| Use the CLI | [cli-reference.md](docs/cli-reference.md) |
| Configure `.openlore/config.json` | [configuration.md](docs/configuration.md) |
| Fix a setup problem | [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Read the benchmark method | [AGENT-BENCHMARKS.md](docs/AGENT-BENCHMARKS.md) |
| Gate commits or review pull requests | [ci-cd.md](docs/ci-cd.md) |
| Query across repositories | [federation.md](docs/federation.md) |
| Let an agent help configure OpenLore | [configuration-assistant.md](docs/configuration-assistant.md) |
| Understand the internals | [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [PHILOSOPHY.md](docs/PHILOSOPHY.md) |
| See where the project is going | [ROADMAP.md](ROADMAP.md) |

## Development

```bash
npm install
npm run build
npm run test:run  # 5500+ unit tests, one-shot (npm test is watch mode)
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started, the [Code of Conduct](CODE_OF_CONDUCT.md),
and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Community

If OpenLore saves your agent a few wrong turns, a star helps other people find it.

- Star the repo: [github.com/clay-good/OpenLore](https://github.com/clay-good/OpenLore)
- Report a bug or suggest an idea: [issues](https://github.com/clay-good/OpenLore/issues)
- Related: [OpenSpec](https://github.com/Fission-AI/OpenSpec), the spec format OpenLore reads and
  writes, and the [examples](examples/) for BMAD, Spec Kit, and other workflows.

MIT licensed.
