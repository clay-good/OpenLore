# Tell the agent when its change made a local doc false

> Priority: P3 · Not built
> Reaches the agent through: `verify_change` (and so the before-stop hook), and a new `doc-current` kind of `verify_claim`
> Why it helps the agent: it fixes the README line it just broke, in the same change.

## Problem

An agent renames a function or deletes a file, and the README, `docs/` and other Markdown still
name the old one. Nothing tells the agent. The next agent reads the stale doc and runs a command
or opens a path that no longer exists. The graph already knows which symbols and files the diff
removed; it never looks at the Markdown that names them.

## What changes

- New `src/core/services/doc-claims.ts`: extract checkable claims from tracked local Markdown.
  The claim forms are closed and syntactic:
  - a backticked identifier that named exactly one indexed symbol at the merge-base;
  - a path-shaped token or a relative Markdown link target;
  - a `path:line` citation.
- `verify_change` checks the claims the diff can break: names of symbols it removed, paths it
  deleted or moved, line citations into files it changed, and claims on Markdown lines it added.
  A claim that held at the merge-base and is false now is the advisory finding
  `doc-claim-refuted`, with the doc `file:line` and the evidence (symbol gone, file moved to X,
  cited line now past the end of the file).
- A renamed symbol is reported as renamed, with its new name, through the shipped identity
  continuity. The agent can fix the doc with one edit.
- `verify_claim` gains the kind `doc-current`: the subject is a Markdown path, optionally
  `path:line`. Verdict `holds`, `refuted` (each false claim with evidence), or `unverifiable`
  (no checkable claim there).

## What does not change

- No new tool and no new command. `verify_change` and `verify_claim` keep their names.
- Local files only. Links to a URL are not fetched and not checked.
- No model, and no judgment of prose meaning, tone or completeness.
- Advisory. `doc-claim-refuted` blocks only if `enforcement.policy` names it.
- Works without OpenSpec: any tracked `.md` file counts.

## Limits we disclose

- An ambiguous or external subject is `unverifiable`, never `refuted`: a name that matched several
  symbols, a common word, another project's path. The count of such claims is stated.
- Command lines, flags, numbers and badges in docs are not checked. `src/doc-claim-sync.test.ts`
  keeps that job for this repository.
- `verify_change` reports only what the diff broke. A doc that was already wrong is found only by
  `verify_claim` `doc-current`.
- Markdown only. Docstrings and code comments are out of scope.

## Depends on

Shipped: `verify_change`, `verify_claim`, symbol identity continuity
(`src/core/decisions/continuity-carry-forward.ts`), merge-base blob reads, the finding registry.
