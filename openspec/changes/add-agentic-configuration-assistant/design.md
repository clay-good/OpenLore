# Design

## Context and inspected foundations

This design is based on source inspection at upstream `c45c2ca`. The fresh checkout had no analysis
index or installed OpenLore executable, so no graph-derived call relationships are claimed.

| Existing source | Reuse and limit |
| --- | --- |
| `src/utils/config-layers.ts` | Project/user layering, replacement semantics for arrays and null embedding opt-out; merged defaults must never be copied into a project file. |
| `src/core/services/config-manager.ts`, `config-schema.ts` | Effective config, explicit config-path handling, version/type checks, bounded numeric settings. |
| `src/core/analyzer/file-walker.ts` | Existing include/exclude precedence, protected exclusions, restricted includes, path confinement and traversal disclosure. |
| `src/core/analyzer/workspace-shards.ts` | Declarative workspace evidence and bounds; its corpus-dependent discovery is not a zero-cost survey API. |
| `src/core/services/mcp-watcher.ts` | Directory pruning, source counting and embedding degradation; #717 adds Git ignore behavior not yet present in this inspected base. |
| `src/api/health.ts`, `index-state.ts`, `analysis-status.ts` | Readiness, corpus freshness and non-blocking ownership. Index-state comparison hashes the corpus: it is not a per-keystroke probe. |
| `src/cli/commands/serve-descriptor.ts`, `src/api/serve.ts` | Validated discovery, identity proof and supervised ownership; a descriptor PID is never shutdown authority. |
| `src/pi/extension.ts` | Current configure wizard, structured tools and RPC UI bridge; legacy configure invocations must keep working. |
| `src/cli/install/guarded-config-write.ts` and confined atomic writes | Per-target serialization and recovery journal precedent; generalization needs explicit project-config coverage. |
| `src/core/services/repo-config-trust.ts` | Repository evidence cannot select credential destinations or disable TLS verification. |

All APIs, modules, config fields, and commands below are proposed, not currently shipped.

## Goals and responsibility split

The host agent interprets the user's goal, reads the bounded evidence, explains alternatives, and
proposes changes. OpenLore deterministically inspects, resolves policies, validates a plan, checks
authority, publishes config, and verifies the requested effects. Repository text is evidence, not
instructions or proof of permission.

The workflow must operate with no index, no daemon, no generation provider and no global CLI.
Existing host authorization carries forward when it covers the exact operation; the design does
not introduce a confirmation dialog for every read or every already-authorized change.

## 1. Workflow and typed states

```text
inspect -> preview -> authorized apply -> verify -> receipt
               |            |              |
          needs-input    stale/blocked   partial/failed
                                            |
                                    explicit checked revert
```

Inspection is read-only. Preview validates a candidate, but neither approves nor applies it.
Apply and revert are separate mutations. Verification can be observational, or perform additional
work only within the host's existing authorization.

Suggested contracts, shared by adapters:

- `Inspection`: schema version, canonical worktree identity, config-layer revisions, observed
  facts, host capabilities, runtime state, survey budget/coverage, and reassessment fingerprint.
- `Recommendation`: stable id, proposed lane decisions and selector, evidence references,
  reason, uncertainty, representative matches, resource/coverage tradeoffs, and conflicts.
- `ConfigurationPlan`: inspection fingerprint, exact targets and before revisions, canonical
  patch operations, recommendation ids, required permissions, planned runtime effects, and
  verification criteria. A plan id is a digest of the versioned normalized plan.
- `ApplyReceipt`: plan id, changed config revision, per-phase outcomes, pending runtime work,
  before/after evidence, verification status, and rollback reference.
- Outcomes: `needs-input`, `blocked`, `stale-plan`, `applied-pending-verification`, `verified`,
  `partially-verified`, `failed`, and `reverted`. None collapses into a generic success boolean.

A serialized plan is untrusted input. Recompute and validate its digest and all preconditions;
an `approved: true` field or a checked-in receipt cannot authorize a mutation.

## 2. Repository inspection that does not cause the resource problem

Start with bounded metadata and declarative files: root/nested ignore rules, existing configuration,
known manifests, workspace declarations, build-output declarations and a small source sample.
Do not run commands copied from package scripts, import repository modules, traverse dependency
trees to classify them, or fetch a model.

Read candidate directory entries incrementally with budgets and prune known excluded subtrees
before opening child directories. Record explicit excluded parent paths as evidence, not an
invented count of everything below them. Symlinks cannot escape the authorized root; aliases and
linked worktrees use canonical filesystem identity without sharing mutable worktree state.

Proposed initial survey limits, to be implemented as named constants and measured before shipping:

