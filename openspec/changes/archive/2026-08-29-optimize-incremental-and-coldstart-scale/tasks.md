# Tasks — optimize-incremental-and-coldstart-scale

## Implementation
- [x] Hoist getAllInternalNodes() out of the per-file loop (mcp-watcher.ts:477); load once
      before the loop and patch in memory per file
- [x] Bulk fallback: above WATCH_BULK_THRESHOLD, mark files stale + delegate to
      scheduleBackgroundRebuild() (one full analyze), disclose the mode switch (:629,:643)
- [x] Dedup batch members out of each other's caller closures (:483-489,:529); clear
      maxBatchTimer on VCS settle events (:368-375) so a checkout coalesces into one batch
- [x] Cold-start bootstrap off the event loop: spawn `openlore analyze` as a child process
      (mcp.ts:2444-2452, cold-start-bootstrap.ts), start the watcher un-awaited (mcp.ts:2460)
- [x] Release batch content as consumed; clear lastEmbedContext on drain (:431-445,:727-760)

## Verification
- [x] Counter test: a 30-file watcher batch loads the node table <=1x
- [x] Fallback test: a >threshold batch delegates to a single rebuild and discloses the switch;
      converge-or-flag staleness guarantee preserved (no file silently stale)
- [x] Dedup test: a file that is a caller of N batch members is re-parsed once, not N+1 times
- [x] Cold-start test: the initial build runs in a child process; the server event loop is not
      blocked for the build duration; first tool call is not gated on the full scan
- [x] Memory test: batch content is released after the flush; lastEmbedContext is cleared
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD BulkChangesFallBackToOneRebuild
- [x] `architecture` delta: ADD ColdStartBuildRunsOffTheServerEventLoop
