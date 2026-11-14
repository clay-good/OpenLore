# A log line or error message arrives with the code that emitted it

> Priority: P2 · Not built
> Reaches the agent through: the after-edit hook moment (`after-tools`, a failed shell command) and the prompt-submitted hook moment (`orient --inject`); optionally a `verify_claim` kind
> Why it helps the agent: it starts at the emitting line instead of grepping fragments of an interpolated message.

## Problem

A failed command or a user prompt often contains a log line or error message, such as
`payment 84c2 failed after 3 retries`. The source holds a template, such as
`` log.error(`payment ${id} failed after ${n} retries`) ``, so a plain text search for the line
finds nothing. The agent then greps fragments, file by file. OpenLore already walks every logging
and `throw` call site during analysis, but it keeps nothing about their message text.

## What changes

- **Template facts.** During the existing analysis walk, each logging call and each `throw` /
  `raise` with a string or template literal yields a record: ordered constant parts, file, line,
  enclosing symbol. Records go to a sidecar artifact, `.openlore/analysis/log-templates.json`,
  rebuilt with the owning file's other facts. A message with no constant part is counted per file
  as unmatchable.
- **Matching.** A template matches a line when all its constant parts appear in the line in order.
  Candidates are ordered by total matched constant length. Templates below a fixed,
  source-declared length floor are not matched.
- **After a failed shell command.** `parseHookPayload` (`src/cli/commands/hook.ts`) already reads
  the exit status of a shell call, including Claude Code's `PostToolUseFailure`. It will also keep
  a bounded tail of the output. On a non-zero exit, the `after-tools` moment matches those lines
  and adds one receipt item per origin: `file:line`, enclosing function, and the matched constant
  parts as proof.
- **At prompt submission.** `buildInjection` (`src/cli/commands/orient-inject.ts`) matches the
  lines of the prompt the same way and adds the origin to the injected block.
- **Optional claim kind.** `verify_claim` gains the kind `log-origin` (subject = the line). One
  origin is `verified` with the call site as receipt. Several or none is `unverifiable`, with the
  candidates or the unmatchable count.

## What does not change

- No new MCP tool, CLI command, or preset. `locate_log_origin` is dropped.
- No existing name, field, or hook moment is renamed. A hook item is advisory and never blocks.
- Local only. Nothing tails, ingests, or stores logs. No LLM. Works without any spec framework.
- A successful shell command stays as cheap as today: no matching runs.

## Limits we disclose

- TypeScript, JavaScript, and Python first. Other languages produce no records and no counts.
- Logger calls are found through a closed table of callee names. A custom wrapper is missed until
  it is added to the table.
- The hook states one origin, or up to three tied candidates with the tie named. With more
  candidates it stays silent; the claim kind then reports the count.
- The index describes the code on disk. A log line from an older deployed version may match a
  different line or nothing. The existing index-staleness note is carried.

## Depends on

Shipped code only: the hook runner in `src/cli/commands/hook.ts`, `orient --inject`, and the
analysis walk. Nothing else.
