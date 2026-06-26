# Governance Dogfooding — Spec 15

> Turning OpenLore's decision + drift-governance system on, on ourselves. This note records the
> dogfood run: what was activated, the decisions produced, proof the gate works, and the rough
> edges the exercise surfaced (the point of dogfooding).

## What was activated

- **Pre-commit decisions gate** installed in this repo's hooks (`.git/hooks/pre-commit` +
  `post-commit` bypass detector), via the exported `installPreCommitHook`. Idempotent
  (marker-guarded `# openlore-decisions-hook`) and skippable (`git commit --no-verify`). The
  hook runs `openlore decisions --gate`, which exits non-zero while any decision awaits review.
- **LLM provider for consolidation:** `.openlore/config.json` set to `generation.provider:
  "claude-code"` so consolidation uses the local `claude` CLI (Max/Pro subscription) — no
  `ANTHROPIC_API_KEY` needed in this environment.

## Decisions recorded (real, already embedded in the codebase)

Recorded via the `record_decision` MCP tool, then consolidated → verified → approved → synced.
The decision store (`.openlore/decisions/`) is gitignored (a local working cache); the committed
evidence is the synced spec sections + ADRs.

| Decision | Scope | Synced to |
|---|---|---|
| SCIP is a one-way export, not a round-trip format | component | `openspec/specs/cli/spec.md` |
| IaC resources project onto the existing call-graph primitives | component¹ | `openspec/specs/analyzer/spec.md` |
| EdgeStore uses SCHEMA_VERSION rebuild-on-bump instead of migrations | component | `openspec/specs/analyzer/spec.md` |
| BM25 keyword retrieval is the zero-network floor; embeddings optional | component | `openspec/specs/analyzer/spec.md` |
| North star: a deterministic structural context substrate for agents | system | `openspec/specs/overview/spec.md` + `openspec/decisions/adr-0001-*.md` |
| The default MCP surface is the lean navigation preset, not all 67 tools (Spec 14 / ADR-0022) | component | `openspec/specs/cli/spec.md` |

¹ recorded as `cross-domain` but the consolidator re-scoped it to `component`.

## Proof the gate works (block → pass)

With the nav-preset decision `verified` but not yet approved, a commit is **blocked**:

```
$ git commit -m "..."
{ ... "gated": true, "reason": "verified", ... }   # openlore decisions --gate → exit 1
```

After `openlore decisions --approve <id>` + `--sync`, the same commit **passes** (gate exits 0).
(Verbatim transcript captured during the run — see the PR description.)

## Rough edges surfaced (dogfooding findings)

Dogfooding is supposed to find these. Two were real bugs (now **fixed in this PR**); one turned
out to be intended behavior.

1. **Concurrent `record_decision` calls raced on `pending.json` — FIXED.** Each `record_decision`
   spawns a detached `decisions --consolidate`; under rapid recording, overlapping consolidations
   each did a load → mutate → save and the later save clobbered the earlier, silently losing
   decisions (5 rapid records → only 3 stored). Fixed with a cross-process lock
   ([`src/core/decisions/lock.ts`](../../src/core/decisions/lock.ts)) that serializes consolidation
   and **re-reads the store inside the lock**, so no draft is lost. Verified by re-running the
   repro: 5 rapid records now yield 5/5 stored. Covered by `lock.test.ts`.
2. **Synced ADRs were gitignored — FIXED.** `--sync` writes ADRs to `openspec/decisions/`, but a
   blanket `openspec/` rule in `.gitignore` silently excluded them — the system's own output
   couldn't be committed. Fixed by narrowing the rule to keep `openspec/decisions/` committable.
   *Follow-up candidate:* `openlore setup` could assert its synced-output paths aren't gitignored.
3. **`--sync` empties the active store — this is by design, not a bug.** After syncing,
   `openlore decisions --list` shows nothing because synced decisions are intentionally purged from
   the working store (`purgeInactiveDecisions` treats `synced` as inactive, with explicit tests):
   the permanent record is the synced spec section + ADR, not the store. The store is a *pending*
   queue, not an audit log. Worth noting as a UX sharp edge (you must read the specs/ADRs to see
   what was decided); a future `--history` view could surface synced decisions without changing the
   purge semantics.

## Reproduce

```bash
# provider (one-time, this repo): set generation.provider = "claude-code" in .openlore/config.json
# 1. record (agent / MCP):  record_decision({...})
# 2. openlore decisions --consolidate     # verify drafts (auto-runs in background on record)
# 3. openlore decisions --approve <id>
# 4. openlore decisions --sync            # → openspec/specs/*.md + openspec/decisions/adr-*.md
# gate (installed):  openlore decisions --gate   # exit 1 while any decision awaits review
```
