# architecture spec delta

## ADDED Requirements

### Requirement: EveryLongLivedSurfaceHasOneTeardownPath

Each surface that acquires process-lifetime resources — a file watcher, a graph-store handle, an
interval, a listening socket — SHALL expose exactly one teardown path, and every way that surface can
end SHALL route through it. A surface SHALL NOT acquire a resource whose handle keeps the process
alive beyond its own transport unless it also owns the signal that releases it. Where a teardown may
be missed, the handle SHALL be `unref`'d so the failure mode is an early exit rather than a process
that never exits.

This generalizes the lesson each surface has learned separately: `serve` grew an idle-timeout reaper
because orphaned daemons accumulated in RAM, and the stdio server exhibits the same accumulation
through a different door (stdin EOF). The requirement is on the shape, so a future surface inherits
it instead of rediscovering it.

#### Scenario: A new local surface cannot leak its watcher

- **GIVEN** a surface that starts a file watcher during request handling
- **WHEN** its transport closes
- **THEN** the watcher is stopped by the surface's single teardown path and the process exits

#### Scenario: A missed teardown degrades safely

- **GIVEN** a timer or watcher handle acquired by a surface whose transport has closed
- **WHEN** teardown does not run for that handle
- **THEN** the handle does not by itself keep the process alive, so the observable failure is an
  early exit rather than a hang
