# mcp-security spec delta

## ADDED Requirements

### Requirement: ViewServerCanonicalizesPathsBeforeServing

The `openlore view` HTTP server SHALL canonicalize (`realpath`) both the project root and any
requested file target before its containment check, so a symlink inside a cloned repo cannot
cause it to serve a file outside the project root. Directory traversal that concatenates spec
files SHALL skip symlinks (`lstat`) and SHALL cap total output size. This is the same
symlink-aware confinement the MCP handlers already enforce.

#### Scenario: A symlink in a cloned repo cannot exfiltrate a file

- **GIVEN** a cloned repo containing a symlink whose target is outside the project root
- **WHEN** a viewer endpoint is asked to serve that path (or traverses a symlinked spec
  directory)
- **THEN** the request is rejected / the symlink skipped; no out-of-repo content is served
