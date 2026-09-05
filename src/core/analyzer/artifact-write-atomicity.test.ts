/**
 * harden-artifact-write-atomicity — the writer-adoption guard.
 *
 * The durability of the atomic-write helper and the analysis lock is proven by
 * `atomic-store.test.ts` (torn-write / rename atomicity) and `lock.test.ts`
 * (serialization / stale-steal). What this file guards is that the two artifact
 * WRITERS actually route through them — the spec's "one implementation, all
 * writers" requirement — so the guarantee can never silently regress to a bare
 * `writeFile` or a per-site inline `tmp + rename` on the largest, most-read
 * artifacts (`llm-context.json` and its siblings).
 *
 * A source scan, not a runtime test: the writers span a full analyze pipeline and
 * a live watcher, and the invariant we protect is structural — every persisted
 * artifact goes through `atomicWriteFile`, and each writer's artifact-mutation
 * section is fenced by `withAnalysisLock`. Plain `.test.ts` so CI runs it.
 *
 * Guards architecture-spec requirements ArtifactWritesAreAtomic and
 * ConcurrentArtifactWritersSerialize.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), 'utf-8');

// A bare `writeFile(` call. `atomicWriteFile(` uses a capital W, so this
// lowercase-w pattern never matches the shared helper — only an unguarded write.
const BARE_WRITE_FILE = /\bwriteFile\s*\(/g;
// A per-site inline `tmp + rename` — the discipline we consolidated into one home.
const INLINE_RENAME = /\brename\s*\(/g;

const ARTIFACT_GENERATOR = 'core/analyzer/artifact-generator.ts';
const WATCHER = 'core/services/mcp-watcher.ts';
const ANALYZE_COMMAND = 'core/analyzer/analysis-core.ts';

describe('harden-artifact-write-atomicity: every artifact writer adopts the shared discipline', () => {
  it('the analyze artifact generator writes only through atomicWriteFile — no bare writeFile', () => {
    const src = read(ARTIFACT_GENERATOR);
    expect(src).toMatch(/import\s*\{\s*atomicWriteFile\s*\}\s*from\s*['"]\.\.\/decisions\/atomic-store\.js['"]/);
    expect(src.match(BARE_WRITE_FILE)).toBeNull();
  });

  it('the analyze artifact generator fences its save-set with withAnalysisLock', () => {
    const src = read(ARTIFACT_GENERATOR);
    expect(src).toMatch(/import\s*\{\s*withAnalysisLock\s*\}\s*from\s*['"]\.\.\/runtime\/advisory-lock\.js['"]/);
    expect(src).toMatch(/withAnalysisLock\(\s*this\.options\.outputDir/);
  });

  it('the watcher persists every artifact through atomicWriteFile — no bare writeFile, no inline rename', () => {
    const src = read(WATCHER);
    expect(src).toMatch(/import\s*\{\s*atomicWriteFile\s*\}\s*from\s*['"]\.\.\/decisions\/atomic-store\.js['"]/);
    // Both the bare write and the inline tmp+rename sites are gone — one home now.
    expect(src.match(BARE_WRITE_FILE)).toBeNull();
    expect(src.match(INLINE_RENAME)).toBeNull();
    expect(src).not.toMatch(/\.tmp/);
  });

  it('the watcher fences SQLite and JSON as one change generation, plus the deletion lane', () => {
    const src = read(WATCHER);
    expect(src).toMatch(/import\s*\{\s*acquireAnalysisLock\s*\}\s*from\s*['"]\.\.\/runtime\/advisory-lock\.js['"]/);
    // Anchor to the CHANGE lane's own acquisition. The abandoned-events
    // disclosure lane (issue #451) also fences a stale marking and is defined
    // earlier in the file, so "the first acquire" no longer names this lane.
    const changeLane = src.indexOf('private async handleBatch');
    expect(changeLane).toBeGreaterThan(-1);
    const acquire = src.indexOf('acquireAnalysisLock(this.outputPath)', changeLane);
    const sqlite = src.indexOf('EdgeStore.open(EdgeStore.dbPath(this.outputPath))', acquire);
    const publication = src.indexOf('await this.republishGeneration()', sqlite);
    const release = src.indexOf('await releaseAnalysis()', publication);
    expect(acquire).toBeGreaterThan(-1);
    expect(sqlite).toBeGreaterThan(acquire);
    expect(publication).toBeGreaterThan(sqlite);
    expect(release).toBeGreaterThan(publication);
    // Change, deletion, bulk-fallback and abandoned-events lanes each fence
    // their SQLite writes.
    expect(src.match(/acquireAnalysisLock\(this\.outputPath\)/g)).toHaveLength(4);
  });

  it('persistContext itself stays lock-free (it runs inside a lane that already holds the lock)', () => {
    // A lock re-acquire inside persistContext would deadlock the lane that fences it.
    const src = read(WATCHER);
    const persist = src.slice(src.indexOf('private async persistContext'));
    const body = persist.slice(0, persist.indexOf('\n  }'));
    expect(body).toMatch(/atomicWriteFile\(this\.contextPath/);
    expect(body).not.toMatch(/withAnalysisLock|acquireAnalysisLock/);
  });

  it('holds one analysis lock from the first full-artifact write through generation publication', () => {
    const src = read(ANALYZE_COMMAND);
    const fence = src.indexOf('withAnalysisLock(outputPath');
    const artifactWrite = src.indexOf('generator.generateAndSave', fence);
    const dependencyWrite = src.indexOf('ARTIFACT_DEPENDENCY_GRAPH', artifactWrite);
    const fingerprintWrite = src.indexOf('ARTIFACT_FINGERPRINT', dependencyWrite);
    const publication = src.indexOf('publishGeneration(', fingerprintWrite);
    const fenceEnd = src.indexOf('\n  });', publication);

    expect(fence).toBeGreaterThan(-1);
    expect(artifactWrite).toBeGreaterThan(fence);
    expect(dependencyWrite).toBeGreaterThan(artifactWrite);
    expect(fingerprintWrite).toBeGreaterThan(dependencyWrite);
    expect(publication).toBeGreaterThan(fingerprintWrite);
    expect(fenceEnd).toBeGreaterThan(publication);
  });
});

/**
 * shrink-traversal-index-invalidation-scope — the structure is keyed to the graph.
 *
 * The read path used to decide currency by mtime ordering, which forced `analyze`
 * to write the structure strictly AFTER the context. That pre-check is gone: the
 * reader now compares the `graphDigest` carried in the context to the structure's
 * stamp, so write order no longer matters and the structure is written CONCURRENTLY
 * with the rest of the artifact set. These guards pin the two facts that keep the
 * new key sound at analyze time — the structure is stamped with the graph digest
 * (not the artifact bytes), and its write stays inside the analysis-lock fence.
 *
 * Guards analyzer-spec requirements ReachabilityStructureIsComputedAtAnalyzeTime and
 * TraversalStructureIsKeyedToTheGraphItDescribes.
 */
