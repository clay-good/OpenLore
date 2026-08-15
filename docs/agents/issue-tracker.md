# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

`gh` infers the repository from the clone's remotes. If a clone has several remotes (a
fork setup, say) and the inferred repo is not the one you mean, pass `--repo <owner>/<repo>`
explicitly rather than letting it guess.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Label strings come from [`triage-labels.md`](./triage-labels.md) — do not invent new ones.

## Write access

A `gh` write (create, comment, label, close) can fail with `HTTP 403` when the account
lacks permission on the target repository. That is a permissions boundary, not a
malformed command: report it and stop. **Do not silently retarget the write to another
repository** — an issue filed somewhere other than where the skill was told to file it is
worse than none.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
