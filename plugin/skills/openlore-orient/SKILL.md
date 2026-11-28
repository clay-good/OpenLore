---
name: openlore-orient
description: Retrieve relevant functions, callers, spec sections, and insertion points from OpenLore before reading source files. Use when starting work that needs structural orientation in an existing codebase.
---

# OpenLore — orient before you read

This project uses **OpenLore** to keep a deterministic, graph-native model of the codebase: every
function, its callers, the tests that reach it, and the specs and decisions that govern it. One
`orient` call replaces a chain of searches and file reads.

## When to use this skill

- **A task in an area you have not read this session.** Call `orient` before you open files.
- **An unknown function or symbol.** Ask `orient`, or `search_code`, instead of grepping blind.
- **A cross-module change.** `orient` ranks insertion points by structural fit.
- **A freshness note on a tool answer.** When an answer says your context is stale, orient again.

Skip it for a file you are already working in. The prompt hook briefs a prompt only when it names
code that resolves exactly in the index, so no briefing does not mean there is nothing to find.

## How to use it

Call the `orient` MCP tool with the user's own words as `task`. If the tool is not available and
the CLI is installed, run `openlore orient --json --task "<task>"` (or, when this skill folder has
them, `bash scripts/orient.sh "<task>"`; on Windows `powershell -File scripts/orient.ps1 "<task>"`).
Read the result in this order:

1. **`specDomains`** — the written intent that owns the files, when the repository has any.
2. **`callPaths`** — who calls the top functions: this is what breaks if you change them.
3. **`insertionPoints`** — where to make the change. Open source files only here.

Other fields: `relevantFunctions` (scored, with `filePath` and `startLine`), `relevantFiles`,
`changeCoupling`, `provenance`, and `suggestedTools`. Pass `lean: true` for a quick "who calls X"
lookup; it returns only the navigation core.

For a narrower question, use one tool:

| Question | Tool |
|----------|------|
| Where is this concept handled? | `search_code` |
| What calls this, and what does it call? | `get_subgraph` (`direction: "both"`) / `analyze_impact` |
| How does A reach B? | `find_path` |
| What does this file contain, without the bodies? | `get_function_skeleton` |
| What is known about this code from earlier sessions? | `recall` |
| Is this claim about the code true? | `verify_claim` |
| What will my diff break? | `blast_radius` |

## What not to do

- Do not open source files for a non-trivial task before `orient` returns.
- Do not call `orient` before every edit. Orient again when the task moves or the answer is stale.
- Do not paraphrase the task. The user's words match the graph best.
- Do not treat a quiet result as "nothing there" when the language is not supported; the answer
  says what was not assessed.

## When it fails

- **Empty `relevantFunctions`.** Rephrase with a module, function, or domain name. If that fails,
  say that `orient` found no match, then grep inside one module.
- **`isError` with "No analysis found".** The index is not built yet. The hooks start a build on
  their own; retry after it finishes, or run `openlore analyze` once where the CLI is installed.
- **A stale index.** Answers still come back with a freshness note. Do not rely on insertion points
  until the index is rebuilt.

Always tell the user when you fell back to grep, so they can rebuild the index.

## Close with one action per finding

- **Fix it**, with the caller, edge, or test from the answer as proof.
- **Record a decision** when the answer made you choose: `openlore decisions record --title
  "<choice>" --rationale "<proof>" --files <paths>` where the CLI is installed; with the plugin
  alone, state the decision and its proof in your final message.
- **Raise it to the human** only when the evidence warrants it: a breaking change to a contract used
  outside the repository, overriding an accepted decision, an added secret, or a finding you cannot
  settle from the evidence.
