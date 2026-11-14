# Name the owners a change touches, from the repository's CODEOWNERS file

> Priority: P3 · Not built
> Reaches the agent through: `blast_radius`, `verify_change` (and so the before-stop hook)
> Why it helps the agent: it can name the right human in its final message or PR body.

## Problem

When a change reaches code that another team owns, the agent should raise it to that team. Today
it cannot: `blast_radius` and `verify_change` list files and callers, not owners. The owner of each
file is already declared in a local `CODEOWNERS` file, and nothing in `src/` reads it.

## What changes

- A small resolver, new `src/core/analyzer/codeowners.ts`: find `CODEOWNERS` (repository root,
  `.github/`, or `docs/`), parse the GitHub format, and resolve the owners of a path by
  last-match-wins. It is a pure function of the path. It reads one local file.
- `blast_radius` gains `ownership`: the file used, and for each owner the changed files and the
  affected-caller files it owns, plus the changed files no rule covers. Counts and names only.
- `verify_change` shows one receipt line from the same data: "raise to: `@org/api-team` (2 changed
  files), `@org/infra` (callers affected)".
- One advisory finding code, `unowned-critical-path`, registered in `FINDING_CODE_REGISTRY`: the
  diff changes a symbol with the existing `hub` or `chokepoint` label
  (`src/core/analyzer/landmark-signals.ts`) in a file no rule covers. It fires only for symbols in
  the diff. No new threshold.

## What does not change

- No new tool, command or preset. No other tool's output changes.
- No integration: no forge API, no network call. Owner handles are text from the file; they are
  not checked against any service.
- Advisory. Nothing blocks unless the repository's `enforcement.policy` names the code.
- Ownership is never inferred from git authorship. Works without OpenSpec.

## Limits we disclose

- No `CODEOWNERS` file: `ownership` says "not assessed (no CODEOWNERS)". It is never an empty list
  that reads as "unowned", and no `unowned-critical-path` finding is emitted.
- GitHub format only. A GitLab file with sections, or a Bitbucket file, is reported as an
  unsupported format with no owner map. A single rule that cannot be parsed is skipped and counted.
- Declared owners can be out of date. OpenLore reports what the file says.
- Owner handles come from a repository file, so they are screened like other repository text.

## Depends on

Shipped: `blast_radius`, `verify_change`, landmark labels, the finding registry.
