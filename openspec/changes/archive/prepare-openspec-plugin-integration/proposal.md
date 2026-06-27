# Prepare OpenLore to plug into the OpenSpec plugin marketplace

> Status: **Phase 1 IMPLEMENTED** (2026-06-22) — shipped on branch `feat/openspec-plugin-manifest`.
> Decisions `5d1c9fdc`, `7dac9ba2`, `302b8dd1`, `c4b2e66e`, `18d3fe4c`. This is the **OpenLore-side**
> half of the OpenSpec plugin/marketplace effort. The host work — the plugin loader, resolver,
> delegation runtime, lifecycle commands, and the curated registry — is being built separately in the
> OpenSpec repo (`OpenSpec/openspec/changes/add-plugin-marketplace`). This document specs **only** the
> work OpenLore must do to be a clean, plug-and-play first plugin under that contract. See
> "Implementation status" at the foot of this file. User-facing docs: `docs/OPENSPEC-INTEGRATION.md`.
>
> Split, for context: ~80% of the total effort is OpenSpec (it has no plugin system today); ~20% is
> OpenLore (it already coexists — optional `@fission-ai/openspec` peerDep, writes OpenSpec's
> `config.yaml`, emits valid OpenSpec specs, ships a skill — and mainly needs a *manifest* plus a few
> delegation-hardening guarantees).

## Why

OpenSpec is adding a plugin marketplace so optional, heavyweight "engines" can extend it without
bloating the core. OpenLore is the inaugural engine and the reference plugin. The product narrative is
already settled by both sides' analysis: **OpenLore generates the initial specs from existing code;
OpenSpec validates and evolves them.** The cold-start path becomes first-class inside OpenSpec:

```
openspec init
openspec lore generate      # delegates to OpenLore: code archaeology → specs
openspec validate --specs   # core OpenSpec takes over
```

OpenLore is roughly 80% of the way there *informally*. What is missing is the **declarative contract**
that lets OpenSpec discover, surface, gate, and invoke OpenLore without importing its code — and a
small set of guarantees that make subprocess delegation reliable across the Node-version skew and the
non-interactive spawn environment. This change closes exactly that gap and nothing more.

## Scope boundary — what this change is and is NOT

**In scope (OpenLore):**
- Authoring and shipping the OpenSpec **plugin manifest**.
- Making OpenLore's CLI safe and predictable to **delegate to as a child process**.
- Declaring and honoring **config-key ownership** (`openlore:`).
- Handing **skill/workflow distribution** to OpenSpec's pipeline and resolving the resulting overlap
  with OpenLore's own installer.
- A **CI guard** that keeps the manifest valid and coherent with `package.json`.
- Docs, including disambiguating the two "manifest" concepts.

