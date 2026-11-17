# Contract consumers name the tests to run

> Status: SHIPPED (2026-11-01). A slice of `add-contract-graph-projection`.

## Why

A breaking contract change listed the in-repo call sites that use the operation, but not which
tests exercise them, so the agent still had to find what to run.

## What changes

With a base ref, each consumer of a `breaking` or `dangerous` change in `certify_service_contract`
carries the tests `select_tests` reaches from the indexed function holding the call (at most 5 listed,
`testsTotal`), or `testsNotComputed` with the reason (no index, a call outside any function, past
the cap of 20 consumer functions).

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
