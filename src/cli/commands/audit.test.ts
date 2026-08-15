import { describe, expect, it } from 'vitest';
import { formatMappingCoverageStatus } from './audit.js';
import type { AuditReport } from '../../types/index.js';

function report(
  mappingCoverage: AuditReport['mappingCoverage'],
  summary?: Partial<AuditReport['summary']>,
): AuditReport {
  return {
    generatedAt: new Date(0).toISOString(),
    mappingCoverage,
    summary: {
      totalFunctions: 4, coveredFunctions: null, coveragePct: null, uncoveredCount: null,
      hubGapCount: null, orphanRequirementCount: null, staleDomainCount: 0,
      ...summary,
    },
    uncoveredFunctions: [], hubGaps: [], orphanRequirements: [], staleDomains: [],
  };
}

describe('formatMappingCoverageStatus', () => {
  it('renders unavailable coverage with its reason and a refresh hint', () => {
    const lines = formatMappingCoverageStatus(report({
      state: 'unavailable', reason: 'fingerprint-mismatch',
      message: 'mapping does not match analysis',
      remediation: 'Run `openlore mapping refresh`.', artifactPath: '/repo/.openlore/analysis/mapping.json',
    }));
    expect(lines.join('\n')).toContain('unavailable (fingerprint-mismatch)');
    expect(lines.join('\n')).toContain('Refresh:        Run `openlore mapping refresh`.');
    expect(lines.join('\n')).not.toContain('0%');
  });

  it('renders an observed zero as a real numeric count, not as unavailable', () => {
    const lines = formatMappingCoverageStatus(report(
      { state: 'available', artifactPath: '/repo/.openlore/analysis/mapping.json' },
      { coveredFunctions: 0, coveragePct: 0, uncoveredCount: 4 },
    ));
    expect(lines.join('\n')).toBe('Coverage:       0% (0/4 functions)');
  });
});
