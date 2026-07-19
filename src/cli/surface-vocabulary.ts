/**
 * Translate MCP-surface vocabulary into CLI-surface vocabulary.
 *
 * The conclusion handlers (clone-query, error-propagation, env-impact, …) are
 * shared by the MCP tools and their CLI mirror commands. Their not-found / stale
 * hints name the MCP tool a human would re-run to refresh the index —
 * `analyze_codebase`. On the CLI that tool name does not exist; the equivalent a
 * user actually runs is `openlore analyze`. A CLI hint that names an MCP tool
 * sends the reader to a command that isn't there.
 *
 * CLI output refers to CLI commands, MCP output refers to MCP tools
 * (OutputContractsAreUniform, change: fix-cli-output-hygiene). CLI command
 * modules pass every handler-produced hint / error / boundary string through
 * here before printing.
 */

/** MCP tool name (word-bounded) → the CLI invocation that does the same thing. */
const MCP_TO_CLI: ReadonlyArray<readonly [RegExp, string]> = [
  [/\banalyze_codebase\b/g, 'openlore analyze'],
];

/** Rewrite MCP tool names in a handler-produced string to their CLI equivalents. */
export function toCliVocabulary(text: string): string {
  let out = text;
  for (const [pattern, replacement] of MCP_TO_CLI) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
