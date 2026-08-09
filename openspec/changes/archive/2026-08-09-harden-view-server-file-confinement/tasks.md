# Tasks — harden-view-server-file-confinement

## Implementation
- [x] safePath (view.ts:47-54): realpath both root and resolved target before the containment
      check; reuse/extract the mcp-handlers/utils.ts:163-172 guard into a shared helper
- [x] collectSpecFiles (view.ts:241-259): lstat and skip symlinks; add a total-size cap on
      the concatenated output
- [x] Serve artifact mtime (+ analyzed commit vs current HEAD if recorded) alongside each
      artifact payload (view.ts:135-228)
- [x] Viewer: one dismissible staleness banner when the served artifact predates the latest
      commit touching analyzed files

## Verification
- [x] Symlink test: /api/skeleton?file=<symlink-to-outside> is rejected, not served; a
      symlinked spec directory is skipped by /api/spec
- [x] Size-cap test: an oversized/looping spec tree is bounded, not unbounded-concatenated
- [x] Parity test: view-server confinement matches the mcp-handlers guard on the same inputs
- [x] Staleness test: an artifact older than HEAD surfaces the freshness field and banner
- [x] Full suite green

## Spec
- [x] `mcp-security` delta: ADD ViewServerCanonicalizesPathsBeforeServing
- [x] `cli` delta: ADD ViewerDisclosesAnalysisStaleness
