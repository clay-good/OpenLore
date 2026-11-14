/** Shared agent-facing wire shape. The workflow still validates all untrusted input. */
const decision = { type: 'string', enum: ['include', 'exclude'] };
const patterns = { type: 'array', maxItems: 100, items: { type: 'string' } };
export const configurationCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Preview only. Start with existing selection.rules plus reviewed recommendation.rule values. Omit analysis to preserve existing include/exclude patterns. Not the inspection selection or a config document.',
  properties: {
    rules: {
      type: 'array',
      maxItems: 100,
      description:
        'Complete desired rule list; preserve existing rules unless the user approves replacing them.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' },
          pattern: {
            type: 'string',
            description: 'Repository-relative gitignore pattern, e.g. build-cache/.',
          },
          lanes: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: { index: decision, watch: decision, embed: decision },
          },
          reason: { type: 'string' },
          evidenceRefs: { type: 'array', maxItems: 16, items: { type: 'string' } },
        },
        required: ['id', 'pattern', 'lanes', 'reason'],
      },
    },
    reviewMode: { type: 'string', enum: ['manual', 'notify'] },
    analysis: {
      type: 'object',
      additionalProperties: false,
      properties: { includePatterns: patterns, excludePatterns: patterns },
    },
  },
  required: ['rules'],
};
