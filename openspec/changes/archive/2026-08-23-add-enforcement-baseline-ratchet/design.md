# Design: frozen enforcement baseline ratchet

## Goal

Let a repository adopt an enforcement code without accepting new debt. Existing findings become
reviewable frozen identities; later findings block, and fixed identities are removed permanently.
The design must never infer a clean result from an incomplete source or let a candidate enlarge an
already trusted baseline.

## Persisted model

`.openlore/enforcement-baseline.jsonl` is deterministic JSON Lines with one required version header:

```text
# OpenLore frozen enforcement baseline v1
["code","stale-decision-reference"]
["finding","stale-decision-reference","decision:aaaaaaaa","bbbbbbbb"]
```

The `code` record distinguishes an initialized zero-finding snapshot from a code that has never
been initialized. A finding identity is `code + subject + source-owned discriminator`; message text
and file lines are excluded. Records are unique, ASCII-safe, and sorted.

## Trust and mutation rules

| Surface | Trusted state | Allowed mutation |
|---|---|---|
| Ordinary `openlore enforce` | Committed `HEAD` baseline | Bootstrap a new frozen code; shrink an initialized code only after that exact source completes |
| `openlore enforce --hook` | Committed `HEAD` baseline | Produce a shrink after complete assessment, then block until the working tree and index agree |
| `openlore review --hook` | Selected protected base-tip baseline and policy | Read-only classification; report would-be shrink and direct the operator to local `enforce` |

For a code already initialized in trusted state, candidate growth and initialized-marker removal
are integrity failures. Records for unassessed, downgraded, or otherwise inactive codes must match
trusted state exactly. A new code may be bootstrapped only from an explicit frozen policy.

## Failure behavior

Frozen policy is an explicit guarantee, so malformed configuration, corrupt or oversized baseline
state, lock failure, unsafe paths, incomplete source analysis, and unverifiable Git state fail
closed for the affected gate. Existing baseline bytes remain untouched. Advisory and absent policy
retain their previous non-blocking behavior.

Reads use one no-follow file handle with byte caps. Writes are lock-serialized and atomic; the
`.openlore` directory identity is pinned across the critical section. Managed ignore rules expose
only `.openlore/config.json` and the baseline to normal Git staging, and Git verifies that a nested
ignore file did not override those exceptions.

## Public contract

`enforce --json` schema version 3 adds disjoint `new[]` and `frozen[]` receipts plus ratchet counts,
failed assessment codes, initialization, retirement, and staging state. `review --format json`
schema version 2 adds bounded blast-radius orphan enforcement evidence. The bundled Action remains
advisory unless `gate: true`; when gated, it posts the evidence before returning exit 3.

## Decisions

- `22d6e07e`: deterministic JSON-lines identity store
- `7efb9bb0`: explicit bootstrap and committed ratchet updates
- `fd318949`: fail closed when frozen state cannot be trusted
- `9bb217ba`: additive config schema version 1.1.0
- `15cc6a7e`: trust the selected base tip during PR review
