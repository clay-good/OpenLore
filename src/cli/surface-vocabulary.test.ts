/**
 * The CLI surface must name CLI commands, never MCP tool names, in the hints it
 * relays from shared conclusion handlers (OutputContractsAreUniform, change:
 * fix-cli-output-hygiene).
 */

import { describe, it, expect } from 'vitest';
import { toCliVocabulary } from './surface-vocabulary.js';

describe('toCliVocabulary', () => {
  it('rewrites the analyze_codebase MCP tool name to `openlore analyze`', () => {
    expect(toCliVocabulary('No analysis found. Run analyze_codebase first.')).toBe(
      'No analysis found. Run openlore analyze first.',
    );
    expect(toCliVocabulary('re-run analyze_codebase after edits.')).toBe(
      're-run openlore analyze after edits.',
    );
  });

  it('leaves text without MCP tool names unchanged', () => {
    const s = 'Did you mean one of these? Pass name::path to disambiguate.';
    expect(toCliVocabulary(s)).toBe(s);
  });

  it('translated hints contain no bare MCP tool name', () => {
    const hints = [
      'No analysis found. Run analyze_codebase first.',
      'Call graph not available. Re-run analyze_codebase.',
      'If the code is new, run analyze_codebase — or use `snippet` mode.',
    ];
    for (const h of hints) {
      expect(toCliVocabulary(h)).not.toMatch(/\banalyze_codebase\b/);
      expect(toCliVocabulary(h)).toContain('openlore analyze');
    }
  });
});
