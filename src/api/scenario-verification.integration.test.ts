import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreAnalyze } from './analyze.js';
import { openloreAudit } from './audit.js';
import { getDefaultConfig } from '../core/services/config-manager.js';

describe('scenario verification from a real analysis', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('traces a test to an exact spec anchor without claiming an assertion', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-scenario-e2e-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.openlore'), { recursive: true });
    await mkdir(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    await writeFile(join(root, 'src', 'pay.ts'),
      'export function chargeCard(): string { return "paid"; }\n');
    await writeFile(join(root, 'src', 'pay.test.ts'),
      'import { test, expect } from "vitest";\nimport { chargeCard } from "./pay.js";\nfunction checksCharge(): void { expect(chargeCard()).toBe("paid"); }\ntest("charge", checksCharge);\n');
    await writeFile(join(root, 'openspec', 'specs', 'billing', 'spec.md'),
      '## Requirements\n### Requirement: Charge\n**Implementation**: `chargeCard::src/pay.ts`\nThe system SHALL charge.\n#### Scenario: Paid\n- **WHEN** `chargeCard()` runs\n- **THEN** the `status` field is "paid"\n');
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify(getDefaultConfig('nodejs', 'openspec')));

    await openloreAnalyze({ rootPath: root, maxFiles: 20, quiet: true });
    const report = await openloreAudit({ rootPath: root, save: false });
    expect(report.scenarioVerification?.scenarios).toEqual([expect.objectContaining({
      domain: 'billing', label: 'verification-path-exists', checkability: 'checkable',
      tests: [expect.objectContaining({ file: 'src/pay.test.ts' })],
    })]);
    expect(report.scenarioVerification?.caveat).toContain('never that the test asserts');
  }, 120_000);
});
