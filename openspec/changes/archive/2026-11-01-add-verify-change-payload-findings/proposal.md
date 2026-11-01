# verify_change carries request-body findings

> Status: SHIPPED (2026-11-01). A slice of `add-contract-graph-projection`.

## Why

`contract-payload-missing-required` came only from `certify_service_contract`, which an agent runs
when it thinks of the contract. `verify_change` is the receipt it reads before it stops.

## What changes

`verify_change` runs the same check on call sites on lines the diff adds or changes, and in files not yet added to git (only those files are read): each finding is an
item (`contract_payload`), a classified finding (`enforcement.policy` may gate it), and a summary
count; bodies it could not read are one boundary line.

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
