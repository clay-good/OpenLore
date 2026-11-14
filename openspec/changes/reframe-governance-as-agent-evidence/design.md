# Design decisions

## 1. The plugin set is a new preset entry named `plugin`

**Decision.** Add `plugin` to `TOOL_PRESETS` (`src/cli/commands/mcp.ts:2620`). The plugin starts
`openlore mcp --preset plugin`. `LEAN_DEFAULT_PRESET` (`src/constants.ts:295`) stays `substrate`.

**Why.** `verify_change` is in the `verify` preset only, not in `substrate`. The CLI takes one
`--preset` value (`resolvePresetName`, `mcp.ts:2738`), so two presets cannot be joined. A named
entry gets every guard for free: dispatch enforcement, the standing-context budget, the docs table,
`install --preset` validation (`src/cli/install/index.ts:430`).

| Rejected | Reason |
|---|---|
| Reuse `substrate` | No `verify_change`; 15 tools; 2 OpenSpec-only tools |
| Add `verify_change` to `substrate` | Changes the npm default; needs the benchmark protocol (`DefaultSurfaceDecisionsRideTheBenchmarkProtocol`) |
| Shrink `substrate` to this set | Removes 5 tools from current users |
| A tool list inside `plugin/.mcp.json` | No such flag exists; the set would live outside `src/` and outside the guards |

## 2. The 11 tools

"Skills" = how many of the 11 folder skills name the tool (measured with `grep -rlw`).

| Tool | Family | In `substrate` | Skills | Why it stays |
|---|---|---|---|---|
| `orient` | navigate | yes | 11 | Entry point for every task |
| `search_code` | navigate | yes | 2 | Finds a concept when `orient` misses |
| `get_subgraph` | navigate | yes | 6 | Callers and callees before a change |
| `analyze_impact` | navigate | yes | 6 | Who breaks if this symbol changes |
| `suggest_insertion_points` | navigate | yes | 7 | Where to add new code |
| `get_function_skeleton` | navigate | yes | 3 | Compact read of a function |
| `find_path` | navigate | yes | 0 | The one route tool; accepts names, roles and landmarks |
| `recall` | remember | yes | 0 | What is known about the code in hand |
| `verify_claim` | verify | yes | 0 | Settle a claim before it reaches a human |
| `blast_radius` | change | yes | 0 | Weigh the pending diff |
| `verify_change` | change | no (`verify`) | 0 | One receipt after a change; the pull form of before-stop |

Left out of the plugin set, still in `substrate` and `full`:

| Tool | Reason |
|---|---|
| `trace_execution_path` | Near-sibling of `find_path`; 1 skill names it |
| `get_landmarks`, `get_map` | Orientation views; `orient` and `find_path` selectors cover the common case; 0 skills |
| `prepare_spec_generation`, `prepare_spec_repair` | OpenSpec-only; no feature in the fixed set may need a spec framework |

## 3. Certificates run inside the before-stop moment, in process

**Decision.** `beforeStop` (`src/cli/commands/hook.ts:494`) calls the handlers directly, next to
`handleVerifyChange`. Tool output shapes do not change. Preset membership does not apply to hooks.

| Source (tool name kept) | Handler | Moment | Trigger | Emits | Limit |
|---|---|---|---|---|---|
| `certify_public_surface` | `handleCertifyPublicSurface` (`public-surface.ts:1211`) | before-stop | session diff touches a `.ts/.tsx/.js/.jsx/.py` file | `breaking` findings only, with consumers | 10 s, 3 items |
| `certify_service_contract` | `handleCertifyServiceContract` (`service-contract.ts:700`) | before-stop | session diff touches a file the contract reader accepts (OpenAPI, protobuf, GraphQL) | `breaking` and `dangerous` changes joined to call sites | 10 s, 3 items |
| `change_impact_certificate` | `handleChangeImpactCertificate` (`impact-certificate.ts:1031`) | before-stop | `impactCertificate.surfaces` is declared in `.openlore/config.json` | paths newly opened into a declared surface | 10 s, 3 items, `persist: false` |
| `certify_provenance` | — | none | — | — | pull only |
| `certify_merge` | — | none | — | — | pull only |

Rules: base ref = the session start commit (`startHead`, already kept by the dedupe record). The
three slices start with `handleVerifyChange` and run in parallel. A slice that errors or passes its
limit adds nothing. The total stays inside `TIMEOUT_MS['before-stop']` (50 s today; hook-reliability may lower it to 20 s, so each slice stays at 10 s) and
`BUDGET_CHARS['before-stop']` (8,000). `hooks.before-stop: false` turns all of it off.

**Why not before-edit or after-edit.** Their limits are 8 s / 1,600 chars and 15 s / 4,800 chars.
A certificate needs the whole diff, and a mid-task break is often repaired by the next edit.

**Rejected.** Adding the three to `verify_change` output: it changes a tool's shape for Pi and MCP
and slows every pull call. Calling the CLI as a child process: a second cold start per stop.

## 4. Proof and action are fields on the hook item

**Decision.** `HookItem` (`hook.ts:62`) gains `action: 'fix' | 'decide' | 'raise'`. The `proof`
field (file and line, edge, or receipt id), with `code` and `subject`, comes from hook-reliability
task 4.2. The receipt prints them as labeled data, as `next` is today. An item from before-edit,
after-tools or before-stop with no proof is dropped, not printed; `after-compact` and
`subagent-start` items are briefings and are exempt.

| Action | When | Example |
|---|---|---|
| `fix` | the repair is in the agent's own diff | phantom reference, test edited after last run |
| `decide` | a trade-off the agent may take | accepted public-API break: record with `openlore decisions record`, cite the finding |
| `raise` | only a human can accept it | new path into a declared sensitive surface |

**Rejected.** A new ledger of "findings acted on". It is a separate change; this one only labels.

## 5. Source defaults never block

**Decision.** The 7 codes at `enforcement-policy.ts:483-518` get `defaultClass: 'advisory'`. Add a
test that no registry entry has a `blocking` or `frozen` default. `applyPolicyPrecedence` keeps its
`sourceDefault` parameter (the config spec still defines that precedence).

Migration line for a repository that wants the old behavior:

```json
{ "enforcement": { "policy": {
  "corpus-reference-unresolved": "blocking", "corpus-reference-ambiguous": "blocking",
  "corpus-self-reference": "blocking", "corpus-duplicate-identifier": "blocking",
  "corpus-edge-unsupported": "blocking", "corpus-target-type-mismatch": "blocking",
  "corpus-supersession-cycle": "blocking" } } }
```

Unchanged: severity stays `error`; `openlore doctor` still reports `fail`; a supersession cycle
still makes no decision in the cycle authoritative.

**Rejected.** Removing `enforcement.policy`: breaks operators who set one. A config switch that
restores the old default: one more setting for a 7-line policy.
