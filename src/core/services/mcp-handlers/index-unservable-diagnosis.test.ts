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
 *
 * A diagnosis that mislabels is worse than no diagnosis, so three of the cases below pin the
 * situations where the naive form of this check would confidently say the wrong thing: a
 * symlinked artifact (which the reader refuses but a path-following `stat` cannot see), a
 * healthy in-flight publish (whose sentinel manifest reads as "unavailable" BY DESIGN), and
 * the ordinary mid-write window (whose mismatch is expected, not an incident).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseIndexUnservable, _resetContextCacheForTesting, clearMappingCache } from './utils.js';
import { handleGetArchitectureOverview, handleGetRefactorReport } from './analysis.js';
import { acquireAnalysisLock } from '../../runtime/advisory-lock.js';
import { markGenerationUnavailable } from '../../runtime/analysis-generation.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
} from '../../../constants.js';

let root: string;
let analysisDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-unservable-'));
  analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(analysisDir, { recursive: true });
  _resetContextCacheForTesting();
  clearMappingCache();
});

afterEach(async () => {
  _resetContextCacheForTesting();
  clearMappingCache();
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

/** Rewrite the served artifact WITHOUT republishing — exactly the observed failure. */
async function rewriteWithoutRepublishing(): Promise<void> {
  await writeFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ signatures: [{}] }), 'utf-8');
}

describe('diagnoseIndexUnservable', () => {
  it('reports a genuinely absent index as absent, with the message that was always right', async () => {
    const result = await diagnoseIndexUnservable(root);

    expect(result.reason).toBe('index-absent');
    expect(result.notReady).toBe(true);
    // The first-run case is the ONE the old wording fitted; it must not regress into
    // something more alarming than the situation.
    expect(result.error).toContain('No analysis found');
    expect(result.remedy).toBe('openlore analyze');
  });

  it('distinguishes an index whose artifacts no longer match its published generation', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rewriteWithoutRepublishing();

    const result = await diagnoseIndexUnservable(root);

    expect(result.reason).toBe('index-generation-mismatch');
    // The distinction that matters to a human: something WENT WRONG, versus something was
    // never set up. Asserting the absence of the misleading sentence is the point of the test.
    expect(result.error).not.toContain('No analysis found');
    expect(result.error).toMatch(/does NOT match its published generation/);
    expect(result.error).toMatch(/worth reporting/);
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

    const result = await diagnoseIndexUnservable(root);

    expect(result.reason).toBe('index-generation-unavailable');
    expect(result.error).not.toContain('No analysis found');
    expect(result.error).toMatch(/present and was refused/);
  });

  it('treats an absent manifest as a legacy analysis, not as damage', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rm(join(analysisDir, 'generation.json'), { force: true });

    // The synthesized legacy generation still vouches for the artifacts, so the honest
    // answer is that the index is present and coherent — not that a publish was lost.
    const { reason } = await diagnoseIndexUnservable(root);

    expect(reason).toBe('index-unreadable');
  });

  it('never invents a diagnosis it did not observe', async () => {
    // A published, coherent index that some OTHER read failed on must not be reported as a
    // mismatch — the honest answer is that it is present, matches, and could not be loaded.
    await publish(JSON.stringify({ signatures: [], callGraph: null }));

    const { reason } = await diagnoseIndexUnservable(root);

    expect(reason).toBe('index-unreadable');
  });
});

/**
 * The reader refuses a symlinked artifact (`O_NOFOLLOW` plus a descriptor-identity check,
 * telemetry reason `artifact_not_a_regular_file`). A path-following `stat` in the diagnosis
 * cannot see that: it reports the TARGET, so a symlink to a perfectly good artifact would be
 * diagnosed as a lost publish, and a dangling one as an absent index. Both would be the exact
 * lie this whole change exists to remove, re-stated one layer up.
 */
describe('diagnoseIndexUnservable — the artifact the reader actually refused', () => {
  it('names a symlinked artifact as refused, not as a lost publish', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    // A symlink to a byte-for-byte VALID, generation-matching artifact. Everything a
    // path-following stat can see says "healthy"; the reader still refuses it.
    const real = join(root, 'elsewhere-llm-context.json');
    await writeFile(real, await readFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), 'utf-8'), 'utf-8');
    await rm(join(analysisDir, ARTIFACT_LLM_CONTEXT), { force: true });
    await symlink(real, join(analysisDir, ARTIFACT_LLM_CONTEXT));

    const result = await diagnoseIndexUnservable(root);

    expect(result.reason).toBe('index-unreadable');
    expect(result.error).toMatch(/not a regular file/);
    expect(result.error).toMatch(/symbolic link/);
  });

  it('names a dangling symlink as refused, not as an absent index', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rm(join(analysisDir, ARTIFACT_LLM_CONTEXT), { force: true });
    await symlink(join(root, 'nothing-here.json'), join(analysisDir, ARTIFACT_LLM_CONTEXT));

    const result = await diagnoseIndexUnservable(root);

    // "No analysis found" would send a user to run analyze and wonder why it kept failing.
    expect(result.reason).toBe('index-unreadable');
    expect(result.error).not.toContain('No analysis found');
  });
});

