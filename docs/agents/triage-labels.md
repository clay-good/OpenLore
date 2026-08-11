# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to
the label strings that actually exist in this repo's issue tracker.

This repo uses the **stock GitHub label set** — no new labels are created for triage.

| Canonical role    | Label in our tracker | Meaning                                  |
| ----------------- | -------------------- | ---------------------------------------- |
| `needs-triage`    | *(none — see below)* | Maintainer needs to evaluate this issue  |
| `needs-info`      | `question`           | Waiting on reporter for more information |
| `ready-for-agent` | *(none — see below)* | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `help wanted`        | Requires human implementation            |
| `wontfix`         | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding label string from this table.

## The two roles with no label

`needs-triage` and `ready-for-agent` have no equivalent in the stock set. **Do not
substitute a close-enough label** (`bug`, `enhancement`, and `good first issue` mean other
things, and mislabelling is worse than not labelling). Instead, state the state
explicitly in a comment on the issue, so it stays visible and greppable:

```
gh issue comment <number> --body "Triage state: ready-for-agent — fully specified, no human context required."
```

A triage pass that lands on one of these two roles is complete only once that comment
exists. Never silently drop the state.

## Changing this

If those two roles get real labels later, create them and replace the *(none)* cells —
nothing else needs to change.