| Budget | Initial value | Exhaustion behavior |
| --- | --- | --- |
| Directory entries examined | 10,000 | Return partial evidence and a scoped continuation. |
| Directory depth | 8 | Disclose unvisited prefixes. |
| Total content read | 1 MiB | Stop content reads, retain already collected facts. |
| One declarative file | 64 KiB | Mark that source partial rather than parse a prefix as complete. |
| Examples per recommendation | 5 | Disclose that examples are sampled. |
| Wall time | 2 seconds | Return promptly with incomplete evidence; this is a target, not a measured guarantee. |

A continuation is bound to the worktree, evidence revision and requested scope. It cannot silently
broaden a host's read permission. Large Git inventories must also stream or stop at a bound; a
truncated `git ls-files` response is not a complete tracked-file census.

Facts include their source path and content digest; a parsed field can include a location.
Examples: a manifest declares a Cargo target override; Git tracks a generated client; a workspace
member names a package root. Naming conventions alone produce hypotheses, not automatic exclusions.
Unsupported manifest dialects and unreadable evidence remain visible.

Report observed file/directory counts, bounded samples, declared outputs, actual subscriptions
when available, and measured durations separately. Candidate-file estimates are not OS watch-handle
counts. Do not claim a measured speedup, exact resource savings, or complete architectural coverage
without the corresponding measurement.

## 3. Three file-selection lanes, with explicit authority

Propose additive `filePolicies.rules` in the existing project config, alongside existing settings:

```json
{
  "filePolicies": {
    "rules": [
      {
        "id": "cargo-cache-watch",
        "pattern": "cargo-cache/",
        "lanes": { "watch": "exclude" },
        "reason": "Build output declared by the workspace configuration",
        "evidenceRefs": ["manifest:workspace-build-output"]
      },
      {
        "id": "generated-client-analysis",
        "pattern": "src/generated/client.ts",
        "lanes": { "index": "include", "watch": "exclude", "embed": "exclude" },
        "reason": "Versioned API client needed for architectural analysis",
        "evidenceRefs": ["git:tracked-client", "manifest:client-generator"]
      }
    ]
  }
}
```

Omitted lanes inherit their existing behavior. Excluding watches for a file does not remove its
structural facts; later reads must disclose staleness when a non-watched file changes. Embedding
selection is a subset of the index corpus, not another route for reading excluded files.

The resolver must preserve current behavior exactly when `filePolicies` is absent. With policies,
resolve each path/lane through these stages:

1. Apply host confinement, protected exclusions, explicit opt-outs and existing trust boundaries.
   No repository rule, assistant inference or user-looking metadata overrides them.
2. Resolve the existing config layers and explicit operator choices, including legacy includes/
   excludes and caller-selected corpus limits. Existing unowned settings are user-maintained.
3. Apply accepted assistant-managed rules only where they do not contradict those choices.
   Conflicts become `needs-input`; even a prior assistant recommendation cannot silently replace
   a newly hand-edited value.
4. Apply the existing ignore/default behavior to undecided paths. Root/nested Git ignore rules
   use the shared dialect and precedence, including directory-only rules and file negations.

Changing an explicit choice requires a new concrete plan whose conflict and effect are shown.
An exception crossing a repository-ignore boundary needs the trusted operator authorization the
current standalone/restricted-include contracts require; writing an `include` into repo config
does not manufacture that authority. If the host cannot express the grant, return `blocked`.

A pruned parent stays closed unless an authorized index-only exception explicitly opens its
lineage under the survey budget. This never opens the same lineage to watching or embedding.
Hard exclusions stay closed in every lane. Reject attempts to embed an index-excluded file.

Store the reason/evidence references beside accepted rules. Ownership bookkeeping is private to
the current authorized application, not trusted merely because a repository says `owner: assistant`.
Tracked rationale can be shared; authorization tokens, credentials and private host paths cannot.

## 4. A concrete plan and conflict-aware publication

Default scope is the project file selected by the effective resolver; an explicit `--config` path
is not silently retargeted to `.openlore/config.json`. User-global writes and host setting edits
are separate, explicitly scoped operations, never side effects of accepting a project plan.

Preview reads raw layer objects and preserves unknown keys. It returns the exact semantic diff,
the target file, fields/rules affected, representative paths, limits and runtime effects. It does
not rewrite `.gitignore`, infer or copy credentials, absorb inherited defaults, or repair malformed
JSON by replacing the whole file with defaults.

Before applying, acquire the existing per-target coordination lock, complete any pending recovery,
then reread raw config and evidence. Compare against the plan's expected revisions under that lock.
A changed config or relevant manifest produces `stale-plan`, not a best-effort overwrite.

Use confined atomic writes and a durable private journal. Initial implementation publishes one
project config file per plan. Any later multi-target support must journal per-target outcomes and
recovery; it cannot claim filesystem-wide atomicity. Build indexes, reload policies or request a
restart only after durable config publication and only within authorized lifecycle scope.

