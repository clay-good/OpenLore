/**
 * OpenLore-owned commands persist source-bearing LLM request logs only by
 * explicit opt-in (change: harden-llm-log-and-telemetry-honesty).
 */
export function isLlmLoggingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env['OPENLORE_LLM_LOGS'] === '1';
}
