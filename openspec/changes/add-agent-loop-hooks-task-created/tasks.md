# Tasks — add-agent-loop-hooks-task-created

## 1. Confirm the harness facts (gate)

- [ ] 1.1 Capture a real Claude Code task-creation hook payload and save it as a new fixture under
      `src/cli/commands/fixtures/`. Test: `src/cli/commands/hook.test.ts` parses it. Done when the
      fixture shows the task description field and whether the event accepts `additionalContext`.
      If the event does not exist, stop and record that in `proposal.md`.

## 2. The moment

- [ ] 2.1 Add `task-created` to `HOOK_MOMENTS`, `HOOK_EVENT`, the budget and the time limit in
      `src/cli/commands/hook.ts`. Test: `hook.test.ts`. Done when an unknown or empty payload prints
      nothing and exits 0.
- [ ] 2.2 Resolve the task description to symbols with `src/core/services/subagent-briefing.ts`
      and compare them to live entries in `src/core/services/footprint-board.ts`. Test:
      `hook.test.ts`. Done when a task that shares a written symbol with a live peer yields one
      `parallel-work-conflict` receipt that names the peer and the symbols, and a task with no
      unique symbol match yields nothing.
- [ ] 2.3 Block only by policy: the receipt blocks only when `resolveEnforcementClass`
      (`src/core/services/mcp-handlers/enforcement-policy.ts`) returns blocking for the code. Test:
      `hook.test.ts`. Done when the default policy never blocks.

## 3. Wiring

- [ ] 3.1 In `src/cli/install/adapters/claude-code.ts`, add the hook entry only when the policy
      makes `parallel-work-conflict` blocking; remove it on uninstall. Test:
      `src/cli/install/install.test.ts`. Done when a default install writes no task-creation hook.
- [ ] 3.2 Keep `src/cli/commands/doctor-hook-reachability.test.ts` green for the new moment. Done
      when doctor reports the moment only where it is wired.

## 4. Docs

- [ ] 4.1 Add the moment to the tables in `docs/install.md`, `docs/configuration.md` and
      `docs/cli-reference.md`, and to the header comment of `hook.ts`. Done when each names the
      policy condition and "Claude Code only".
