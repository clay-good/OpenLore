# cli spec delta

## ADDED Requirements

### Requirement: PiToolResultsCarryTheAfterEditReceipt

The Pi extension SHALL append the after-edit receipt to the result of Pi's `edit`, `write`,
`bash`, and `powershell` tools in an OpenLore project, computed by `openlore hook after-tools` in a
node child process so that no analyzer loads in the Pi process, and SHALL keep the tool's
machine-readable result. A refused edit, another tool, a nested call, `json` or `print` mode, a
silent hook, a failure, an abort, or a 20-second timeout SHALL leave the tool result unchanged.

#### Scenario: A Pi edit of a generated file

- **GIVEN** a Pi session with OpenLore's extension and a generated file `src/gen.ts`
- **WHEN** Pi's `edit` tool changes `src/gen.ts`
- **THEN** the tool result the agent reads ends with the receipt naming `src/gen.ts` as generated

#### Scenario: Unrelated tools are untouched

- **GIVEN** a Pi `read` tool result
- **WHEN** the extension sees it
- **THEN** the result is unchanged and no child process runs
