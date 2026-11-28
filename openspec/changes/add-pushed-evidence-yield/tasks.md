# Tasks

## 1. Record

- [ ] 1.1 Add a closed `PushedKind` list and `markPushed(rec, moment, kind, refs)` to
      `src/core/services/hook-session.ts`; refs are files, symbols, and test paths, never text.
      Test: `src/core/services/hook-session.test.ts`. Done when a pushed line is stored with its
      refs and an unknown kind is rejected by the type.
- [ ] 1.2 Call `markPushed` where each moment prints a line: `orient --inject`
      (`src/cli/commands/orient-inject.ts`) and each moment in `src/cli/commands/hook.ts`. Test:
      `src/cli/commands/hook.test.ts`. Done when every printed line kind has a record.

## 2. Use

- [ ] 2.1 Add `markUsed(rec, event)` for a read, an edit, a `Bash` command text, and an OpenLore
      tool call. Call it from `after-tools`, `after-read` (when it ships), and the ledger's served
      hook. Test: `src/core/services/hook-session.test.ts`. Done when a later read of a named file
      marks the line used, and a read of another file does not.

## 3. Report

- [ ] 3.1 In `src/cli/commands/status.ts`, add `evidenceYield` (per moment and kind: pushed, used,
      share) to `--json` and one text line. Test: `src/cli/commands/status.test.ts`. Done when a
      fixture with records prints the numbers and a fixture with none prints no line.
- [ ] 3.2 Name kinds with 20 or more pushes and no use. Test: same file. Done when the fixture's
      unused kind is named and a used kind is not.

## 4. Proof from use

- [ ] 4.1 After one week of daily use in this repository, paste the `openlore status` yield line
      into the PR that ships the next briefing change, and cut or fix each named candidate there.