/**
 * `markGenerationUnavailable` writes a well-formed `{version, state:'publishing'}` manifest
 * BEFORE the first artifact replacement of a normal, healthy publish, and
 * `readCurrentGeneration` answers null for it by design. Calling that "a damaged publish"
 * would report the commit protocol working exactly as specified as a fault.
 */
describe('diagnoseIndexUnservable — a healthy publish in flight', () => {
  it('reports an in-progress publish as transient, not as damage', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await markGenerationUnavailable(analysisDir);

    const result = await diagnoseIndexUnservable(root);

    expect(result.reason).toBe('index-publish-in-progress');
    expect(result.error).toMatch(/publish is in progress/);
    expect(result.error).not.toMatch(/damaged/);
    // The remedy is to wait, not to rebuild an index that is being built right now.
    expect(result.remedy).toBe('retry shortly');
  });
});

/**
 * A writer updates artifacts in place and publishes the manifest LAST, so a mismatch is the
 * EXPECTED state throughout any concurrent analyze. Only the absence of a writer makes it an
 * incident — so the diagnosis asks the writer lock instead of asserting one.
 */
describe('diagnoseIndexUnservable — mismatch during an ordinary mid-write window', () => {
  it('reports a mismatch under a held analysis lock as an in-progress publish', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rewriteWithoutRepublishing();
    const release = await acquireAnalysisLock(analysisDir);
    try {
      const result = await diagnoseIndexUnservable(root);

      expect(result.reason).toBe('index-publish-in-progress');
      expect(result.error).toMatch(/expected mid-write window/);
      expect(result.error).not.toMatch(/publish was lost/);
    } finally {
      await release();
    }
  });

  it('reports the same mismatch with no writer as the incident it is', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rewriteWithoutRepublishing();

    // Identical on-disk artifacts as the case above; only the lock differs. That is the whole
    // claim: the mismatch alone never establishes an incident.
    const result = await diagnoseIndexUnservable(root);

    expect(result.reason).toBe('index-generation-mismatch');
    expect(result.error).toMatch(/No writer holds the analysis lock/);
    expect(result.error).toMatch(/publish was lost/);
  });
});

/**
 * Wiring, not diagnosis. Nothing else pins the handlers to the diagnosis, so a refactor could
 * quietly restore the flat sentence and every test above would still pass.
 */
describe('handlers serve the diagnosis, not the flat sentence', () => {
  it('handleGetArchitectureOverview carries the structured absent verdict on a first run', async () => {
    const result = await handleGetArchitectureOverview(root) as Record<string, unknown>;

    expect(result.notReady).toBe(true);
    expect(result.reason).toBe('index-absent');
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetArchitectureOverview names a lost publish instead of reporting absence', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rewriteWithoutRepublishing();
    // The overview answers from the dependency graph when it can, so this handler only
    // reaches the not-ready path when that artifact is gone too.
    await rm(join(analysisDir, ARTIFACT_DEPENDENCY_GRAPH), { force: true });

    const result = await handleGetArchitectureOverview(root) as Record<string, unknown>;

    expect(result.reason).toBe('index-generation-mismatch');
    expect(result.error).not.toContain('No analysis found');
  });

  it('handleGetRefactorReport names a lost publish instead of reporting absence', async () => {
    await publish(JSON.stringify({ signatures: [], callGraph: null }));
    await rewriteWithoutRepublishing();

    const result = await handleGetRefactorReport(root) as Record<string, unknown>;

    expect(result.notReady).toBe(true);
    expect(result.reason).toBe('index-generation-mismatch');
    expect(result.error).not.toContain('No analysis found');
  });

  it('handleGetRefactorReport keeps the first-run sentence for a first run', async () => {
    const result = await handleGetRefactorReport(root) as Record<string, unknown>;

    expect(result.reason).toBe('index-absent');
    expect(result.error).toContain('No analysis found');
  });
});
