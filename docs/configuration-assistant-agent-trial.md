# Configuration assistant: live agent usability trial

On 2026-11-13, two independent agent participants completed a real configuration journey through
the compiled OpenLore MCP server. The first exposed a usability defect: an opaque `candidate`
schema caused five rejected preview attempts. After publishing its structure on MCP and Pi and
adding a skill example, a fresh participant produced a valid preview on its first attempt.
Both stopped before writing, applied only after test-host approval of the exact plan, and reported
verification as partial because the fixture had no running watcher or index.

## What actually ran

Linux, Node v24.22.1, base implementation `350aab4d93ff29a355f53ac785ae84f8d7f4a3b3`.
The second run includes the uncommitted schema/skill changes shipped with this report; the result
records the CLI SHA-256 at assessment time (not a retroactive execution hash for the first run).
The corrected tools/list response is archived too; future broker invocations also record an execution hash. Participants were started without conversation history or model
overrides. Their model identifier was not independently recorded. They could read the disposable
user repository and its installed skill, but were instructed not to inspect product code, the
harness or expected assertions. The controller did not provide a tool-call sequence or candidate.

The host's collaboration agent interface does not accept a newly registered local MCP server.
Participants therefore used a thin JSON/stdin bridge: SDK client → host approval broker → SDK
client → **real compiled `openlore mcp --preset configuration --no-watch-auto`**. Tools/list and
all configuration results came from that server; no tool response or agent answer was mocked.
The broker allowed writes only for the exact host-approved plan ID and fixture root. Its startup
grant, audit, private runtime state and approvals lived outside the user repository.

This is a real agent/MCP usability journey, not a native Pi UI test. The bridge participant's shell
was governed by trial instructions, not an OS-enforced read-only boundary. Consequently this trial
does not prove resistance to an adversarial agent modifying host artifacts. The native Codex runner
uses a read-only shell, but the attempted native run stopped on authentication (`401`, invalid/stale
token) before any OpenLore tool call. A local “logged in” status was insufficient. That attempt is
**blocked, not a usability pass**. No credentials or private reasoning are included in the evidence.

## Scenario and observed behavior

The French user request described extension-only use, slow rebuilds, a versioned generated client
that must stay analyzed, deliberate exclusions and disabled embeddings. It asked for a diff before
any change. The fixture had TypeScript's declared `build-cache/` output, 80 ignored output
subdirectories, `src/app.ts` calling `src/generated/inventory-client.ts`, an existing `vendor/**`
exclusion, `embedding: null`, and an unknown local preference to preserve.

| Observation | Initial participant | Fresh participant after correction |
| --- | --- | --- |
| Proposal tool calls | inspect, six previews | inspect, one preview |
| Rejected previews | 5 | 0 |
| Application after host approval | apply, verify | apply, verify |
| Writes before approval | none | none |
| Existing choices and source files | preserved | preserved |

The first participant explicitly identified the friction: “le schéma publié ne détaille pas
`candidate` ; plusieurs formats ont été refusés”. It guessed inspection/config wrappers before
finding the supported shape. The correction exposes `rules`, rule lanes, optional `analysis` and
`reviewMode`, explains that `rules` is the complete desired list, and requires passing the unchanged
preview result as `plan`. The shared schema is used by both MCP and Pi; the opt-in MCP schema cost
increased from 186 to 545 estimated tokens, with a 585-token budget. The default tool surface is
unchanged. Pi's schema is compiled and covered by adapter checks; no native Pi agent session ran.

The fresh participant independently read representative output files and the generated client's
caller, kept index selection unchanged, and proposed excluding only output watch/embed lanes. Its
proposal cautioned: “Publier cette configuration ne prouverait donc pas son activation ni son effet
sur les performances.” It did not ask for a global CLI or promise a measured speedup.

The test host checks the proposal against filesystem state before granting its exact ID. After
application it checks the on-disk selection, retained exclusions/embedding opt-out/unknown settings,
unchanged tracked fixture files, actual apply/verify receipts, and absence of index bootstrap.
A fully `verified` receipt without runtime/index observations fails the oracle. This tests configuration
publication and truthful pending verification; watcher activation and performance require separate
runtime trials (the existing real-watcher integration test measures subscriptions).

## Evidence and limits

[Recorded tool audits and result summaries](../bench/results/configuration-agent-2026-11-13/)
include the failed native attempt status and both real MCP journeys. Only the disposable fixture's
absolute directory arguments are replaced with `<fixture>` in published audits. Plan IDs, error
messages, candidates, patches and receipts are retained. These are actual observed transcripts,
not golden expected responses. Local raw artifacts remain outside the repository.

This is qualitative evidence from two participants on one scenario, with scripted test-host approval.
It does not establish a success rate, user satisfaction score, notification precision, cross-platform
qualification, live repository evolution behavior, or native Pi/Codex host usability.

## Reproduce (opt-in; never part of default CI)

Build first (`npm ci && npm run build`). The optional MCP SDK must be installed. With working Codex
authentication, run:

```sh
npm run test:configuration-agent -- --live --out /tmp/openlore-agent-trial-new
```

This makes real model calls using existing authentication and may incur usage cost. It requires a
new output directory, records user-visible events rather than private reasoning, runs a proposal
session without a write grant, checks its proposal, then supplies exact-plan test-host approval for
a second session. Startup/model failures produce an incomplete result, never a pass.

For another independent host agent, prepare without model calls:

```sh
npm run test:configuration-agent -- --prepare --out /tmp/openlore-agent-trial-new
```

Give a fresh participant only `prompt.txt`, read access to `repository/`, its installed skill, and
the bridge invocation below. Do not reveal assertions, source code, previous transcripts or the
candidate. The participant discovers tools with `--list`; otherwise it sends its chosen JSON tool
arguments on stdin. Its working directory is the OpenLore checkout. In this managed environment,
MCP subprocess execution required an elevated execution sandbox; that is separate from write approval.

```sh
npm run --silent test:configuration-agent -- --call --list \
  --root /tmp/openlore-agent-trial-new/repository \
  --audit /tmp/openlore-agent-trial-new/propose.mcp.jsonl \
  --approval /tmp/openlore-agent-trial-new/propose.approval.json
```

Once the participant presents its proposal and stops, the **test controller**, not the participant,
runs `--approve --out DIR`. This checks the oracle and creates `approved-plan.json` plus
`apply.approval.json`. Tell the participant that this exact plan is approved, permit it to read the
saved plan, and switch its bridge paths to `apply.mcp.jsonl` / `apply.approval.json`. Ask it naturally
to apply and verify, without prescribing its calls. After it finishes, run `--assess --out DIR`.
Review the participant's explanations as well as the machine oracle; a passing state alone does
not establish usable interaction. The bridge's approvals are a test-host mechanism, not a new
production approval UI. Retain unsuccessful journeys when correcting and retrying on fresh fixtures.

## Validation of the trial change

The production build, strict standalone harness typecheck (including the repository's parser
ambient declarations), targeted lint and strict OpenSpec validation passed. The configuration
adapter, MCP preset/budget and preset measurement checks passed: 62 tests across three files.
The Pi adapter check now validates the published schema against the malformed candidate wrappers
observed in the initial journey. These checks supplement the two live journeys; they do not change
the outstanding platform and notification-calibration qualification gates.
