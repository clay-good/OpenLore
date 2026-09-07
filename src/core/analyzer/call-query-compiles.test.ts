/**
 * The TS/JS call query must COMPILE against every grammar it is run on
 * (change: shrink-receiver-resolution-boundary).
 *
 * `TS_CALL_QUERY` is shared: `.ts`, `.tsx`, `.js` and `.jsx` all run the same source. If it fails
 * to compile — because a grammar upgrade renamed or removed a node type it names — `extractTSGraph`
 * returns `emptyForUnavailable(language)` and the ENTIRE TypeScript/JavaScript call graph
 * disappears, silently and repo-wide. Unlike the Python side, which uses a separate soft query
 * whose failure costs only the chained-receiver alternative, this one concentrates the blast
 * radius in a single string.
 *
 * This change added `private_property_identifier` to that query, so the risk is now this change's
 * to carry. The guard is a compile check per grammar, not a behavioural assertion: it fails loudly
 * in CI on the grammar bump that would otherwise empty the graph.
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';

const CALLER = 'run';
const CALLEE = 'save';

/** A file exercising every alternative of the shared query at once: a bare call, an identifier
 *  receiver, `this.`, `super.`, and both chained-receiver property forms. */
function fixture(): string {
  return `
    class Repo { ${CALLEE}(x) { return x; } }
    class Base { helper() { return 1; } }
    class Service extends Base {
      #priv = new Repo();
      constructor() { super(); this.repo = new Repo(); }
      ${CALLER}() {
        const local = new Repo();
        local.${CALLEE}(1);
        this.${CALLEE}Direct();
        super.helper();
        this.repo.${CALLEE}(1);
        this.#priv.${CALLEE}(1);
        return bare();
      }
      ${CALLEE}Direct() { return 1; }
    }
    function bare() { return 1; }
  `;
}

describe('the shared TS/JS call query compiles for every grammar it runs on', () => {
  for (const [path, language] of [
    ['a.ts', 'TypeScript'],
    ['a.tsx', 'TypeScript'],
    ['a.js', 'JavaScript'],
    ['a.jsx', 'JavaScript'],
  ] as const) {
    it(`${path} still yields a call graph`, async () => {
      // `#priv` is TS/JS-wide syntax; `.jsx`/`.tsx` differ only in grammar, not in this shape.
      const result = await new CallGraphBuilder().build([
        { path, content: fixture(), language },
      ]);
      // A query that failed to compile produces NO edges at all — that is the failure this pins.
      // Asserting a specific resolved edge would couple the guard to resolution behaviour; the
      // point is only that extraction did not silently collapse.
      expect(result.edges.length, `${path}: call query produced no edges — did it fail to compile?`)
        .toBeGreaterThan(0);
      expect([...result.nodes.values()].some(n => n.name === CALLER)).toBe(true);
    });
  }
});
