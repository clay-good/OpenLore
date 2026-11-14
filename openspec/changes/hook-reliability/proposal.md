# Hooks that never hurt a session

> Priority: P1 · Not built
> Reaches the agent through: the four hook moments (prompt submitted, before an edit, after an edit, before stop) and `openlore status`
> Why it helps the agent: evidence arrives on time, once, and a broken or slow hook costs the agent nothing.

## Problem

Hooks are now the main way OpenLore reaches the agent. They run on every prompt and every edit, so
one slow or broken hook hurts every turn. Today:

- Three moments (`before-edit`, `after-tools`, `before-stop`) fail open by code. No test states this
  as a contract, so a later change can break it without a red test.
- The prompt-submitted moment is `openlore orient --inject`. It is not a `hook` moment: it has no
  `hooks.*` off switch, no time limit of its own, no once-per-session rule, and `openlore status`
  does not list it. On an error it prints a pointer line on every prompt.
- There is no latency test. The only number is "~300 ms" in `docs/install.md:328`.
- The once-per-session cache (`hook.ts:232-262`) keys facts by text. One finding has a different key
  at `after-tools` and at `before-stop`, and a changed finding can hide behind an old key.
- A hook whose runtime is gone (moved or removed install) exits non-zero with `Cannot find module`
  on every event. `openlore doctor` checks the MCP launcher path but not the hook commands.
- Nothing records if a hook ran, how long it took, or what the agent did with a finding.

## What changes

- **Fail-open contract, tested.** For all four moments: an error, a timeout, a missing or corrupt
  `.openlore/`, a missing or unusable index, bad stdin, or a missing runtime gives exit 0 and no
  output. The only block is `before-stop`, and only for a finding code that the repository's
  `enforcement.policy` names as blocking.
- **Prompt submitted joins the contract.** `orient --inject` keeps its name and its installed hook
  entry. It gains the `hooks.prompt-submitted` off switch, a time limit, the once-per-session
  rule, and a place in `openlore status`.
- **A p95 latency budget per moment**, with a test. A run that passes its runtime limit stops,
  prints nothing, and is counted as an overrun.
- **Each finding once per session.** A finding's identity is code + subject + proof hash. It is
  shown again only when its proof changes or a new session starts.
- **Clean upgrade and uninstall.** A reinstall leaves one entry per managed hook and removes
  entries of retired moments. Uninstall leaves no hook that calls OpenLore. The wired command
  checks that its runtime exists and exits 0 when it does not.
- **One health line in `openlore status`.** Per moment: last run, p95, errors, overruns, findings
  shown.
- **Acted-on counts.** The session record counts what happened to each shown finding: fixed,
  decided, open at stop, or not assessed. This is the project's proof-from-daily-use signal: it
  shows, from real sessions, that findings lead to action. It is local data and is never sent.

## What does not change

- No new MCP tool, preset, CLI command, service, or network call. No LLM.
- No renames. `openlore orient --inject`, `openlore hook <moment>`, `hooks.<moment>`, and
  `contextInjection.mode` keep their names and meaning. Hook entries that are installed today keep
  working without a reinstall.
- Findings stay advisory. Blocking stays opt-in through `enforcement.policy`.
- The harness timeouts in `MANAGED_HOOKS` (15 s, 30 s, 90 s) stay as they are.
- A missing index at the prompt-submitted moment still starts the background build and says so in
  one line, now once per session (`OneShotOrientSelfBootstraps` is unchanged).
- The rule "quiet unless new and real" belongs to `reframe-governance-as-agent-evidence`. This
  change supplies only the once-per-session mechanism.
- Works the same with or without OpenSpec.

## Limits we disclose

- Without a harness `session_id`, nothing is deduplicated and no outcome is counted.
- A crash before the hook code loads, and a run whose runtime is missing, cannot be counted. The
  health line counts only runs that reached the hook.
- p95 in `status` is the hook process time. It does not include the harness's own spawn time.
- "Fixed" means the same check ran again on the subject and did not report the finding. A check
  that did not run (timeout, error) proves nothing: the finding is counted as not assessed.
- "Decided" needs the finding id in the decision text. A decision without the id is not counted.
- OpenLore cannot read the agent's final message. "Open at stop" means the finding was still
  present in the stop receipt, which the user sees.
- The runtime guard needs a POSIX shell (Claude Code uses one, also on Windows through Git Bash).
  Where the host does not run hook commands through a shell, the command stays unguarded.
- Plugin hooks (`plugin/hooks/hooks.json`) and plugin removal belong to `ship-claude-code-plugin`.

## Depends on / order

- The rule "a finding that is blocking only by its source default does not block a stop" holds
  once `reframe-governance-as-agent-evidence` group 1 makes every source default advisory. Build
  that group first, or keep the stop-block check from reading source defaults.

- Nothing blocks the start. Build order is in `tasks.md`: measure, fail-open tests, prompt-submitted
  moment, once per session, latency test, health line, acted-on counts, upgrade and uninstall.
- `ship-claude-code-plugin` must keep its `hooks.json` equal to `MANAGED_HOOKS`. If group 8 changes
  the wired command form, tell that change.
- `reframe-governance-as-agent-evidence` can use the finding id (design decision 3) for its
  decision-with-proof link.
