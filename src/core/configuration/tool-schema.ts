/** Shared agent-facing wire shape. The workflow still validates all untrusted input. */
const decision = (lane: string) => ({ type: 'string', enum: ['include', 'exclude'], description: `${lane} lane.` });
const patterns = (what: string) => ({ type: 'array', maxItems: 100, items: { type: 'string' }, description: `Globs ${what}.` });
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
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$', description: 'Stable rule id.' },
          pattern: {
            type: 'string',
            description: 'Repository-relative gitignore pattern, e.g. build-cache/.',
          },
          lanes: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            description: 'Last matching rule wins per lane.',
            properties: { index: decision('Index'), watch: decision('Live-watch'), embed: decision('Embedding (subset of index)') },
          },
          reason: { type: 'string', description: 'Why; shown to the reviewer.' },
          evidenceRefs: { type: 'array', maxItems: 16, items: { type: 'string' }, description: 'Supporting evidence ids from inspect.' },
        },
        required: ['id', 'pattern', 'lanes', 'reason'],
      },
    },
    reviewMode: { type: 'string', enum: ['manual', 'notify'], description: 'manual (default), or notify: idle review offers (needs host opt-in).' },
    analysis: {
      type: 'object',
      additionalProperties: false,
      description: 'Omit to keep the existing patterns.',
      properties: { includePatterns: patterns('to analyze'), excludePatterns: patterns('to skip') },
    },
  },
  required: ['rules'],
};
