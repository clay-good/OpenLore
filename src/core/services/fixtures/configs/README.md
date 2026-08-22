# Frozen configuration compatibility fixtures

These files are immutable evidence of configuration shapes accepted by published OpenLore releases.
They intentionally do not move with the current schema.

- `2.0.0-default.json` captures the configuration factory shape from tag `v2.0.0`.
- `2.1.9-customized.json` captures the customized pre-2.2 shape reported in issue #386, including a
  missing `generation.domains` field that was accepted before strict validation.
- `2.2.0-default.json` captures the configuration factory shape from tag `v2.2.0`.

For each release, add at least one `<package-version>-*.json` fixture before changing the package
version. Include both a factory-default shape and a realistic customized shape when the release
changes configuration behavior. Never regenerate or edit an older fixture; add an explicit migration
when a frozen fixture stops loading.
