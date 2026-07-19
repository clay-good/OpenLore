# Tasks — wire the global --config path

## Implementation
- [x] config-manager: `resolveOpenLoreConfigPath(rootPath)` single source of truth + process-scoped
      override (`setPrimaryConfigPath` / `clearPrimaryConfigPath`), keyed to the resolved primary root
- [x] Route `readOpenLoreConfig` / `writeOpenLoreConfig` / `openloreConfigExists` through the resolver
- [x] Route the two direct readers (`doctor.ts` config + schema checks; `cold-start-bootstrap.ts`)
      through the resolver
- [x] index.ts preAction: set the override when `--config` is CLI-sourced and readable

## Verification
- [x] `--config <readable-elsewhere>` is actually read (unit: resolver returns override for the
      primary root, default for a peer path)
- [x] No `--config` → override never set, default path resolves unchanged
- [x] A peer/federation read (different root) is never redirected
- [x] e2e: `--config /custom.json enforce` honors the custom policy
- [x] Full suite green

## Spec
- [x] `cli` delta: ADD ExplicitConfigPathIsHonored
