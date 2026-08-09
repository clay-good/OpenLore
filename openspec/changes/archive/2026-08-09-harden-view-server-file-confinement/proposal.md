# The view server's file access is lexical-only — a symlink in a cloned repo escapes the project root; and it serves arbitrarily stale analysis as current

> Status: PROPOSED (2026-07-03, e2e audit pass 4). The `openlore view` HTTP server confines
> file reads with `resolve()` + `startsWith()` — purely lexical, so `readFile`/`statSync`
> follow symlinks straight out of the project root. Under the stated threat model (a cloned
> repo has attacker-controlled content), a repo shipping `docs.ts -> ~/.ssh/id_ed25519` or
> `openspec/specs/evil -> /etc` serves out-of-repo file contents through the viewer — and, if
> the user asks the chat panel about that file, forwards them to the configured LLM provider.
> The canonical symlink-aware guard already exists in the MCP handlers
> (`mcp-handlers/utils.ts:163-172`, "Path escape blocked"); the view server never inherited
> it. Distinct from `harden-local-http-surfaces` (Host/token/lifecycle) and
> `harden-serve-descriptor-trust` (serve.json) — neither mentions symlink canonicalization.
> Secondarily, the viewer renders analysis with no freshness disclosure, the one place the
> project's own doctrine ("never a stale result presented as authoritative") is violated in
> the UI.

## The gap

- **(a) Symlink escape via lexical `safePath`.** `view.ts:47-54`: `safePath` resolves and
  `startsWith`-checks but never `realpath`s; `readFile`/`statSync` follow symlinks.
  `/api/skeleton?file=docs.ts` (`:384-390`) and `/api/spec-requirements` (`:313-317`) serve
  the link target; `/api/spec`'s `collectSpecFiles` (`:241-259`) does
  `statSync(fullPath).isDirectory()`, following a symlinked directory into unbounded recursion
  and concatenating every `.md` it finds outside the repo. The MCP handlers already
  `realpathSync` both root and target and throw "Path escape blocked" precisely to close this
  (`utils.ts:163-172`).
- **(b) No freshness disclosure in the viewer.** Every artifact endpoint
  (`view.ts:135-228`) serves `dependency-graph.json` / `llm-context.json` verbatim with no
  generated-at or staleness field, and no `src/viewer/` component renders one. A user who
  refactored for a week and opens `openlore view` sees a call graph predating the refactor as
  if current — and might make a deletion decision from it.

## What changes

1. **Canonicalize before serving.** `safePath` `realpath`s both root and the resolved target
   before the containment check (reuse/extract the `utils.ts` guard so both surfaces share one
   lock); `collectSpecFiles` uses `lstat` and skips symlinks, with a total-size cap on the
   concatenation.
2. **Disclose staleness.** Serve each artifact's mtime (and the analyzed commit vs current
   HEAD if recorded) alongside its payload; show one dismissible banner in the UI when the
   artifact predates the latest commit touching analyzed files.

## Why this is in scope

The viewer reads files and talks to an LLM on behalf of a user who may have cloned an
untrusted repo; a lexical-only path guard when the canonical one already exists in-tree is a
concrete local file-disclosure hole. And a UI that presents stale structure as current is the
exact doctrine violation the substrate is built to prevent — the fix is the freshness
discipline every other surface already carries.

## Impact

- Files: `src/cli/commands/view.ts` (`safePath` realpath, `collectSpecFiles` lstat+cap,
  artifact mtime/commit in responses); a small `src/viewer/` staleness banner; ideally extract
  the `utils.ts` confinement guard into a shared helper both import.
- Specs: `mcp-security` — 1 ADDED (ViewServerCanonicalizesPathsBeforeServing); `cli` — 1
  ADDED (ViewerDisclosesAnalysisStaleness).
- No new tool. Risk: low — the realpath guard matches the proven MCP-side behavior; the
  banner is additive. Verify: a symlinked `file=` param is rejected (not served); a symlinked
  spec dir is skipped; the viewer shows a staleness banner when the artifact predates HEAD.
