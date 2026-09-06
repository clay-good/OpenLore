/**
 * Doc-claim sync guards (change: add-doc-claim-sync-guards).
 *
 * The honesty contract treats an unguarded published number as a defect
 * (`honesty-contract.test.ts` pins the README benchmark figures; `mcp-tool-count-doc.test.ts`
 * pins the "N tools" full-surface and preset-size counts to the code). This guard extends the
 * SAME discipline to the remaining quantitative doc claims that nothing bound to code:
 *
 *   1. The README language-count badge (and the docs/output.md call-graph note) must match the
 *      language sets in code — add a language and the badge must move, or CI fails.
 *   2. The "5500+ tests" floor is pinned to one canonical constant here; changing the published
 *      floor requires editing that constant in the same reviewed change. A floor stays a floor.
 *   3. Package metadata must not restate the retired pre-pivot product framing that contradicts
 *      the package `description` and the recorded north star (decision c6d1ad07).
 *
 * Scope note (tool count / preset sizes are NOT re-guarded here): those are already pinned by
 * `src/cli/commands/mcp-tool-count-doc.test.ts` (full surface → `TOOL_DEFINITIONS.length`; the
 * substrate/navigation preset sizes → their `TOOL_PRESETS` set sizes). This file guards the
 * claims that guard did not cover.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CODE_LANGUAGES } from './core/analyzer/language-support.js';
import { IAC_LANGUAGES, isIacLanguage } from './core/analyzer/iac/types.js';
import {
  DERIVED_ARTIFACT_EQUIVALENCE_MATRIX,
  SEMANTIC_ANSWER_PROJECTION,
} from './core/analyzer/derived-artifact-equivalence.js';
import { buildToolListPayload, measureStandingContextTokens, STANDING_CONTEXT_TOKENIZER } from './core/services/mcp-standing-cost.js';
import { STANDING_CONTEXT_BUDGETS, TOOL_DEFINITIONS, TOOL_PRESETS, toolAnnotations } from './cli/commands/mcp.js';

// src/<this> → repo root is one level up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Line endings normalised at the read. Git checks these docs out with CRLF on Windows, so an
// exact-match assertion against a `\n`-joined expectation compares the same content and fails
// on the separator alone. Every claim here is about content, never about line endings.
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');

// The badge reads "18 languages + 12 IaC". The "18" is the general-purpose code languages —
// NOT `CODE_LANGUAGES.length` (which is 20 because Terraform and Bicep are extension-detected
// code languages that ALSO belong to the IaC bucket). The IaC-overlapping members are counted
// in the "+ 12 IaC" half, so the code-language half derives from the non-IaC remainder. (This
// corrects the proposal's premise, which assumed the badge equals `CODE_LANGUAGES.length`.)
const CODE_LANG_COUNT = CODE_LANGUAGES.filter(l => !isIacLanguage(l)).length; // 18
const IAC_COUNT = IAC_LANGUAGES.length; // 12

// The minimum test count published as a floor. Not statically derivable (counting tests is
// fragile and would falsely pin a moving exact figure), so it is pinned here: change the
// published floor in any surface and this constant must move with it, in the same change.
// It is a FLOOR — published with a "+" suffix, never restated as a measured exact figure.
const MIN_TEST_FLOOR = 5500;

describe('doc-claim sync: standing MCP context costs are registry-bound', () => {
  const docs = read('docs/mcp-tools.md');
  const section = /<!-- standing-context-cost:start -->([\s\S]*?)<!-- standing-context-cost:end -->/.exec(docs)?.[1];
  const surfaces: Record<string, typeof TOOL_DEFINITIONS> = {
    ...Object.fromEntries(Object.entries(TOOL_PRESETS).map(([name, active]) => [
      name,
      TOOL_DEFINITIONS.filter((tool) => active.has(tool.name)),
    ])),
    full: TOOL_DEFINITIONS,
  };

  it('publishes the versioned approximation and every live measured value and budget', () => {
    expect(docs).toContain(STANDING_CONTEXT_TOKENIZER);
    expect(section, 'docs/mcp-tools.md must retain the guarded standing-context table').toBeDefined();
    const rows = [
      '| Preset | Tools | Measured tokens | Budget |',
      '|---|---:|---:|---:|',
    ];
    for (const [name, tools] of Object.entries(surfaces)) {
      const measured = measureStandingContextTokens(buildToolListPayload(tools, toolAnnotations)).toLocaleString('en-US');
      const budget = STANDING_CONTEXT_BUDGETS[name].maxTokens.toLocaleString('en-US');
      rows.push(`| \`${name}\` | ${tools.length} | ${measured} | ${budget} |`);
    }
    expect(section!.trim(), 'standing-context table must exactly match live surfaces, with no stale or duplicate rows')
      .toBe(rows.join('\n'));
  });

  it('documents both delivery faces without deprecating either one', () => {
    expect(docs).toMatch(/MCP and the command line are both first-class, supported delivery paths/i);
    expect(docs).toMatch(/zero standing context cost before invocation/i);
    expect(docs).toMatch(/neither supersedes or\s+deprecates the other/i);
  });
});

// Keywords / summaries that restate the retired "reverse-engineer specs from code" product,
// contradicting the package `description` ("Persistent architectural memory and structural
// cognition for AI coding agents") and the north-star decision c6d1ad07.
const RETIRED_FRAMING = ['reverse-engineering', 'spec-driven', 'documentation'];

describe('doc-claim sync: language counts track the code', () => {
  it('the README language badge matches the code/IaC language sets', () => {
    const readme = read('README.md');
    const line = readme.split('\n').find(l => l.includes('badge/languages-'));
    expect(line, 'expected a shields.io "badge/languages-" line in README.md').toBeDefined();

    // Badge slug: "languages-18%20%2B%2012%20IaC" → the two counts.
    const slug = /badge\/languages-(\d+)%20%2B%20(\d+)%20IaC/.exec(line!);
    expect(slug, `README language badge slug is not in the expected "languages-<N>%20%2B%20<M>%20IaC" form: ${line}`).not.toBeNull();
    const [badgeCode, badgeIac] = [Number(slug![1]), Number(slug![2])];
    expect(badgeCode, `README badge slug states ${badgeCode} code languages but the code set has ${CODE_LANG_COUNT} (non-IaC members of CODE_LANGUAGES)`).toBe(CODE_LANG_COUNT);
    expect(badgeIac, `README badge slug states ${badgeIac} IaC ecosystems but IAC_LANGUAGES has ${IAC_COUNT}`).toBe(IAC_COUNT);

    // Alt text: "18 languages + 12 IaC ecosystems" — must agree with the slug (and the code).
    const alt = /alt="(\d+) languages \+ (\d+) IaC/.exec(line!);
    expect(alt, `README language badge alt text is not in the expected "<N> languages + <M> IaC" form: ${line}`).not.toBeNull();
    expect(Number(alt![1]), `README badge alt text states ${alt![1]} languages but the code set has ${CODE_LANG_COUNT}`).toBe(CODE_LANG_COUNT);
    expect(Number(alt![2]), `README badge alt text states ${alt![2]} IaC but IAC_LANGUAGES has ${IAC_COUNT}`).toBe(IAC_COUNT);
  });

  it('the docs/output.md call-graph language count matches the code set', () => {
    const text = read('docs/output.md');
    // The call-graph.json row states "(18 languages: TS/JS, Python, …)".
    const m = /\((\d+) languages:/.exec(text);
    expect(m, 'expected a "(<N> languages: …)" call-graph note in docs/output.md').not.toBeNull();
    expect(Number(m![1]), `docs/output.md states ${m![1]} call-graph languages but the code set has ${CODE_LANG_COUNT}; update the count (and its enumeration) when a language is added`).toBe(CODE_LANG_COUNT);
  });
});

describe('doc-claim sync: the test-count floor is pinned to its guard', () => {
  const readme = read('README.md');

  it('the README tests badge states the canonical floor, as a floor', () => {
    const line = readme.split('\n').find(l => l.includes('badge/tests-'));
    expect(line, 'expected a shields.io "badge/tests-" line in README.md').toBeDefined();
    // "tests-5500%2B-success" — the %2B is the "+" that makes it a floor, not an exact figure.
    const m = /badge\/tests-(\d+)%2B/.exec(line!);
    expect(m, `README tests badge is not in the expected "tests-<N>%2B" (floor) form: ${line}`).not.toBeNull();
    expect(Number(m![1]), `README tests badge states ${m![1]}+ but the canonical floor is ${MIN_TEST_FLOOR}; update MIN_TEST_FLOOR in this guard to move the published floor`).toBe(MIN_TEST_FLOOR);
  });

  it('the README dev-instructions test count agrees with the same floor', () => {
    // "npm run test:run  # 5500+ unit tests, one-shot …"
    const m = /(\d+)\+ unit tests/.exec(readme);
    expect(m, 'expected a "<N>+ unit tests" note in the README build instructions').not.toBeNull();
    expect(Number(m![1]), `README build note states ${m![1]}+ unit tests but the canonical floor is ${MIN_TEST_FLOOR}; both README sites must agree with MIN_TEST_FLOOR`).toBe(MIN_TEST_FLOOR);
  });
});

describe('doc-claim sync: package metadata matches the recorded north star', () => {
  const pkg = JSON.parse(read('package.json')) as {
    description: string;
    keywords: string[];
    openspec: { summary: string };
  };

  it('the package description is the north-star anchor', () => {
    // The description is the fixed anchor the keywords/summary must not contradict.
    expect(pkg.description.toLowerCase()).toContain('architectural memory');
    expect(pkg.description.toLowerCase()).toContain('coding agents');
  });

  it('keywords do not restate the retired pre-pivot framing', () => {
    for (const retired of RETIRED_FRAMING) {
      expect(
        pkg.keywords.includes(retired),
        `package.json keyword "${retired}" restates the retired "reverse-engineer specs from code" product, contradicting the description and north star (c6d1ad07)`,
      ).toBe(false);
    }
  });

  it('the openspec.summary describes the substrate positioning, not the retired product', () => {
    expect(
      /reverse-engineer/i.test(pkg.openspec.summary),
      `package.json openspec.summary still restates the retired "reverse-engineer specs" framing: "${pkg.openspec.summary}"`,
    ).toBe(false);
  });
});

type CertifiedMeasurement = {
  operation: string;
  metric: string;
  value: number;
  unit: string;
  label: 'measured' | 'extrapolated';
  measuredAt: string;
  fixture: string;
  referenceEnvironment: string;
  sourceCommand: string;
  basis?: string;
  method?: string;
};

type CertifiedScaleManifest = {
  schemaVersion: number;
  projection: string;
  certifiedTier: {
    id: string;
    fixture: {
      id: string;
      source: string;
      dimensions: { files: number; sourceBytes: number; languages: number; expectedSymbols: number };
      label: 'measured' | 'extrapolated';
      measuredAt: string;
      referenceEnvironment: string;
      sourceCommand: string;
    };
    objectives: Record<string, { ceiling: number; unit: string }>;
  };
  referenceEnvironment: {
    id: string; platform: string; arch: string; osRelease: string; node: string;
    cpu: string; logicalCpus: number; totalMemoryBytes: number;
  };
  measurements: CertifiedMeasurement[];
  equivalence: { suite: string; projection: string; requiredRows: string[] };
  policy: { ci: string; beyondCertifiedTier: string };
};

const formatNumber = (value: number): string => value.toLocaleString('en-US', {
  useGrouping: true,
  maximumFractionDigits: 3,
});

describe('doc-claim sync: certified scale envelope is manifest-bound', () => {
  const manifest = JSON.parse(read('benchmarks/certified-scale-v1.json')) as CertifiedScaleManifest;
  const envelope = read('docs/performance-envelope.md');
  const requiredOperations = new Set(['cold', 'warm', 'edit', 'add', 'delete', 'rename', 'peak-memory']);

  it('has complete, uniquely labelled measurements with reproducible provenance', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.projection).toBe(SEMANTIC_ANSWER_PROJECTION);
    expect(new Set(manifest.measurements.map(({ operation }) => operation))).toEqual(requiredOperations);
    expect(manifest.measurements).toHaveLength(requiredOperations.size);
    expect(manifest.certifiedTier.fixture.label).toBe('measured');
    expect(manifest.certifiedTier.fixture.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.certifiedTier.fixture.referenceEnvironment).toBe(manifest.referenceEnvironment.id);
    expect(manifest.certifiedTier.fixture.sourceCommand).toBe('npm run measure:certified-scale');
    expect(read(manifest.certifiedTier.fixture.source)).toContain('certified-scale-typescript-v1');

    for (const measurement of manifest.measurements) {
      expect(Number.isFinite(measurement.value) && measurement.value > 0, `${measurement.operation} must have a positive observation`).toBe(true);
      expect(['measured', 'extrapolated'], `${measurement.operation} must be labelled measured or extrapolated`).toContain(measurement.label);
      expect(measurement.measuredAt, `${measurement.operation} lacks a measurement date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(measurement.fixture, `${measurement.operation} lacks fixture provenance`).toBe(manifest.certifiedTier.fixture.id);
      expect(measurement.referenceEnvironment, `${measurement.operation} lacks environment provenance`).toBe(manifest.referenceEnvironment.id);
      expect(measurement.sourceCommand, `${measurement.operation} lacks a source command`).toBe('npm run measure:certified-scale');
      if (measurement.label === 'extrapolated') {
        expect(measurement.basis, `${measurement.operation} extrapolation lacks a measured basis`).toBeTruthy();
        expect(measurement.method, `${measurement.operation} extrapolation lacks a method`).toBeTruthy();
      }
    }
  });

  it('keeps every certified observation within its declared objective', () => {
    const objectiveFor = (operation: string): { ceiling: number; unit: string } => {
      if (operation === 'cold') return manifest.certifiedTier.objectives.coldAnalyze;
      if (operation === 'warm') return manifest.certifiedTier.objectives.warmQuery;
      if (operation === 'peak-memory') return manifest.certifiedTier.objectives.peakMemory;
      return manifest.certifiedTier.objectives.singleFilePublication;
    };
    for (const measurement of manifest.measurements) {
      const objective = objectiveFor(measurement.operation);
      expect(measurement.unit, `${measurement.operation} unit must match its objective`).toBe(objective.unit);
      expect(measurement.value, `${measurement.operation} exceeds its certified objective`).toBeLessThanOrEqual(objective.ceiling);
    }
  });

  it('binds certification to the complete finite equivalence registry', () => {
    expect(manifest.equivalence.projection).toBe(SEMANTIC_ANSWER_PROJECTION);
    expect(new Set(manifest.equivalence.requiredRows)).toEqual(
      new Set(DERIVED_ARTIFACT_EQUIVALENCE_MATRIX.map(({ id }) => id)),
    );
    expect(manifest.equivalence.requiredRows).toHaveLength(DERIVED_ARTIFACT_EQUIVALENCE_MATRIX.length);
    expect(manifest.equivalence.suite).toBe('npm run test:equivalence');
  });

  it('publishes every fixture, objective, environment, and measurement figure from the manifest', () => {
    const { fixture, objectives } = manifest.certifiedTier;
    expect(envelope).toContain(manifest.certifiedTier.id);
    expect(envelope).toContain(fixture.id);
    for (const value of Object.values(fixture.dimensions)) expect(envelope).toContain(formatNumber(value));
    for (const objective of Object.values(objectives)) {
      expect(envelope).toContain(`${formatNumber(objective.ceiling)} ${objective.unit}`);
    }
    expect(envelope).toContain(manifest.referenceEnvironment.id);
    expect(envelope).toContain(manifest.referenceEnvironment.cpu);
    expect(envelope).toContain(`${manifest.referenceEnvironment.logicalCpus} logical CPUs`);
    expect(envelope).toContain(`${formatNumber(manifest.referenceEnvironment.totalMemoryBytes)} bytes`);

    for (const measurement of manifest.measurements) {
      const row = `| ${measurement.operation} | ${measurement.metric} | ${formatNumber(measurement.value)} ${measurement.unit} | ${measurement.label} |`;
      expect(envelope, `published envelope is missing the manifest row: ${row}`).toContain(row);
    }
  });

  it('states the honest beyond-tier and wall-clock policies', () => {
    expect(manifest.policy.beyondCertifiedTier).toBe('best-effort');
    expect(envelope).toMatch(/Beyond the certified tier[\s\S]*\*\*best-effort\*\*/);
    expect(envelope).toContain('does not treat machine-specific wall-clock observations as portable thresholds');
    expect(manifest.policy.ci).toContain('do not enforce checked-in wall-clock observations as portable thresholds');
  });
});

