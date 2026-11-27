# Design notes

## The hand-back at stop (group 4, ADR-0038 item 4)

Today `before-stop` prints the `verify_change` receipt as a `systemMessage`: the user sees it, the
agent does not, unless `enforcement.policy` blocks. ADR-0038 says governance reaches the agent and
a human is involved only when the evidence warrants it. In Claude Code, the only way a Stop hook
gives the model text is `{"decision":"block","reason":…}`: the agent keeps working with the reason
as input.

Rule:

| Case | Output |
|------|--------|
| No open item, or every open item was handed back before in this session | nothing to the agent; the user line as today |
| One or more open items not handed back before, `stop_hook_active` is false | `decision: "block"` once; `reason` = the new items, each with proof and its one action (fix, or record a decision with the proof, or raise to a human when the item is in the ADR-0038 raise list) |
| `stop_hook_active` is true | never block; the user line only |
| `hooks.before-stop: false` | nothing |

- **Once.** Handed-back items are keyed in the per-session record (`markShown`, audience `agent`).
  An item that comes back after it was marked fixed counts as new (today's `wasShown` rule).
- **Not enforcement.** The agent may stop on its next attempt without fixing anything. A blocking
  `enforcement.policy` keeps its current meaning and is unchanged.
- **Raise list.** An item whose code is in the ADR-0038 raise list (a breaking contract change with
  outside consumers, a superseded accepted decision, an added secret) says "raise to a human" as its
  action, so the agent puts it in its final message or PR body.
- **Budget.** The reason uses the before-stop budget (`BUDGET_CHARS['before-stop']`, 8,000 chars);
  past it, the item count left out is stated.

Option dropped: deliver the receipt at `after-tools` only. It already prints per-file facts there,
but cross-file items (a broken consumer in another file, a removed export) are only known for the
whole diff, at stop.
