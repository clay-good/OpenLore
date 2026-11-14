# Agent-assisted configuration

OpenLore supplies deterministic repository inspection, concrete plans, checked publication,
observational verification and rollback. The host agent explains the evidence and alternatives;
OpenLore does not start an internal model loop. Inspection works without a config, index,
compatible daemon, generation provider or global CLI installation.

In Pi, use `/openlore configure assist` or call `openlore_configure` with `action: "inspect"`.
The existing wizard remains available when no action is supplied. Structured inspect, preview
and verify work without an interactive terminal. Apply and revert require the host's confirmation
of the exact plan; a no-UI session returns an authorization refusal promptly.

MCP exposes `configure_openlore` through the opt-in `configuration` preset (and `full`). It is
absent from the default `substrate` surface. Startup with `--preset configuration` does not need
an index or auto-watch bootstrap. Generic clients can inspect, preview and verify. A supervising
host may grant project writes with `OPENLORE_CONFIGURATION_WRITE_ROOTS='["/absolute/project"]'`.
MCP responses use relative paths and an opaque root identity; the server rehydrates a preview
only for the same validated project before checking its exact plan identity.
That grant does not authorize replacing existing choices or runtime effects: use a trusted host
broker, Pi confirmation, the CLI's explicit flags or the API for those operations. Repository text
and tool arguments cannot grant themselves authority.

The optional command-line adapter is:

```sh
openlore configure inspect --json
openlore configure preview --candidate-file candidate.json --json > plan.json
openlore configure apply --plan-file plan.json --apply --json
openlore configure verify --plan-file plan.json --json
openlore configure revert --plan-file plan.json --apply --json
```

`--replace-choices` separately authorizes the conflicts displayed in a preview. Explicit
`--config` selects the target; the assistant confines writes to the selected repository.
It does not copy user-wide credentials, provider defaults or unrelated settings into a project.
Unknown fields and inherited opt-outs survive. Invalid or unreadable existing configuration
is disclosed and never silently replaced. Serialized candidates and plans are bounded.

The dependency-light API is `openlore/configuration`:

```ts
import {
  configurationRoot, inspectConfiguration, previewConfiguration, applyConfiguration,
} from 'openlore/configuration';

const root = await configurationRoot(projectPath);
const evidence = await inspectConfiguration({rootPath: root});
const plan = await previewConfiguration({rules: proposedRules}, {rootPath: root});
// Show plan.patches, plan.conflicts, evidence and uncertainties to the user here.
// Construct this capability only AFTER the host authorizes that exact plan.
const receipt = await applyConfiguration(plan, {
  rootPath: root,
  authority: {root, planId: plan.id, permissions: ['write-config']},
});
```

Pass host lifecycle, observation and optional canary callbacks separately from serialized input.
Pi's explicitly requested activation uses its installed package and authenticated daemon recovery,
and respects `pi.spawnDaemon: false` / supervising-host opt-outs. It does not ask extension users
to install a global executable. Activation failure preserves the published config and its receipt.
A canary additionally requires `probe` authority; its host callback owns bounded delivery observation
and cleanup of both its temporary source and derived index entries. Unobserved delivery or cleanup
never becomes verified success.

## Selection and freshness

`filePolicies.rules` contains `{id, pattern, lanes, reason, evidenceRefs?}`. The optional lanes
are `index`, `watch` and `embed`, each `include` or `exclude`. Patterns use ignore-file matching,
are repository-relative and ordered; the last matching lane decision wins. Protected exclusions
and existing legacy admission are evaluated first. A policy cannot reopen an ignored/protected
path; operator `--include` and restricted repository includes retain their existing authority.
Within policy exclusions, an index exception can retain a specific descendant without reopening
its excluded parent for watches. Embedding is always a subset of indexing. Embedding-excluded
functions retain keyword rows, with no vector generated for those rows.

Omitting policies preserves legacy selection and fingerprint inputs. Index policy changes enter
structural fingerprints; watch and embed decisions have separate revisions. A watcher reports the
revision it actually installed. Changing configuration requires host activation/reanalysis before
runtime observations can attest it. Watch exclusions mean some indexed inputs receive no live
updates; use index-state comparison or reanalysis after changing those inputs. Artifact policy stamps attest selection, while a host must separately observe `indexGenerationCurrent`
(for example with index-state comparison) to verify working-tree freshness. A healthy process
alone never proves index freshness or that the desired policy was realized.

Publication and realization are separate. Receipts distinguish blocked/stale plans, publication
pending verification, partial verification, verified effects and rollback. Plans bind config bytes,
user-layer revision, worktree and inspected evidence; a stale plan must be previewed again.
Per-target locks and durable journals protect publication and prevent uncertain lifecycle effects
from being replayed. The private operation store retains at most 16 recent operations within 1 MiB;
older rollback receipts can expire. Rollback applies a checked inverse, preserves disjoint edits,
and refuses overlaps. Reverting an initial file restores absence when untouched; when later user
work needs the bootstrap settings, the result explicitly reports that retained bootstrap as partial.
Runtime and derived-artifact reversal require separate verification.

## Repository evolution and attention

Review defaults to `manual`. Passive notifications require both
`configurationAssistant.reviewMode: "notify"` and trusted host opt-in; Pi uses
`OPENLORE_CONFIGURATION_NOTIFICATIONS=1`. Repo-authored metadata alone does not enable them.
The idle reviewer coalesces metadata checks over five minutes and performs bounded inspection only
when relevant evidence changes. It never runs an agent, analyzes the full source corpus or applies
policy on an edit. Unknown/partial observations remain quiet.

A manifest change is a candidate signal. The Pi output-review gate additionally requires a known
output declaration, an excluded output subtree, at least 50 actually observed directory
subscriptions there, no explicit choice covering it and an available scoped review. Shell-script
output hints stay hypotheses and cannot trigger this gate. Resource signals supplied by other hosts
require a measured baseline, persistence and recovery hysteresis. Notifications are grouped and
passive at idle; private per-worktree state serializes delivery across sessions and retains semantic
condition identities, dismissals and snoozes across harmless metadata or HEAD changes. Expiry alone
never produces a reminder. The host API also exposes manual review and dismissal/snooze operations.
The shared claim is persisted before delivery: a host crash may lose a notice, but does not duplicate it.

## Current measurements

Linux, Node v24.22.1, one generated-tree fixture with 100 output subdirectories and one source
directory: Chokidar reported 104 subscribed directory entries before selection and 3 afterward;
output subscriptions fell from 101 to zero. Startup measured 136 ms and 12 ms in that run. These
are subscription counts and one local timing sample, not OS handle counts or a general speedup.
The real-watcher fixture also grows the excluded tree to 1,000 directories and asserts unchanged
subscriptions and bounded discovery entry counts. It is included in deterministic integration checks.

The opt-in MCP management schema measures 545 tokens under `utf8-bytes-div-4-v1`, with a 585-token
budget. The default surface remains 15 tools / 5,248 tokens. Notification tests include 200 quiet
metadata revisions plus positive, transient, dismissal, snooze and host-delivery controls. This is
controlled precision evidence; it does not establish user-rated false-alarm rates in production.

Cancellation propagates the caller's `AbortSignal.reason` (normally `AbortError`) during reads.
A cancellation after publication leaves a retained pending receipt; it does not erase the user's config.
The inspection's daemon compatibility label covers the validated descriptor/protocol; required tools
and realized policy are separate verification observations.

A [live agent usability trial](configuration-assistant-agent-trial.md) exercises discovery, proposal,
host approval, publication and honest partial verification through the real MCP transport.
