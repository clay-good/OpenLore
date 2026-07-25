# Harden the graph-store lifecycle: read paths never destroy the index; corruption is quarantined

> Status: IMPLEMENTED (2026-07-18, PR harden-index-store-lifecycle). Opening the SQLite graph store
> for a READ previously executed `DROP TABLE` on a schema-version mismatch — an upgrade followed by
> any query silently destroyed the index — and a corrupt DB file threw uncaught with no quarantine.
> Now `EdgeStore.open()` is non-destructive (schema mismatch → typed not-ready, on-disk store left
> intact; corrupt DB → quarantined to `*.corrupt-<n>`), `EdgeStore.openForAnalyze()` owns the
> rebuild-on-bump write path, and `openlore doctor` discloses the state — bringing `EdgeStore` up to
> the lifecycle discipline the decision store already has (`CorruptStoreQuarantineNotSilentEmpty`,
> `architecture/spec.md`).

## The gap

**(a) Read paths destroy data on schema bump.** `EdgeStore`'s constructor unconditionally runs
`initSchema()` on every `EdgeStore.open()` (`edge-store.ts:73-75`, `:948`), and on any
`SCHEMA_VERSION` mismatch `initSchema` executes `DROP TABLE` across the whole graph — edges, nodes,
classes, decisions, provenance, coupling, CFG overlay (`edge-store.ts:83-100`). So a user who
upgrades OpenLore (schema bump, `:61`) and then runs a *read* command — orient, search, any MCP
query — has their index destroyed by the read. `_wasReset` (`edge-store.ts:70-71`) records the fact
only after the data is gone, and the downstream guard (`mcp-handlers/utils.ts:368-380`) merely
avoids *serving* the now-empty store; the destruction already happened at open. Ten-plus call sites
open the store this way. The user pays a full re-analyze for having asked a question.

**(b) Corruption crashes, unquarantined.** `openDatabase` (`edge-store.ts:13-24`) sets pragmas and
returns — a corrupt or truncated `call-graph.db` throws uncaught at open: no catch, no quarantine,
no honest not-ready result. The decision store already implements the correct discipline —
`CorruptStoreQuarantineNotSilentEmpty` (`openspec/specs/architecture/spec.md`): move the unreadable
file aside to `*.corrupt-<n>` (atomic claim, index derived from on-disk state) and emit a
recoverable signal, never a crash and never a silent empty. The graph store predates that
requirement and was never brought under it.

## What changes

**Destructive schema migration becomes a write-path privilege; read paths return an honest
not-ready conclusion; corruption is quarantined with parity to the decision store.**

- `EdgeStore.open()` splits into read and write modes (e.g. `openForRead` / `openForAnalyze`, or a
  mode flag — implementation's choice). **Read mode never mutates:** a schema-version mismatch
  returns a typed not-ready result ("index was built by an older OpenLore — run `openlore analyze`")
  that MCP tools and CLI commands surface as a conclusion, not an empty graph and not a wipe.
  Only analyze/write paths — which repopulate immediately — may drop and rebuild.
- Corruption at open (in either mode) is caught; the DB file (and its WAL/SHM siblings) is moved
  aside to a quarantine path following the existing requirement's shape — `*.corrupt-<n>`, next
  free index from on-disk state, atomic claim — and the caller receives the same honest not-ready
  shape, never a crash and never a silently recreated empty store.
- Reset/quarantine events are surfaced proactively, not just recorded: `openlore doctor` reports a
  schema-mismatched or quarantined store with the recovery command, and the next MCP tool call
  carries a one-line notice (the existing freshness-note channel), so the user learns *before*
  wondering where their graph went.
- The existing `wasReset` consumers (`mcp-watcher.ts`, `mcp-handlers/utils.ts`) migrate to the
  not-ready result; `_wasReset` remains only on the write path where a wipe legitimately occurs.

## Why this is in scope

The index is the substrate's persistent memory of the codebase; a read that destroys it is the
storage-layer version of guessing — worse, it converts a version skew into data loss and presents
the aftermath ("re-run analyze") as if it were the user's problem. The architecture spec already
states the governing invariant for the decision store; this change is parity, not novelty: same
quarantine shape, same never-silent-empty rule, applied to the store every navigation tool depends
on. Deterministic, local, no new constants (the quarantine suffix rule is reused as specified).

## Impact

- Files: `src/core/services/edge-store.ts` (open modes, quarantine-at-open, schema-mismatch
  not-ready), `src/core/services/mcp-handlers/utils.ts` + `src/core/services/mcp-watcher.ts`
  (consume not-ready instead of post-hoc `wasReset`), doctor command, freshness-note surface;
  tests for upgrade-then-read, corrupt-open, concurrent quarantine claims.
- Specs: `architecture` — 2 ADDED requirements (ReadPathsNeverDestroyTheIndex,
  CorruptGraphStoreQuarantineParity), citing `CorruptStoreQuarantineNotSilentEmpty`.
- Tool surface: unchanged (no new MCP tool; existing tools gain an honest not-ready conclusion).
- Risk: medium-low. Read-mode callers must all handle not-ready (the compiler enforces the typed
  result); the write path's rebuild behavior is unchanged, so `analyze` flows are untouched.
