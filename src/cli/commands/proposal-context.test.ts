import { describe, expect, it } from 'vitest';
import { isOpenSpecProposalInvocation, proposalContextForPrompt } from './proposal-context.js';

describe('OpenSpec proposal prompt detection', () => {
  it.each([
    '/opsx:propose',
    '/openspec:propose',
    '/opsx-propose',
    '/propose',
    'openspec propose',
    'Please draft a new OpenSpec change proposal',
    'OpenSpec task:\nCreate a new change proposal for this request',
  ])('recognizes %j', (prompt) => {
    expect(isOpenSpecProposalInvocation(prompt)).toBe(true);
    expect(proposalContextForPrompt(prompt)).toContain('[OpenLore proposal preparation]');
  });

  it.each([
    '',
    'What does propose mean in OpenSpec?',
    'Explore whether OpenSpec proposals should use orientation',
    'Draft a proposal for a meeting agenda',
    'OpenSpec: list existing changes',
  ])('ignores unrelated prompt %j', (prompt) => {
    expect(isOpenSpecProposalInvocation(prompt)).toBe(false);
    expect(proposalContextForPrompt(prompt)).toBeUndefined();
  });
});
