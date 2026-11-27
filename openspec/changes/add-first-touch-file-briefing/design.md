# Design notes

## A fifth moment (decided: ADR-0038)

ADR-0036 named four moments. ADR-0038 (decision 35c3f807, 2026-11-27) adds the first touch of a
file, because the agent decides what to change while it reads, and the before-edit moment is too
late for that decision. Option dropped: only `before-edit`. It is simpler, but the agent has already
planned the edit when it fires. The `overview` delta in this change updates the north-star
requirement to five moments.

## Why `PostToolUse` and not `PreToolUse`

At `PostToolUse` the briefing arrives beside the file text the agent just asked for. At `PreToolUse`
it would arrive before the text and delay the read. A `PostToolUse` hook does not change the read.

## Latency

CLI cold start is about 0.45 s. A repeat touch must not pay it. Task 2.1 adds a small entry in
`dist/` that reads only the session record (a JSON file under `.openlore/`) and exits 0 when the
file key is there, before it imports the CLI. The first touch then pays the full start once per
file. The hook-health record (`HookRunsAreBudgetedMeasuredAndReported`) counts both paths.

## Choosing "callers in other files"

Callers in the same file do not tell the agent anything it cannot see on screen. Only edges whose
caller file differs from the target count. Test files are left out of this count; they appear in
line 4.
