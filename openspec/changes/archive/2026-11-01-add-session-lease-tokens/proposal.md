# Session lease tokens: portable proof that what an agent read is still current

> Status: SHIPPED (2026-11-01). Contract/IaC hashes and session counts moved to
> `add-ledger-contract-hashes-and-counts`.

## Why

A sub-agent, or the same agent after a pause, had no portable way to ask "is what my parent read
still current?".

## What changes

| Part | What it does |
|------|--------------|
| `leaseToken` | `orient` and `recall` return `lt_…`, naming the symbols and files they served with their content hashes (symbol hashes from the index's hasher, whole-file hash for the rest), stored 12 hours in `.openlore/session-ledger/tokens/` |
| `lease-current` | a `verify_claim` kind: confirmed when everything still hashes the same; refuted naming each changed or removed entry; unverifiable for an unknown, pruned, malformed, or expired token |

An edit to an unserved symbol in the same file does not change the lease; a reformatted Markdown or
YAML file does not either.
