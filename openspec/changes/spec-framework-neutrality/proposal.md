# Work with any spec or test workflow, and with none

> Priority: P1 · Not built
> Reaches the agent through: `orient`, `blast_radius`, `verify_change`, `verify_claim`, and `recall` (no new tool, no new hook)
> Why it helps the agent: it gets the repo's written intent from where the team keeps it (OpenSpec, Spec Kit, Kiro, ADRs, plain requirements, tests), and an honest "no spec source found" when there is none.

## Problem

OpenLore reads intent from one place only: `openspec/specs/<domain>/spec.md`. Measured on main at
`0dd75dbef`:

- First run (`init`, `install`, cold start) creates an empty `openspec/specs/` folder in every repo.
- A missing `openspec` binary is reported by `openlore change-status` as a failed validation
  (`"passes": false, "error": "spawn openspec ENOENT"`), not as "not assessed."
- In a repo with no `openspec/`, `orient` returns `specDomains: []` with no note, `get_test_coverage`
  returns 0%, and `search_specs`, `check_spec_drift`, `list_spec_domains` and `openlore drift` tell
  the user to run `openlore generate` (an LLM step) as if it were required.
- 14 sites hard-code the literal `openspec` and ignore `openspecPath`. About 15 places list spec
  files and about 11 parse `### Requirement:` on their own. There is no adapter interface.
- `.kiro/specs/`, `docs/adr`, `docs/decisions`, and Spec Kit specs are read by nothing.

A team that uses another workflow, or none, gets an extra folder, wrong zeros, and advice that does
not fit.

## What changes

- **One small read-only interface, the spec source.** `detect` says if a source is present. `list`
  returns requirement-like items: `id`, `text`, `file`, `line`, `kind`. Nothing else. New folder
  `src/core/spec-sources/`.
- **OpenSpec is the first adapter and stays first-class.** `loadSpecCorpus`, `buildSpecMap` and
  `detectExistingSpecDir` move behind it with no behavior change. Generating OpenSpec-format specs
  stays as it is.
- **Five more adapters, one PR each, read-only:** ADR folders (`docs/adr`, `docs/decisions`),
  markdown requirements (EARS and RFC 2119 sentences), tests as intent (test names and describe
  blocks), Kiro (`.kiro/specs/*/requirements.md`, `design.md`, `tasks.md`), Spec Kit
  (`specs/<feature>/spec.md`, `plan.md`, `tasks.md`, marker `.specify/`).
- **"None" is a normal state.** Code, tests and decisions still give full value. Answers that need
  a spec say `no spec source found` and name what was looked for. They never tell the user to run
  `openlore generate`, and never return a bare zero or empty list.
- **No runtime need for the `openspec` CLI.** `change-status` reports a missing binary as
  `not-assessed` with the reason.
- **First run creates no spec folder.** `openspec/` is created only by a command that writes
  OpenSpec output (`generate`, decision sync into an existing corpus).
- **Config:** `openspecPath` becomes optional. One new optional key, `adrPaths`, names extra ADR
  folders to read.
- **Text:** tool descriptions, install messages, skills and docs say "spec source" where the
  behavior is general and "OpenSpec" only where the format is OpenSpec. The prompt hint for other
  workflows is `add-openspec-proposal-orientation`.

## What does not change

- No new MCP tool, preset, CLI command, hook, service or network call. No LLM in any path here.
- No renames. `openspecPath`, `specDomains`, `get_spec`, `search_specs`, `check_spec_drift`,
  `get_mapping`, `prepare_spec_generation`, `prepare_spec_repair` and every CLI command keep their
  names and shapes. New data arrives as added optional fields.
- A repo that has `openspec/` today behaves the same: same paths, same findings, same exit codes.
- OpenLore still does not reimplement the OpenSpec change lifecycle.
- Adapters never write. OpenLore does not create or edit Spec Kit, Kiro or ADR files.
- Findings stay advisory. Everything is local.
- Not re-planned: what PR #692 removed (the `plugin-manifest` command, its schema, the `openspec`
  key in `package.json`).

## Limits we disclose

- Drift, mapping and spec coverage need a code anchor (`- **Implementation**:`). Only OpenSpec has
  one today. For other sources these answers say `not assessed: source has no code anchors`. Their
  items are still found by `orient` and `search_specs`.
- Markdown requirements are matched by sentence shape (SHALL, MUST, EARS "WHEN … THE SYSTEM
  SHALL"). A requirement written another way is not listed. The count is a lower bound.
- Tests as intent covers TypeScript, JavaScript, Python and Go test names. Other languages are not
  assessed. A test name is intent, not proof that the behavior is checked.
- The Spec Kit and Kiro layouts are assumptions taken from their public templates. Each adapter's
  first task confirms the layout against a real project before code is written.
- ADR files are read in MADR and Nygard shapes. Other shapes are listed by title only.

## Depends on / order

Depends on nothing. Ship in this order; each group in `tasks.md` is one small PR:

1. First run creates no `openspec/`; missing CLI is `not-assessed`.
2. Honest "no spec source found" answers.
3. Config, then the interface with OpenSpec moved behind it (no behavior change), then the
   hard-coded `openspec` sites.
4. One adapter per PR: ADR folders, markdown requirements, tests as intent, Kiro, Spec Kit.
5. Text: tool descriptions, install, skills, docs, examples.

Related main specs, reused and not duplicated: `agent-neutral-spec-reconciliation` and
`mcp-spec-workflow-composites` (agent- and client-neutral; this change adds format neutrality), and
`cli` `DriftHookDistinguishesFailureFromDrift` (already says missing specs is "could not check").