describe('shrink-traversal-index-invalidation-scope: the traversal structure is stamped with the graph digest', () => {
  it('stamps the context and the structure with the same graphDigest, not the artifact bytes', () => {
    const src = read(ARTIFACT_GENERATOR);
    // The graph digest is computed and written into the context…
    expect(src).toMatch(/graphDigest\(cg\)/);
    expect(src).toMatch(/artifacts\.llmContext\.graphDigest\s*=/);
    // …and the persisted structure is stamped with that same value.
    expect(src).toMatch(/writeTraversalIndexArtifact\([^)]*graphDigest/s);
    // The old artifact-bytes key is gone from the write path.
    expect(src).not.toMatch(/const\s+contextDigest\s*=/);
  });

  it('writes the structure concurrently in the saves set (no ordering constraint)', () => {
    const src = read(ARTIFACT_GENERATOR);
    // The structure write is now one of the concurrent saves, before the barrier.
    expect(src).toMatch(/saves\.push\([\s\S]*?writeTraversalIndexArtifact/);
    const push = src.indexOf('writeTraversalIndexArtifact(');
    const barrier = src.indexOf('await Promise.all(saves)');
    expect(push).toBeGreaterThan(-1);
    expect(barrier).toBeGreaterThan(push);
  });

  it('keeps the structure write inside the analysis-lock fence', () => {
    const src = read(ARTIFACT_GENERATOR);
    const fence = src.indexOf('withAnalysisLock(this.options.outputDir, persistAll)');
    const structureWrite = src.indexOf('writeTraversalIndexArtifact(');
    expect(fence).toBeGreaterThan(-1);
    expect(structureWrite).toBeGreaterThan(-1);
    expect(src.slice(structureWrite, fence)).toContain('const persistAll');
  });
});