**Out of scope (OpenSpec's 80%, referenced as a fixed contract):**
- The plugin loader, `src/core/plugins/resolver.ts`, the delegation runtime, namespace registration,
  `openspec plugin list/add/remove/search`, the curated `registry.json`, and any host-side config
  schema changes. OpenLore conforms to these; it does not build them.

The host contract OpenLore conforms to (from `add-plugin-marketplace`):
`plugin-manifest/spec.md`, `plugin-runtime/spec.md`, `plugin-contribution/spec.md`,
`plugin-resolution/spec.md`, and `design.md` (Decisions 1–10). The load-bearing decisions for OpenLore
are: **subprocess delegation** (Decision 1), **static template contribution as the one in-process
path** (Decision 2), the **`"openspec"` package.json key as primary manifest form** (Decision 3),
**one reserved namespace per plugin** (Decision 5), **`openspecCompat` gating** (Decision 6), and the
**documented-not-sandboxed trust model** (Decision 8).

## What changes (OpenLore deliverables)

### 1. Ship the OpenSpec plugin manifest

OpenLore SHALL publish a plugin manifest as an `"openspec"` key in its `package.json` (primary form,
zero extra files, scannable from `node_modules`). The proposed manifest:

```jsonc
{
  "openspec": {
    "manifestVersion": 1,
    "id": "openlore",
    "namespace": "lore",
    "displayName": "OpenLore",
    "summary": "Reverse-engineer living OpenSpec specs from existing code, then keep code and specs in sync.",
    "bin": "openlore",
    "openspecCompat": ">=<first-marketplace-release>",   // exact range pinned to the OpenSpec release that ships the loader (Decision below)
    "commands": [
      { "name": "generate", "summary": "Reverse-engineer OpenSpec specs from existing code" },
      { "name": "drift",    "summary": "Detect code/spec drift" },
      { "name": "verify",   "summary": "Verify specs against the codebase" },
      { "name": "analyze",  "summary": "Build the structural analysis graph (no API key)" },
      { "name": "orient",   "summary": "One-shot structural orientation for a task" },
      { "name": "digest",   "summary": "Emit the compact codebase digest" },
      { "name": "decisions","summary": "Manage architectural decision records" }
    ],
    "skills": [
      { "dir": "openlore-orient", "source": "skills/openlore-orient" }
    ],
    "workflows": ["onboard-from-code"],   // Phase 2 — the SHIPPED key omits this until the host accepts plugin-contributed workflows
    "ownsConfigKeys": ["openlore"]
  }
}
```

- `bin: "openlore"` matches the existing `bin` map (`dist/cli/index.js`). OpenSpec resolves and spawns
  the package's executable directly (no shell). The `binArgs` alternative (`["npx","--yes","openlore"]`)
  is the fallback for environments where OpenLore is not a resolvable dependency; see the Decisions.
- `commands[]` is **help/completion only** — it does not route execution (the host passes everything
  after the namespace verbatim to the bin). The curated list deliberately surfaces the spec-relevant,
  externally-useful subcommands and **omits** internal/experimental surfaces (`panic-*`,
  `gryph-watch`, `serve`, `view`, `telemetry`) and the host-owned lifecycle surfaces
  (`install`, `connect`, `setup`) — see §6 and the Decisions.
- Unknown fields are preserved by the host parser (passthrough), so adding fields later is
  non-breaking.

A standalone `openspec.plugin.json` is **not** shipped (the `package.json` key wins when both are
present); it remains a documented option for any future non-npm distribution.

### 2. Disambiguate the plugin manifest from the existing federation manifest

OpenLore already owns `openlore manifest emit|validate`, which writes the **federation** manifest
(`.well-known/openlore.json`, the cross-repo "SBOM-of-cognition", `schemas/openlore-manifest-v1.json`).
The **plugin** manifest is a distinct artifact with a distinct purpose and schema. This change SHALL
keep them separate and clearly named:

- The federation `manifest` command and its schema are untouched.
- Any new affordance that prints/validates the **plugin** manifest SHALL use a distinct name (e.g.
  `openlore plugin-manifest` or `openlore openspec-describe`) so the two never collide in help, docs, or
  a user's mental model. Discovery itself needs **no** command — OpenSpec reads the static
  `package.json` key — so this affordance exists only for CI validation and non-npm distribution.

### 3. Compatibility declaration and Node-version-skew handling

- OpenLore SHALL declare an accurate `openspecCompat` semver range and keep it coherent with the
  `@fission-ai/openspec` peer dependency. Incompatible host versions are the host's gating concern
  (Decision 6), but OpenLore owns declaring the truthful range.
- **The real OpenLore gap:** OpenLore requires Node ≥22.5; OpenSpec requires Node ≥20.19. A user on
  Node 20/21 can run `openspec lore generate`, which spawns `openlore` under a Node the engine does not
  support. `engines` is advisory at install time and does not protect the spawn. OpenLore SHALL
  therefore **fail fast and legibly at runtime** when launched under an unsupported Node: a one-line
  message naming the required and actual versions and how to proceed, written to stderr, with a stable
  non-zero exit code — never a stack trace or a partial run. This keeps the delegated failure legible
  through OpenSpec's exit-code propagation.

### 4. Delegation-readiness of the OpenLore CLI

For `openspec lore <subcommand>` → `openlore <subcommand>` to be reliable, the OpenLore CLI SHALL, for
every delegated (manifest-surfaced) command, guarantee:

- **Deterministic exit codes.** 0 on success, documented non-zero on failure, for every surfaced
  command, so the host can propagate them faithfully.
- **Non-interactive when non-TTY.** When stdin/stdout is not a TTY (the spawn case), no surfaced
  command SHALL block on an interactive prompt. It either runs with safe defaults or fails fast with a
  clear message telling the user to pass the relevant flag. (The decisions gate and any prompt-driven
  flow must honor this.)
- **Clean stream separation.** Machine-readable output (e.g. `--json`) goes to **stdout** only;
  human/log/progress output goes to **stderr**. The host inherits both; a consumer parsing stdout must
  never get log noise mixed in. (`orient --json` already does this; the guarantee is extended to every
  surfaced command that offers a machine mode.)
- **CWD/root resolution from the spawn directory.** Surfaced commands SHALL resolve the OpenSpec
  project (its `openspec/` dir and `config.yaml`) from the working directory the host spawns them in,
  matching how `openspec-compat.ts` locates the config today, so delegation needs no extra path
  plumbing.
- **No host-conflicting side effects.** A delegated command SHALL NOT re-run OpenLore's own
  agent-surface installer or rewrite host-owned files as a side effect (see §6).

### 5. Config-key ownership

- OpenLore SHALL declare `ownsConfigKeys: ["openlore"]` and SHALL confine all of its `config.yaml`
  writes to that single top-level key. It SHALL preserve all other content byte-for-byte (OpenSpec's
  config is `.passthrough()`, which is why the `openlore:` block survives today).
- OpenLore SHALL make its config write **strictly additive to its owned key**: when OpenSpec already
  created `config.yaml` (with its own `version`, `profile`, `delivery`, `workflows`, `featureFlags`,
  etc.), OpenLore SHALL update only `openlore.*` and SHALL NOT introduce or overwrite host-owned keys
  (today `openspec-compat.ts` may set a top-level `version` when creating the file — under the plugin
  model the host owns config creation, so OpenLore's write must not touch it).

### 6. Hand skill/workflow distribution to OpenSpec; resolve the installer overlap

The host's contribution pipeline (Decision 2, `plugin-contribution/spec.md`) lays a plugin's declared
skills into all configured AI tool directories uniformly, tracked by plugin-namespaced name, and cleans
them up on disable. This is a genuine **delete-code win** for OpenLore — today it ships its own
managed-markdown-block installer (`openlore install` / `connect`, the `<!-- ... -->` marker pattern).

This change SHALL:
- Ensure the `openlore-orient` skill (`skills/openlore-orient/`, with `SKILL.md`, wrappers, and the
  example output) is shaped and pathed exactly as the host's pipeline expects to consume via the
  manifest `skills[]` declaration.
- Contribute the cold-start **`onboard-from-code` workflow** (§7) in the host's expected form.
- **Resolve the dual-ownership risk** between OpenLore's installer and OpenSpec-owned distribution:
  when OpenLore is operating as an OpenSpec plugin, OpenSpec is the single owner of multi-tool skill
  delivery, and OpenLore's own installer SHALL NOT double-write the same artifacts. The decision on
  *how* (deprecate `openlore install`, gate it behind a "standalone mode" flag, or make both writers
  idempotent against the shared marker) is recorded below; the requirement is that there is exactly one
  writer per artifact and no conflicting or duplicated blocks.

### 7. Contribute the cold-start workflow

OpenLore SHALL provide an `onboard-from-code` workflow in the form the host's workflow contribution
expects (Decision: workflows are a host-side list today; the host will accept plugin-contributed,
namespaced workflows). The workflow encodes the settled narrative: run `openspec lore generate` to
reverse-engineer specs from existing code, then hand off to core OpenSpec validation/evolution. It
SHALL be attributable to OpenLore and SHALL NOT silently override a core workflow of the same name
(host requirement; OpenLore satisfies it by namespacing/naming).

### 8. Registry-listing readiness

OpenLore SHALL provide the metadata the host's curated `registry.json` needs for the inaugural listing
— accurate `name` (npm), `homepage`/`repository`, `summary`, and the `openspecCompat` range — by
keeping `package.json` fields accurate and supplying a recommended registry entry to the OpenSpec side.
No registry infrastructure is built here; this is data hand-off.

### 9. CI guard: manifest validity and coherence

OpenLore SHALL add a test guard (mirroring the existing federation-manifest `schema-validator` and the
`mcp-tool-count-doc` drift guard) asserting that the shipped plugin manifest:
- validates against the OpenSpec plugin-manifest schema (vendored or referenced),
- has `bin` coherent with `package.json#bin`, `id`/`displayName` coherent with the package,
- declares every `commands[]` entry as a real, surfaced OpenLore subcommand, and
- keeps `openspecCompat` coherent with the `@fission-ai/openspec` peer-dep range.

This prevents the silent drift that the `project_mcp_tool_doc_count_drift` memory records as a known
failure mode.

## What does NOT change

- **No code coupling.** OpenSpec never imports OpenLore for execution; integration is subprocess +
  filesystem. OpenLore ships a manifest and a few guarantees, not a library entry point.
- **North star holds (`c6d1ad07`).** Nothing here adds an LLM to a deterministic path or changes
  OpenLore's substrate posture. `generate`/`verify` keep their existing (opt-in, API-key) behavior.
- **The federation manifest is untouched.** `openlore manifest` (`.well-known/openlore.json`) and its
  schema are unchanged; the plugin manifest is additive and separately named.
- **The MCP server stays separately wired** (see the nuance below). The plugin model does not route or
  spawn the long-lived MCP server per call.
- **Standalone OpenLore keeps working.** Every change is additive; OpenLore used without OpenSpec
  behaves exactly as today.

## The MCP / orient nuance (explicitly considered)

Subprocess delegation fits OpenLore's **batch and one-shot** commands perfectly — `generate`, `drift`,
`verify`, `analyze`, `digest`, `decisions`, and one-shot `orient --json` all spawn, run, and exit, with
filesystem side effects the host already consumes. These are what the manifest surfaces.

OpenLore's **persistent MCP server** (`openlore mcp`, the long-lived process agents talk to
continuously) is a different shape and SHALL NOT be modeled as a per-call delegated subcommand. It is
wired into the agent's MCP configuration independently (today via `.mcp.json`), and stays there. The
plugin manifest surfaces the one-shot `orient` for the `openspec lore orient "task"` ergonomic, but the
continuous orientation runtime is out of the delegation path by design.

A clean future extension (not required for v1, flagged for the host's roadmap): the manifest could
advertise an optional `mcp` capability so that `openspec plugin add openlore` *also* offers to wire the
OpenLore MCP server into the detected agent surfaces — reusing OpenLore's existing surface detection.
That is a contribution/wiring concern for Phase 2, not part of this change's required scope.

## Requirements

### Requirement: OpenLorePublishesAValidPluginManifest

OpenLore SHALL publish an OpenSpec plugin manifest as an `"openspec"` key in its `package.json`,
declaring at minimum `manifestVersion`, `id`, `namespace`, an executable (`bin`), and `openspecCompat`,
plus `displayName`, `summary`, the help-only `commands[]`, contributed `skills[]` and `workflows[]`, and
`ownsConfigKeys`. The manifest SHALL be discoverable without executing OpenLore code, SHALL use the
reserved namespace `lore`, and SHALL validate against the OpenSpec plugin-manifest schema.

#### Scenario: Host discovers OpenLore by manifest alone
- **WHEN** OpenSpec scans a project's `node_modules` and reads `openlore`'s `package.json`
- **THEN** it finds a structurally valid plugin manifest declaring namespace `lore` and bin `openlore`,
  without importing any OpenLore module

#### Scenario: Manifest stays coherent with the package
- **WHEN** the manifest-coherence guard runs in CI
- **THEN** it fails if `bin`, `id`, any surfaced `commands[]` entry, or `openspecCompat` diverges from
  `package.json` / the real CLI surface

### Requirement: PluginManifestDistinctFromFederationManifest

The OpenSpec plugin manifest SHALL be a distinct artifact from OpenLore's federation manifest
(`.well-known/openlore.json`). The federation `manifest` command and schema SHALL be unchanged, and any
affordance that prints or validates the plugin manifest SHALL be named distinctly so the two never
collide.

#### Scenario: The two manifests do not collide
- **WHEN** a user inspects OpenLore's commands and docs
- **THEN** the federation manifest (`openlore manifest …`) and the OpenSpec plugin manifest are clearly
  separate in name and purpose, and neither command emits the other's artifact

### Requirement: DelegatedCommandsAreSubprocessSafe

Every OpenLore subcommand surfaced in the manifest SHALL be safe to run as a delegated child process:
it SHALL return a deterministic exit code, SHALL NOT block on an interactive prompt when stdin/stdout is
not a TTY, SHALL emit machine-readable output (when offered) only on stdout with logs on stderr, and
SHALL resolve the OpenSpec project from its working directory.

#### Scenario: Non-interactive spawn does not hang
- **GIVEN** a surfaced command spawned with no TTY
- **WHEN** it would otherwise prompt the user
- **THEN** it proceeds with a safe default or exits fast with a clear message naming the flag to set,
  and never hangs waiting on stdin

#### Scenario: Exit code propagates cleanly
- **GIVEN** a delegated OpenLore command that fails
- **WHEN** it exits
- **THEN** it returns a documented non-zero code (not a crash/stack trace) that the host can propagate

### Requirement: GracefulNodeVersionGuard

When OpenLore is launched under a Node version below its supported floor (≥22.5), it SHALL fail fast
with a single legible stderr message naming the required and actual versions, and exit with a stable
non-zero code, rather than crashing partway or emitting a stack trace.

#### Scenario: Spawned under an unsupported Node
- **GIVEN** a host on Node 20 that supports OpenSpec but not OpenLore
- **WHEN** `openspec lore generate` spawns OpenLore
- **THEN** OpenLore reports the Node-version requirement clearly and exits non-zero, and the host surfaces
  that as a legible failure

### Requirement: ConfigWritesConfinedToOwnedKey

OpenLore SHALL write only its declared owned key (`openlore`) in `config.yaml`, SHALL preserve all other
content unchanged, and SHALL NOT create or overwrite host-owned keys when OpenSpec already created the
config.

#### Scenario: OpenLore updates only its own block
- **GIVEN** a `config.yaml` created by OpenSpec with host-owned keys
- **WHEN** OpenLore writes its metadata
- **THEN** only the `openlore` block is added or updated and every host-owned key is left byte-identical

### Requirement: SingleOwnerForContributedArtifacts

When OpenLore operates as an OpenSpec plugin, OpenSpec SHALL be the sole writer of OpenLore's contributed
skills/workflows across AI-tool directories, and OpenLore's own installer SHALL NOT double-write those
artifacts. There SHALL be exactly one writer per artifact and no duplicated or conflicting managed
blocks.

#### Scenario: No double-install under the plugin model
- **GIVEN** OpenLore enabled as an OpenSpec plugin
- **WHEN** `openspec init`/`update` installs OpenLore's contributed skill
- **THEN** the OpenLore installer does not also write the same skill, and no duplicate managed block
  appears in any tool directory

## Decisions needed before implementation

Per the project's `record_decision`-before-code rule, these choices SHALL be recorded first. Each maps
to one of the host's open questions but is OpenLore's to answer:

1. **Manifest location.** `"openspec"` key in `package.json` (recommended — zero extra files, scannable)
   vs a standalone `openspec.plugin.json`. *Recommendation: package.json key; reserve the standalone
   file for future non-npm distribution.*
2. **`bin` vs `binArgs`.** Spawn the resolved `openlore` bin (recommended for the installed-dependency
   case) vs `npx --yes openlore` (works without a local install, at a network/version cost).
   *Recommendation: `bin: "openlore"`, document `binArgs` as the not-installed fallback.*
3. **Which subcommands to surface.** The curated set `{generate, drift, verify, analyze, orient, digest,
   decisions}` vs a broader/narrower list. *Recommendation: the curated set; exclude internal/
   experimental and host-owned-lifecycle commands.*
4. **Installer overlap resolution.** Deprecate `openlore install` under the plugin model / gate it behind
   an explicit standalone mode / make both writers idempotent against the shared marker.
   *Recommendation: when run as a plugin, OpenSpec owns delivery; keep `openlore install` for standalone
   use only, and have it detect and defer to OpenSpec-managed artifacts.*
5. **`openspecCompat` range + source of truth.** Pin to the first OpenSpec release that ships the loader,
   and decide whether the peer-dep range or the manifest is canonical (the CI guard enforces they agree).

## Phasing

- **Phase 0 (today, zero host code):** OpenLore already coexists; cross-link docs. Functional now.
- **Phase 1 (this change, MVP):** ship the manifest; add the Node-version guard; guarantee delegation
  safety for the surfaced commands; confine config writes; add the CI coherence guard. OpenLore becomes
  installable and invokable the moment the host loader lands.
- **Phase 2:** hand skill/workflow distribution fully to OpenSpec and retire/gate the OpenLore installer;
  contribute the `onboard-from-code` workflow; optionally advertise the `mcp` wiring capability.
- **Phase 3:** registry listing polish; any compat-range automation; marketplace-panel metadata.

## Tasks

### 1. Manifest
- [x] Record the manifest-location, `bin`-vs-`binArgs`, surfaced-subcommands, and `openspecCompat`
      decisions (`record_decision`). → `5d1c9fdc`, `7dac9ba2`, `18d3fe4c`.
- [x] Add the `"openspec"` manifest block to `package.json` with the fields above.
- [x] Add a distinctly-named affordance (`openlore plugin-manifest emit|validate`) that emits/validates the
      plugin manifest, kept separate from the federation `manifest` command.

### 2. Node-version + delegation hardening
- [x] Add a runtime Node-version guard at CLI entry: below the floor → one-line stderr message + stable
      non-zero exit (78), no stack trace. → `src/cli/node-version-guard.ts`.
- [x] Audit every surfaced subcommand for non-TTY safety (no blocking prompts), deterministic exit codes,
      and stdout/stderr stream separation; fix any that prompt or mix streams. → all prompts already
      TTY-guarded; fixed `verify --json` stdout contamination via the shared `withQuietStdout` util.
- [x] Confirm/standardize OpenSpec-root resolution from the spawn CWD across surfaced commands. → all 7
      resolve from `process.cwd()`.

### 3. Config ownership
- [x] Constrain `openspec-compat.ts` writes to the `openlore` key only; never create/overwrite
      host-owned keys when the config already exists. Surgical YAML-Document write; test asserts
      byte-identical preservation of host keys/comments.

### 4. Contribution + installer overlap
- [x] Shape `skills/openlore-orient/` for the host's contribution pipeline; declare it in the manifest
      (`skills[]`, validated by the coherence guard).
- [ ] **(Phase 2)** Contribute the `onboard-from-code` workflow once the host accepts plugin-contributed
      workflows; record and implement the installer-overlap resolution so there is exactly one writer per
      artifact under the plugin model. Decision direction recorded in `18d3fe4c`.

### 5. Guards + docs
- [x] Add the CI manifest-validity + coherence guard against the vendored OpenSpec plugin-manifest
      schema. → `src/cli/plugin-manifest/manifest.test.ts` + `schemas/openspec-plugin-manifest-v1.json`.
- [x] Document the integration, the two-manifest disambiguation, the Node-version behavior, the surfaced
      command list, the MCP-stays-separately-wired nuance, and the recommended `registry.json` entry. →
      `docs/OPENSPEC-INTEGRATION.md`.

## Out of scope

- Building any part of the OpenSpec plugin loader, resolver, delegation runtime, lifecycle commands, or
  registry (the host's 80%).
- In-process module loading of OpenLore into OpenSpec (the host explicitly defers this; the manifest is
  versioned so it can be added compatibly later).
- Sandboxing plugin execution (the host's documented-not-sandboxed trust model applies).
- Changing OpenLore's `generate`/`verify`/`drift` algorithms, the MCP tool surface, or the federation
  manifest.
- Wiring the long-lived MCP server through delegation (kept separate by design; optional `mcp`-capability
  advertisement is a Phase 2 idea, not a requirement here).

## Implementation status

**Phase 1 shipped (2026-06-22), branch `feat/openspec-plugin-manifest`.** Additive and standalone-safe;
no existing behavior changes for OpenLore used without OpenSpec. Full suite green (4473 passed).

What landed:

| Deliverable | Where |
|-------------|-------|
| Plugin manifest (`"openspec"` key) | `package.json` |
| Vendored plugin-manifest JSON schema | `schemas/openspec-plugin-manifest-v1.json` |
| `openlore plugin-manifest emit\|validate` | `src/cli/plugin-manifest/{index,manifest}.ts` |
| CI coherence guard (bin/id/compat/commands/skills) | `src/cli/plugin-manifest/manifest.test.ts` |
| Node-version guard (stderr + exit 78) | `src/cli/node-version-guard.ts` + `node-version-bootstrap.ts` (+ `.test.ts`), wired first in `src/cli/index.ts` |
| Config-key ownership (byte-exact `openlore`-only splice) | `src/core/generator/openspec-compat.ts` (`spliceTopLevelBlock`, + tests) |
| Stream-separation util (+ unit test); `verify`/`drift`/`decisions --json` | `src/utils/quiet-stdout.ts` (+ `.test.ts`), `src/cli/commands/{orient,verify,drift,decisions}.ts` |
| Spec deltas | `specs/cli/spec.md`, `specs/config/spec.md` |
| Integration docs + recommended registry entry | `docs/OPENSPEC-INTEGRATION.md` |

Dogfooded end-to-end: `plugin-manifest emit --json` (pure-stdout JSON) and `validate` (exit 0); the
Node guard's failure path (legible stderr + code 78 under simulated Node 20); a host-managed
`config.yaml` write preserving `version`/`profile`/`workflows`/`featureFlags`/comment byte-for-byte
while adding only the `openlore` block; and `verify --json` / `drift --json` / `decisions --json`
emitting only valid JSON on stdout.

**Hardening pass (adversarial QA, 2026-06-22).** A multi-agent adversarial e2e sweep drove three fixes
(decisions `b7a630d8`, `798b8634`):
- **Truly byte-exact config writes.** The original `parseDocument`+`toString` was comment-preserving
  but re-serialized host content (normalized CRLF→LF, collapsed inline-comment spacing, reflowed folded
  scalars). Replaced with a top-level-block string splice (`spliceTopLevelBlock`) that touches no host
  bytes; malformed host YAML is now refused (throw), never clobbered.
- **Guard truly runs first.** ESM hoists static imports, so the old top-level `assertSupportedNode()`
  call ran *after* commander/command-module bodies. Moved into a dependency-free
  `src/cli/node-version-bootstrap.ts` imported first, so the check genuinely precedes commander.
- **Validator containment.** `validatePluginManifest` now enforces the host's skill `dir`/`source`
  path-containment rule (previously only the self-guard checked it), so `validate <packageRoot>` is
  strict for third-party manifests too.
- Defense-in-depth: extended the stdout-purity redirect to `drift`/`decisions` `--json` (and switched
  their JSON emit to `process.stdout.write`), with a `quiet-stdout` unit test. README, cli-reference,
  and CHANGELOG updated.

Deferred to **Phase 2** (lands with the host loader): hand skill/workflow distribution fully to
OpenSpec and retire/gate the OpenLore installer (one writer per artifact); contribute the
`onboard-from-code` workflow; optional `mcp`-capability advertisement; pin `openspecCompat` to the
first loader release.
