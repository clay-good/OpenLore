/**
 * shrink-traversal-index-invalidation-scope — the watcher graph-write guard.
 *
 * The persisted traversal structure is keyed to `context.graphDigest`, a digest of
 * the GRAPH rather than the artifact bytes. That makes an incremental flush that
 * only touches signatures leave the structure valid — but it is sound ONLY while the
 * watcher never changes the graph without recomputing the digest. Today the watcher
 * never assigns `context.callGraph` at all (it patches `signatures`), so the digest
 * stays correct across every flush.
 *
 * This is a source scan, not a runtime test: the invariant is structural, and the
 * hazard is a FUTURE lane that starts mutating the graph. It fails CI the moment a
 * watcher write path assigns `context.callGraph` without a matching `graphDigest`
 * recompute in the same file — mirroring the `artifact-write-atomicity.test.ts`
 * writer-adoption pattern.
 *
 * Guards analyzer-spec requirement TraversalStructureIsKeyedToTheGraphItDescribes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), 'utf-8');

const WATCHER = 'core/services/mcp-watcher.ts';

// An assignment to `.callGraph` (LHS), not a read (`= context.callGraph`), not an
// equality check, and not an arrow. `\.callGraph\s*=(?![=>])` matches `x.callGraph =`
// but not `= x.callGraph;`, `.callGraph)`, `.callGraph === …`, or `.callGraph =>`.
const CALLGRAPH_ASSIGN = /\.callGraph\s*=(?![=>])/g;
const GRAPH_DIGEST_RECOMPUTE = /graphDigest\s*\(/g;

describe('shrink-traversal-index-invalidation-scope: a watcher graph-write recomputes the digest', () => {
  it('every watcher assignment to context.callGraph is matched by a graphDigest recompute', () => {
    const src = read(WATCHER);
    const assigns = src.match(CALLGRAPH_ASSIGN) ?? [];
    const recomputes = src.match(GRAPH_DIGEST_RECOMPUTE) ?? [];
    // With zero graph assignments the invariant holds by construction (0 <= 0). A new
    // lane that assigns the graph without recomputing the digest trips this.
    expect(recomputes.length).toBeGreaterThanOrEqual(assigns.length);
  });

  it('persistContext states the load-bearing invariant so it is not silently dropped', () => {
    const src = read(WATCHER);
    const persist = src.slice(src.indexOf('private async persistContext'));
    const body = persist.slice(0, persist.indexOf('\n  }'));
    expect(body).toMatch(/graphDigest/);
    expect(body).toMatch(/never changes the graph|never assigns\b|MUST recompute/);
  });
});