A crash between publication and verification is recoverable from the receipt. Do not repeat
runtime side effects just because a client retries a plan: the request identity and realized
phase must be checked first.

## 5. Functional verification and checked rollback

Reuse readiness, analysis ownership and descriptor validation; never call full corpus hashing in
a keystroke loop. Verification distinguishes desired config from realized behavior:

| Requested effect | Evidence | Honest limitation |
| --- | --- | --- |
| Index selection | Effective policy, an analysis generation built under it, included/excluded sample paths | A valid config alone does not prove a rebuild happened. |
| Watch pruning | Active policy revision and real watcher subscription/pruning diagnostics | Process liveness alone does not prove the watcher is healthy. |
| Embedding selection | Selected corpus and vector-generation/provider state | Keyword-only is valid when chosen; no network probe or model download is implied. |
| Daemon recovery | Validated identity, tool compatibility and authorized restart outcome | A repo-writable PID never proves ownership. |
| Live change delivery | An observed authorized source event reaching the index | No observed event means `pending` or `not-assessed`, not success. |

Default verification is observational. An optional end-to-end canary is a separately declared
effect: create a unique temporary source file in an authorized included path, wait under a bound,
then remove it and verify its index entries are gone. Never overwrite source or run build scripts.
If canary creation is not authorized, the observational result remains useful and explicitly partial.

An externally supervised daemon is recovered through a host callback. The extension's spawn
opt-out applies to both stop and start. For an extension-managed daemon, verify identity and use
the packaged version's graceful lifecycle path; disclose interruption to other clients. If no
restart authority exists, provide a host-level action and retain `pending`, not an impossible
instruction requiring a global executable.

Rollback restores only the assistant's last accepted config patch, under a lock and expected
revision. Preserve disjoint later edits; overlapping edits require a fresh plan. Do not restore a
whole stale file, delete user indexes, resurrect a terminated daemon or claim runtime reversal
because config was restored. Report rollback and re-verification phases separately.

## 6. Lifecycle reassessment without a permanent agent loop

Keep the last accepted rule/evidence associations and a bounded per-worktree baseline. Proposed
`configurationAssistant.reviewMode` is `manual` by default, with optional `notify`.
Both modes support an explicit reassessment; no configuration is applied automatically.

Metadata signals include changed manifests/ignore/config files, a new workspace member/language
observed during an existing scan, and material growth/resource pressure reported by the runtime.
A generic HEAD change is not a reason to crawl the repository or invoke a model.

Coalesce signals and invalidate only recommendations whose evidence or selection scope changed.
A new subproject can justify a bounded survey of that subtree; it does not itself justify notifying
the user. An unrelated code edit does not justify either operation.
Growth thresholds require a recorded baseline, configured limits and a disclosed measurement;
an incomplete survey cannot turn into an exact repository-wide growth claim.

A missed event, host restart or branch switch is handled on the next explicit review or idle
metadata check. Compare relevant evidence hashes before reuse, so notifications are not the only
freshness guarantee. A changed evidence hash invalidates a cached assessment, not a dismissal and
not the user's notification budget.

### Notification gate: prove an actionable difference, otherwise stay silent

False alarms are a product failure: a noisy assistant can make configuration less reliable by
teaching users to ignore it. Keep manual review as the default; notification mode remains opt-in.
Detection and user notification are distinct stages. A manifest edit, new language, new directory,
HEAD change or elapsed time is only a candidate signal.

Before a nudge, a bounded deterministic assessment must establish all of the following:

1. A material discrepancy between the current effective policy and observed repository/runtime
   behavior, attributable to an affected scope. Examples: a declared output subtree is actually
   being watched, or measured resource pressure persists outside known rebuild activity.
2. Existing explicit rules do not already cover the situation, and no active authorized operation
   is already handling it. A deliberately excluded component is not an accidental coverage gap.
3. There is an available, scoped review or remedy the host can offer now, and the evidence can
   explain why it matters. A model's confidence score or a directory name is not sufficient proof.
4. The same unresolved condition has not already been shown, dismissed or snoozed, and the host's
   project-level delivery budget permits a non-interrupting notice.

If evidence is partial, unavailable, unsupported or ambiguous, retain it in the explicit diagnostic
report and stay silent. Do not turn the inability to assess configuration into a configuration
alarm. Independently observed failures such as a real watcher error can use their existing error
reporting path; the assistant must not duplicate or amplify that notification.

For growth/resource signals, require persistence across bounded observations, a meaningful baseline
and hysteresis between entering and clearing a condition. Suppress known transient build/rebuild
activity. Exact thresholds, cooldowns and observation counts need measurement before shipping;
test their boundary behavior rather than inventing a universal confidence percentage.

