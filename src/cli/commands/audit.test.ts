import { describe, expect, it } from 'vitest';
import { formatMappingCoverageStatus } from './audit.js';
import type { AuditReport } from '../../types/index.js';

function report(mappingCoverage: AuditReport['mappingCoverage']): AuditReport {
  return {
    generatedAt: new Date(0).toISOString(),
    mappingCoverage,
    summary: {
      totalFunctions: 4, coveredFunctions: 0, coveragePct: 0, uncoveredCount: 0,
      hubGapCount: 0, orphanRequirementCount: 0, staleDomainCount: 0,
    },
    uncoveredFunctions: [], hubGaps: [], orphanRequirements: [], staleDomains: [],
  };
}

describe('formatMappingCoverageStatus', () => {
  it('renders degraded coverage as unavailable with a refresh hint', () => {
    const lines = formatMappingCoverageStatus(report({
      state: 'stale', reason: 'fingerprint-mismatch',
      message: 'mapping does not match analysis',
      remediation: 'Run `openlore generate`.', artifactPath: '/repo/.openlore/analysis/mapping.json',
    }));
    expect(lines.join('\n')).toContain('unavailable (stale: fingerprint-mismatch)');
    expect(lines.join('\n')).toContain('Refresh:        Run `openlore generate`.');
    expect(lines.join('\n')).not.toContain('0%');
  });
});
