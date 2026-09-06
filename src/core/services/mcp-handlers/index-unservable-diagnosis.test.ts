/**
 * An unservable index must say WHY, not report absence.
 *
 * `readCachedContext` already distinguishes these cases — it emits a different telemetry
 * `reason` for each — and then returns a bare `null`, so every caller collapsed them into
 * "No analysis found. Run analyze_codebase first."
 *
 * That message is correct for exactly one of them. For the others it reports a FAILED
 * INTEGRITY CHECK as a missing index, which is the quiet downgrade `loadPartialFirstRun`'s
 * own docstring says this lane exists to prevent — and it hides the incident: a user reads
 * "no analysis", runs analyze, it works, and a lost publish is never reported.
 *
 * The generation-mismatch case here is not hypothetical. It was observed on a real
 * repository: artifacts rewritten at 23:36 against a manifest published at 23:33, four of
 * five recorded hashes no longer matching, no writer running, and every tool call answering
 * "No analysis found" for five minutes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseIndexUnservable } from './utils.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';

let root: string;
let analysisDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-unservable-'));
  analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(analysisDir, { recursive: true });
});

afterEach(async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

/**
 * Publish a coherent generation.
 *
 * Every REQUIRED artifact is written, because the diagnosis reads the manifest with the same
 * required set the real serving path does. A fixture that published only llm-context.json
 * would make `readCurrentGeneration` answer null for a reason the production path never
 * hits, and the test would then assert a diagnosis for a situation that cannot occur.
 */
async function publish(contents: string): Promise<void> {
  const { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } = await import('../../runtime/analysis-generation.js');
  for (const name of REQUIRED_ANALYSIS_ARTIFACTS) {
    await writeFile(join(analysisDir, name), name === ARTIFACT_LLM_CONTEXT ? contents : '{}', 'utf-8');
  }
  await publishGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
}

describe('diagnoseIndexUnservable', () => {
  it('reports a genuinely absent index as absent, with the message that was always right', async () => {
    const { reason, message } = await diagnoseIndexUnservable(root);

    expect(reason).toBe('absent');
    // The first-run case is the ONE the old wording fitted; it must not regress into
    // something more alarming than the situation.
    expect(message).toContain('No analysis found');
  });

  it('distinguishes an index whose artifacts no longer match its published generation', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    // Exactly the observed failure: rewrite the artifact WITHOUT republishing the manifest.
    await writeFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ signatures: [{}] }), 'utf-8');

    const { reason, message } = await diagnoseIndexUnservable(root);

    expect(reason).toBe('generation-mismatch');
    // The distinction that matters to a human: something WENT WRONG, versus something was
    // never set up. Asserting the absence of the misleading sentence is the point of the test.
    expect(message).not.toContain('No analysis found');
    expect(message).toMatch(/does NOT match its published generation/);
    expect(message).toMatch(/worth reporting/);
  });

  it('distinguishes an index whose generation manifest is present but refused', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    const manifest = join(analysisDir, 'generation.json');
    expect(await readFile(manifest, 'utf-8')).toBeTruthy();
    // Malformed, NOT deleted. An ABSENT manifest is a legitimate legacy analysis that
    // `readCurrentGeneration` synthesizes a generation for, so it never reaches this
    // diagnosis — a test that deleted the file would assert a case that cannot occur, and
    // the first draft of this test did exactly that.
    await writeFile(manifest, 'not json', 'utf-8');

    const { reason, message } = await diagnoseIndexUnservable(root);

    expect(reason).toBe('generation-unavailable');
    expect(message).not.toContain('No analysis found');
    expect(message).toMatch(/damaged publish, not a missing index/);
  });

  it('treats an absent manifest as a legacy analysis, not as damage', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rm(join(analysisDir, 'generation.json'), { force: true });

    // The synthesized legacy generation still vouches for the artifacts, so the honest
    // answer is that the index is present and coherent — not that a publish was lost.
    const { reason } = await diagnoseIndexUnservable(root);

    expect(reason).toBe('unreadable');
  });

  it('never invents a diagnosis it did not observe', async () => {
    // A published, coherent index that some OTHER read failed on must not be reported as a
    // mismatch — the honest answer is that it is present, matches, and could not be loaded.
    await publish(JSON.stringify({ signatures: [], callGraph: null }));

    const { reason } = await diagnoseIndexUnservable(root);

    expect(reason).toBe('unreadable');
  });
});