Identify a notice by canonical worktree, condition kind and materially affected scope/effect, not
commit id or raw evidence digest. Harmless dependency bumps, formatting, repeated branch switches
or edits to the same manifest must not resurface a dismissed condition. A dismissal remains valid
until the user resets it or a materially different actionable condition is proven. Snooze also
requires fresh qualifying evidence when its deadline expires; time alone never emits a reminder.

Batch notices into one passive host-owned status item, delivered when the user is idle or next
opens that project's configuration/status view. No modal, blocked turn, repeated toast or notice
per file/session. Where a host coordinates multiple sessions, it owns project-level deduplication;
where that cannot be guaranteed, avoid autonomous duplicate delivery and keep the report on demand.
Show the observed problem, its practical impact, the evidence and one review action. Report a
coverage opportunity as a suggestion, never as a verified runtime failure.

Before enabling notification mode beyond explicit trials, measure actionable notices, dismissals,
repeated notices and user-rated false alarms on representative repository evolution histories.
Pair positive fixtures with a larger quiet-control corpus. A metadata-only/no-impact control must
emit zero nudges. If the detector cannot meet the agreed precision and burden targets, keep it
manual; lowering the evidence gate to increase adoption is not an acceptable fallback.

Generated baselines and operation receipts are private, bounded runtime state keyed by canonical
worktree identity; they are not trust-bearing files to commit. Acceptance reasons remain in the
shareable project config. Revisions, references and retention limits prevent unbounded growth.

## 7. Adapters and the host-agent entry point

Propose a dependency-light `openlore/configuration` export with
`inspectConfiguration`, `previewConfiguration`, `applyConfiguration`,
`verifyConfiguration`, and `revertConfiguration`. The core is provider-free and independent of
the structural daemon. Optional expensive verification loads analysis services only after the
caller authorizes that work.

- **Pi/RPC:** retain bare `/openlore`, `/openlore configure`, and the existing wizard defaults.
  Add `/openlore configure assist` and structured actions on `openlore_configure`. The native tool
  can invoke package APIs even when the daemon is incompatible. A missing UI does not hang a tool:
  return a plan or structured pending action for the host to render.
- **Host-agent skill:** guide inspect -> explain -> preview -> authorized apply -> verify. Let the
  existing agent reason about ambiguous repository evidence; never treat its rationale as a new fact.
- **MCP:** propose one opt-in `configure_openlore` management tool with discriminated actions
  `inspect|preview|apply|verify|revert`, outside the default presets. Classify it in the existing
  `verify` family because its output assesses configured versus realized behavior; this label is
  not read-only authority. Advertise conservative mutation/destructive annotations for the whole
  tool and enforce host authorization separately for every action. Return conclusion-shaped
  receipts and register incomplete-evidence disclosures. Do not add a seventh capability family.
  Operational inspection bypasses automatic index bootstrap; repairing a missing index must not
  first require building that index.
- **CLI:** optional `openlore configure <action> --json` over the same core, not an implementation
  requirement placed on extension users. Spawn the packaged entry without PATH lookup or a shell.

The core receives trusted host capabilities, allowed roots, lifecycle callbacks and authorization
context separately from repository input. No endpoint, token, TLS opt-out, shell command or
process-control request becomes trusted merely because it was stored in a plan.

A generic MCP host without an approval broker or an explicitly configured scoped grant can still
inspect, preview and verify observationally. Apply, revert and active probes return an
authorization-required action until its host supplies that capability through the trusted adapter.
An argument authored by the model is not that channel. Capability limits must be explained in the
host, not disguised as a request to install a global CLI.

## 8. Compatibility, rollout and review decisions

This PR adds design artifacts only and keeps the issue open. Implementation is staged, but the
full contract below is the target:

1. Provider-free inspection and shared policy preview, including evidence/disclosure fixtures.
2. Typed lane policies, checked publication, receipts, observational verification and rollback.
3. Pi/RPC and opt-in MCP adapters with equivalent authorization and dependency-light recovery.
4. Metadata reassessment and the cross-platform resource/coverage fixtures.

Do not activate new defaults until all phases satisfy the requirements. Old configs preserve
current behavior. Adding policy fields requires a schema version change, typed validation,
compatibility fixtures and explicit unsupported-field behavior on older runtimes. An assistant
must refuse a plan whose selected runtime cannot implement its lane semantics.

Decision points for maintainers: the proposed public names/subpath, the opt-in MCP projection and
family classification, survey/retention limits after measurement, and the exact host callback
for authorized canaries. Changing those choices requires updating the matching contracts and tasks;
the host-independent invariants are not optional.

Primary risks: sampled evidence misread as completeness, an exception widening a protected scope,
config written while another session edits it, a reload restarting someone else's daemon, a
non-watched file being served as fresh, and a notification loop recreating the original resource
pressure. The specs and verification matrix below make those failure modes observable.
