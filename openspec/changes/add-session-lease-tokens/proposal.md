# Session lease tokens: portable proof that what an agent read is still current

> Status: PROPOSED (2026-11-01). Split from `add-session-ledger-runs-contracts-tokens`, whose
> test-run fact shipped.

## Why

A sub-agent, or the same agent after a pause, has no portable way to ask "is what my parent read
still current?". The session ledger knows what was served and its hashes, but only inside the
serving process. Contract elements and IaC resources are not tracked at all.

## What changes

| Part | What it does |
|------|--------------|
| Canonical hashes | contract elements (OpenAPI operations) and IaC resources are tracked in the ledger with SHA-256 over their parsed, sorted fields, so a reformat is not a change and a changed field is |
| `leaseToken` | `orient` and `recall` return a token for the (address, hash) set they served, resolvable from any process on the clone while the session lives |
| `lease-current` | a `verify_claim` kind: confirmed when every entry still matches, refuted listing changed entries, unverifiable for an unknown or expired token |
| Session counts | `openlore status --json`: body-only, signature-changed, exports, contract elements, IaC resources — counts, no percentage or threshold |

## Not built

Scores or budgets over the counts; lease tokens across clones.

## Impact

- Specs: `mcp-handlers` — 3 ADDED.