/**
 * Onboarding claims that name a number or a negative behavior (change:
 * unify-onboarding-entrypoint). Both are the shape this file exists for: a figure
 * that lives in a constant, and a promise nothing else would notice breaking.
 */
describe('onboarding claims stay bound to the code', () => {
  it('the docs auto-init ceiling matches the constant', async () => {
    const { AUTO_INIT_DEGRADED_FILE_CEILING } = await import('./constants.js');
    const docs = read('docs/install.md');
    const line = docs.split('\n').find(l => l.includes('AUTO_INIT_DEGRADED_FILE_CEILING'));
    expect(line, 'expected docs/install.md to name the ceiling constant').toBeDefined();
    expect(line).toContain(AUTO_INIT_DEGRADED_FILE_CEILING.toLocaleString('en-US'));
  });

  it('background auto-init installs no git hook', () => {
    // The spec scenario asserts a negative, so bind it to the code: the auto-init
    // build path runs `init` and `analyze` and nothing else, and neither the
    // bootstrap nor the analyze command may reach a hook installer.
    const bootstrap = read('src/core/services/cold-start-bootstrap.ts');
    expect(bootstrap).not.toMatch(/installPreCommitHook|wireGovernanceGate|hooks\//);
    const analyze = read('src/cli/commands/analyze.ts');
    expect(analyze).not.toMatch(/installPreCommitHook|wireGovernanceGate/);
    // And the argv the bootstrap spawns is exactly those two subcommands.
    const spawned = [...bootstrap.matchAll(/await run\(\[\s*'([a-z-]+)'/g)].map(m => m[1]);
    expect(new Set(spawned)).toEqual(new Set(['init', 'analyze']));
  });
});
