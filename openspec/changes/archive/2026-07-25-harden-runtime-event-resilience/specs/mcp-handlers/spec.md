# mcp-handlers spec delta

## ADDED Requirements

### Requirement: WatcherErrorEventsNeverKillTheHost

Every filesystem watcher the MCP watcher registers — the source watcher and the `.git` ref
watcher alike — SHALL have an `'error'` listener attached at registration, so an asynchronous
watcher error can never surface as an unhandled `'error'` event and terminate the long-lived
host process (the serve daemon or the stdio MCP server). On a watcher error the system SHALL
disclose the failure once at debug level, release the failed watcher, and degrade to the
documented fallback (batch-size VCS-flood detection for the `.git` watcher) — continuing to
serve tool calls throughout.

#### Scenario: A .git watch error degrades instead of crashing

- **GIVEN** a running serve daemon whose `.git` ref watcher emits an asynchronous `'error'`
  (FD pressure, a locked `.git/index`, ref churn during a rebase)
- **WHEN** the error event fires
- **THEN** the process stays alive, a single debug-level disclosure is emitted, VCS-flood
  detection falls back to the batch-size threshold, and subsequent file changes are still
  indexed

#### Scenario: A new watcher cannot ship without an error listener

- **GIVEN** a watcher registration in a long-lived path that attaches no `'error'` listener
- **WHEN** the error-listener coverage test runs
- **THEN** the test fails naming the uncovered registration site
