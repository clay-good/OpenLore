# Tasks — harden-index-store-lifecycle

## Implementation
- [x] Split `EdgeStore.open()` into read and write modes; read mode NEVER runs destructive
      migration — schema mismatch returns a typed not-ready result instead of DROP TABLE
- [x] Write/analyze mode keeps rebuild-on-bump (repopulates immediately); `_wasReset` confined to it
- [x] Catch corruption at `openDatabase`; quarantine `call-graph.db` (+ WAL/SHM) to `*.corrupt-<n>`
      — next free index from on-disk state, atomic claim — mirroring
      CorruptStoreQuarantineNotSilentEmpty; return the same not-ready shape
- [x] Migrate `wasReset` consumers (`mcp-handlers/utils.ts`, `mcp-watcher.ts`, `serve.ts`, plus the
      export/import/decision read sites) to the typed not-ready result; MCP tools surface it as a
      conclusion ("run openlore analyze"), never an empty graph
- [x] `openlore doctor`: report schema-mismatched / quarantined store with the recovery command
- [x] One-line proactive notice on the next tool call via the existing freshness-note channel
      (the schema-fault triggers the shared background repair, which drives the disclosure)

## Verification
- [x] Test: bump SCHEMA_VERSION, open for read → data intact on disk, not-ready returned, no DROP
- [x] Test: bump SCHEMA_VERSION, open for analyze → rebuild as today
- [x] Test: truncated/corrupt db file → quarantined aside (correct `-<n>` sequencing), not-ready
      returned, no crash, no silent empty store recreated
- [x] Test: two concurrent opens of a corrupt store → next free suffix taken; no bytes lost
- [x] Test: doctor surfaces the reset/quarantine event with the recovery command
- [x] Full suite green (all `EdgeStore.open` call sites compile against the typed result)
- [x] E2E dogfood: upgrade-then-read preserves the index; corrupt-open quarantines; analyze recovers

## Spec
- [x] `architecture` delta: ADD ReadPathsNeverDestroyTheIndex, CorruptGraphStoreQuarantineParity
