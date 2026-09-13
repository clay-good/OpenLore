/**
 * SARIF 2.1.0 transport for governance findings (change: add-sarif-finding-emission).
 *
 * A pure, deterministic serialization of the classified finding stream that `openlore enforce` and
 * `openlore review` already compute, so the findings can ride code-scanning surfaces (per-line PR
 * annotations, dismissal workflows, branch-protection gates). Transport, not policy: every finding
 * appears regardless of its enforcement class, which is recorded as a result property, and nothing
 * here changes what a command prints or its exit code.
 *
 * Honesty rules:
 * - A finding's recorded `location` becomes a SARIF physical location only when it is a
 *   repository-relative path; otherwise, and when no location was recorded, the result carries a
 *   logical location named by the subject. A line is never fabricated.
 * - No wall-clock content: the same findings, tool version, and graph produce a byte-identical log.
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { FINDING_CODE_REGISTRY, type ClassifiedFinding } from './mcp-handlers/enforcement-policy.js';
import { enforcementFindingIdentity } from './mcp-handlers/enforcement-baseline.js';

export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';

type SarifLevel = 'error' | 'warning' | 'note';

/** The fixed intrinsic-severity → SARIF level table. */
export const SARIF_LEVEL_BY_SEVERITY: Readonly<Record<ClassifiedFinding['severity'], SarifLevel>> = {
  critical: 'error',
  error: 'error',
  warning: 'warning',
  info: 'note',
};

export interface SarifInput {
  findings: readonly ClassifiedFinding[];
  toolVersion: string;
  /** The call-graph digest the findings were computed against, when an index is available. */
  graphFingerprint?: string;
  caveats?: readonly string[];
}

/** A repository-relative, forward-slash path, or undefined when the path is absolute or escapes the root. */
function repositoryRelativeUri(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
  if (normalized.split('/').some((part) => part === '..')) return undefined;
  return normalized;
}

function compareFindings(a: ClassifiedFinding, b: ClassifiedFinding): number {
  const keys = (f: ClassifiedFinding) => [f.code, f.subject, f.discriminator ?? '', f.location?.path ?? '', String(f.location?.line ?? ''), f.message];
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
}

/** Build a SARIF 2.1.0 log object from classified governance findings. Pure and deterministic. */
export function buildSarifLog(input: SarifInput): Record<string, unknown> {
  const ruleIds = Object.keys(FINDING_CODE_REGISTRY).sort();
  const extraIds = [...new Set(input.findings.map((f) => f.code))].filter((code) => !(code in FINDING_CODE_REGISTRY)).sort();
  const allIds = [...ruleIds, ...extraIds];
  const ruleIndex = new Map(allIds.map((id, index) => [id, index]));
  const rules = allIds.map((id) => {
    const spec = FINDING_CODE_REGISTRY[id];
    return {
      id,
      shortDescription: { text: spec?.description ?? 'Unregistered finding code.' },
      properties: { source: spec?.source ?? 'unregistered', defaultEnforcementClass: spec?.defaultClass ?? 'advisory' },
    };
  });
  const results = [...input.findings].sort(compareFindings).map((finding) => {
    const uri = finding.location ? repositoryRelativeUri(finding.location.path) : undefined;
    const location = uri
      ? {
          physicalLocation: {
            artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
            ...(finding.location?.line && finding.location.line > 0 ? { region: { startLine: finding.location.line } } : {}),
          },
        }
      : { logicalLocations: [{ fullyQualifiedName: finding.subject }] };
    const identity = createHash('sha256').update(JSON.stringify(enforcementFindingIdentity(finding))).digest('hex');
    return {
      ruleId: finding.code,
      ruleIndex: ruleIndex.get(finding.code),
      level: SARIF_LEVEL_BY_SEVERITY[finding.severity] ?? 'warning',
      message: { text: finding.message },
      locations: [location],
      partialFingerprints: { 'openloreFindingIdentity/v1': identity },
      properties: {
        enforcementClass: finding.enforcementClass,
        severity: finding.severity,
        source: finding.source,
        subject: finding.subject,
        ...(finding.discriminator ? { discriminator: finding.discriminator } : {}),
        ...(finding.baselineState ? { baselineState: finding.baselineState } : {}),
        ...(finding.remediation ? { remediation: finding.remediation } : {}),
      },
    };
  });
  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'openlore',
          version: input.toolVersion,
          informationUri: 'https://github.com/clay-good/OpenLore',
          rules,
        },
      },
      results,
      properties: {
        ...(input.graphFingerprint ? { graphFingerprint: input.graphFingerprint } : { graphFingerprint: null }),
        caveats: [...(input.caveats ?? [])],
      },
    }],
  };
}

/** The installed OpenLore version (from package.json, as the CLI reports it). */
export function openloreVersion(): string {
  try {
    return (createRequire(import.meta.url)('../../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The call-graph digest of the analyzed index at `cwd`, or undefined when none is available. */
export async function currentGraphFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const [{ readCachedContext }, { graphDigest }] = await Promise.all([
      import('./mcp-handlers/utils.js'),
      import('../analyzer/condensation.js'),
    ]);
    const ctx = await readCachedContext(cwd);
    return ctx?.callGraph ? graphDigest(ctx.callGraph as Parameters<typeof graphDigest>[0]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a SARIF log for a command's classified findings. Never throws: a write failure is returned
 * as a message for the caller to report, so the command's own output and exit code are unchanged.
 */
export async function writeSarifLog(path: string, cwd: string, findings: readonly ClassifiedFinding[], caveats: readonly string[]): Promise<string | undefined> {
  try {
    const log = buildSarifLog({ findings, toolVersion: openloreVersion(), graphFingerprint: await currentGraphFingerprint(cwd), caveats });
    await writeFile(path, JSON.stringify(log, null, 2) + '\n', 'utf-8');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
