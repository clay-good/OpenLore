/**
 * Deterministic standing-context measurement for MCP tool surfaces.
 *
 * `utf8-bytes-div-4-v1` is deliberately an approximation, not a claim about a
 * provider-specific tokenizer. It is dependency-free, offline, and stable: v1
 * serializes the exact `tools/list` result object served to clients, then rounds
 * UTF-8 bytes up at four bytes per estimated token. Changing either the wire
 * projection or arithmetic requires a new version and reviewed baselines.
 *
 * change: bound-standing-context-cost
 */

export const STANDING_CONTEXT_TOKENIZER = 'utf8-bytes-div-4-v1' as const;

export interface StandingContextTool {
  name: string;
  description: string;
  inputSchema: unknown;
  [key: string]: unknown;
}

export interface StandingContextBudget {
  baselineTokens: number;
  maxTokens: number;
  rationale: string;
}

export interface ToolListPayload {
  tools: Array<StandingContextTool & { annotations: unknown }>;
}

/** Construct the exact result shared by the live `tools/list` handler and CI. */
export function buildToolListPayload<T extends StandingContextTool, A>(
  tools: readonly T[],
  annotationsFor: (toolName: string) => A,
): { tools: Array<T & { annotations: A }> } {
  return {
    tools: tools.map((tool) => ({
      ...tool,
      annotations: annotationsFor(tool.name),
    })),
  };
}

/** Serialize the exact live result in its deterministic registry order. */
export function serializeToolListPayload(payload: ToolListPayload): string {
  return JSON.stringify(payload);
}

/** Estimate an exact `tools/list` result without a model call or network. */
export function measureStandingContextTokens(payload: ToolListPayload): number {
  return Math.ceil(Buffer.byteLength(serializeToolListPayload(payload), 'utf8') / 4);
}

/** Fail with the review receipt needed to diagnose a budget regression. */
export function assertStandingContextBudget(
  preset: string,
  measuredTokens: number,
  budget: StandingContextBudget,
): void {
  if (measuredTokens <= budget.maxTokens) return;
  throw new Error(
    `Standing context budget exceeded for preset "${preset}": measured ` +
    `${measuredTokens} tokens, budget ${budget.maxTokens}. Trim the surface or ` +
    'raise the budget with an explicit justification in the same reviewed change.',
  );
}
