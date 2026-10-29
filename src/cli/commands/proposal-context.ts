/** Concise instruction injected when a supported OpenSpec proposal workflow starts. */
export const OPENSPEC_PROPOSAL_CONTEXT = [
  '[OpenLore proposal preparation]',
  'Before drafting: recover the requested outcome, decisions the user explicitly accepted,',
  'constraints, and unresolved questions from the conversation. Exploration and assistant',
  'suggestions are not user decisions. If there is no actionable request, ask one focused',
  'clarification and create no proposal files. Otherwise call openlore_orient with the brief,',
  'then draft using its structural evidence. Preserve unresolved options; disclose if orientation',
  'is unavailable.',
].join(' ');

const EXPLICIT_PROPOSE_COMMAND = /(?:^|\s)\/(?:opsx|openspec)(?::|-)propose\b|(?:^|\s)\/propose\b|(?:^|\s)(?:openspec|opsx)\s+propose\b/i;

/**
 * Detect explicit OpenSpec proposal commands. Pi may pass an expanded skill prompt rather than
 * the original slash command, so also recognize a narrowly phrased OpenSpec change-authoring task.
 */
export function isOpenSpecProposalInvocation(prompt: string): boolean {
  const text = (prompt ?? '').trim();
  if (!text) return false;
  if (EXPLICIT_PROPOSE_COMMAND.test(text)) return true;
  return /\bopenspec\b/i.test(text)
    && /\b(?:create|draft|write)\b[\s\S]{0,100}\b(?:change proposal|proposal|change)\b/i.test(text)
    && /\b(?:new|proposed?)\b/i.test(text);
}

export function proposalContextForPrompt(prompt: string): string | undefined {
  return isOpenSpecProposalInvocation(prompt) ? OPENSPEC_PROPOSAL_CONTEXT : undefined;
}
