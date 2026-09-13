import { describe, it, expect } from 'vitest';
import { buildSarifLog, SARIF_LEVEL_BY_SEVERITY, SARIF_SCHEMA_URI, openloreVersion } from './sarif.js';
import { FINDING_CODE_REGISTRY, type ClassifiedFinding } from './mcp-handlers/enforcement-policy.js';

const finding = (over: Partial<ClassifiedFinding> = {}): ClassifiedFinding => ({
  code: 'cross-actor-conflict',
  severity: 'warning',
  source: 'interference-map',
  subject: 'feat-a × feat-b',
  message: 'Write-write conflict on foo — must not land concurrently.',
  enforcementClass: 'advisory',
  ...over,
});
type Run = { tool: { driver: { name: string; version: string; rules: Array<{ id: string; shortDescription: { text: string } }> } }; results: Array<Record<string, any>>; properties: Record<string, unknown> };
const runOf = (log: Record<string, unknown>) => (log.runs as Run[])[0];

describe('buildSarifLog (add-sarif-finding-emission)', () => {
  it('emits a SARIF 2.1.0 log with every registered code as a sorted rule', () => {
    const log = buildSarifLog({ findings: [], toolVersion: '9.9.9' });
    expect(log.$schema).toBe(SARIF_SCHEMA_URI);
    expect(log.version).toBe('2.1.0');
    const run = runOf(log);
    expect(run.tool.driver).toMatchObject({ name: 'openlore', version: '9.9.9' });
    const ids = run.tool.driver.rules.map((r) => r.id);
    expect(ids).toEqual(Object.keys(FINDING_CODE_REGISTRY).sort());
    expect(run.tool.driver.rules.find((r) => r.id === 'cross-actor-conflict')?.shortDescription.text).toBe(FINDING_CODE_REGISTRY['cross-actor-conflict'].description);
    expect(run.results).toEqual([]);
  });

  it('maps a located finding to a physical location with the message verbatim and the class as a property', () => {
    const run = runOf(buildSarifLog({
      findings: [finding({ code: 'export-removed', severity: 'error', source: 'public-surface', subject: 'src/a.ts::gone', message: 'removed of exported "gone" breaks rule export-removed', location: { path: 'src/a.ts', line: 12 } })],
      toolVersion: '1.0.0',
    }));
    const [result] = run.results;
    expect(result.ruleId).toBe('export-removed');
    expect(run.tool.driver.rules[result.ruleIndex].id).toBe('export-removed');
    expect(result.level).toBe('error');
    expect(result.message).toEqual({ text: 'removed of exported "gone" breaks rule export-removed' });
    expect(result.locations).toEqual([{ physicalLocation: { artifactLocation: { uri: 'src/a.ts', uriBaseId: '%SRCROOT%' }, region: { startLine: 12 } } }]);
    expect(result.properties).toMatchObject({ enforcementClass: 'advisory', severity: 'error', source: 'public-surface', subject: 'src/a.ts::gone' });
    expect(result.partialFingerprints['openloreFindingIdentity/v1']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never fabricates a line: no location, an absolute path, or an escaping path is a logical location only', () => {
    for (const location of [undefined, { path: '/etc/passwd' }, { path: '../outside.ts', line: 3 }, { path: 'C:\\x\\y.ts' }]) {
      const [result] = runOf(buildSarifLog({ findings: [finding({ location })], toolVersion: '1' })).results;
      expect(result.locations).toEqual([{ logicalLocations: [{ fullyQualifiedName: 'feat-a × feat-b' }] }]);
    }
    const [noLine] = runOf(buildSarifLog({ findings: [finding({ location: { path: 'src\\win.ts' } })], toolVersion: '1' })).results;
    expect(noLine.locations).toEqual([{ physicalLocation: { artifactLocation: { uri: 'src/win.ts', uriBaseId: '%SRCROOT%' } } }]);
  });

  it('maps every severity through the fixed level table and keeps unregistered codes as rules', () => {
    expect(SARIF_LEVEL_BY_SEVERITY).toEqual({ critical: 'error', error: 'error', warning: 'warning', info: 'note' });
    const run = runOf(buildSarifLog({ findings: [finding({ code: 'not-a-registered-code', severity: 'info' })], toolVersion: '1' }));
    expect(run.results[0].level).toBe('note');
    expect(run.tool.driver.rules[run.results[0].ruleIndex].id).toBe('not-a-registered-code');
  });

  it('is byte-identical for the same input regardless of finding order, with no wall-clock content', () => {
    const a = finding({ subject: 'b' });
    const b = finding({ subject: 'a', code: 'export-removed', severity: 'error' });
    const one = JSON.stringify(buildSarifLog({ findings: [a, b], toolVersion: '2', graphFingerprint: 'abc', caveats: ['c1'] }));
    const two = JSON.stringify(buildSarifLog({ findings: [b, a], toolVersion: '2', graphFingerprint: 'abc', caveats: ['c1'] }));
    expect(one).toBe(two);
    const run = runOf(JSON.parse(one));
    expect(run.properties).toEqual({ graphFingerprint: 'abc', caveats: ['c1'] });
    expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it('breaks result sort ties with every emitted finding field and sorts caveats', () => {
    const a = finding({ source: 'alpha', severity: 'info' });
    const b = finding({ source: 'beta', severity: 'warning' });
    const one = JSON.stringify(buildSarifLog({ findings: [a, b], toolVersion: '2', caveats: ['z', 'a'] }));
    const two = JSON.stringify(buildSarifLog({ findings: [b, a], toolVersion: '2', caveats: ['a', 'z'] }));
    expect(one).toBe(two);
  });

  it('reports the installed version', () => {
    expect(openloreVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
