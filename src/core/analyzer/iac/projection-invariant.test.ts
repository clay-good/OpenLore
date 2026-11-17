/**
 * An infrastructure declaration is never read as code (change: fix-projection-integrity).
 *
 * The contract projection declared this invariant and implemented it with a contract-only
 * predicate, so INFRASTRUCTURE never had it: adding a `serverless.yml` to a repository removed
 * the deployed handler from the entry points (its own manifest gave it a fan-in of 1) and put a
 * YAML stanza there instead, and the stanzas were terms in the published `avgFanIn`/`avgFanOut`.
 * `CODEBASE.md` prints the entry-point table under "the natural starting point for any task",
 * so a digest told an agent to start work in a manifest.
 *
 * Asserted as a DIFFERENCE between two builds over the same code, which is the only way to
 * state "the declaration changed nothing".
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from '../call-graph.js';

const ORDERS = `import { helper } from './helper.js';
export function create(event) { return helper(event); }
`;
const HELPER = `export function helper(x) { return x; }
`;
const MANIFEST = `service: orders
provider: { name: aws, runtime: nodejs22.x }
functions:
  createOrder:
    handler: src/orders.create
`;

const code = [
  { path: 'src/orders.ts', content: ORDERS, language: 'TypeScript' },
  { path: 'src/helper.ts', content: HELPER, language: 'TypeScript' },
];
const manifest = { path: 'serverless.yml', content: MANIFEST, language: 'Serverless' };

describe('the infrastructure projection leaves the code graph alone', () => {
  it('binds the handler without changing a single code measurement', async () => {
    const bare = await new CallGraphBuilder().build(code);
    const withInfra = await new CallGraphBuilder().build([...code, manifest]);

    // The binding exists.
    const deploys = withInfra.edges.filter(e => e.kind === 'deploys_symbol');
    expect(deploys.length).toBeGreaterThan(0);
    expect(withInfra.nodes.get(deploys[0].calleeId)?.name).toBe('create');

    // And it cost the code nothing.
    const degrees = (r: typeof bare) => [...r.nodes.values()]
      .filter(n => n.language === 'TypeScript')
      .map(n => `${n.name}:${n.fanIn}/${n.fanOut}`)
      .sort();
    expect(degrees(withInfra)).toEqual(degrees(bare));
    expect(withInfra.stats.avgFanIn).toBe(bare.stats.avgFanIn);
    expect(withInfra.stats.avgFanOut).toBe(bare.stats.avgFanOut);
  });

  it('keeps the deployed handler an entry point and never makes the manifest one', async () => {
    const withInfra = await new CallGraphBuilder().build([...code, manifest]);
    const entryNames = withInfra.entryPoints.map(n => n.name);

    expect(entryNames).toContain('create');
    for (const n of withInfra.entryPoints) {
      expect(n.language).not.toBe('Serverless');
    }
    for (const n of withInfra.hubFunctions) {
      expect(n.language).not.toBe('Serverless');
    }
  });

  it('names an ecosystem whose extraction failed instead of serving an empty projection', async () => {
    const bomb = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    for (let i = 0; i < 10; i++) {
      const prev = i === 0 ? 'a' : `b${i - 1}`;
      bomb.push(`b${i}: &b${i} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]`);
    }
    const result = await new CallGraphBuilder().build([
      ...code,
      manifest,
      { path: 'k8s/bomb.yaml', content: bomb.join('\n') + '\n', language: 'Kubernetes' },
    ]);

    expect(result.iacNotAssessed?.some(f => f.startsWith('Kubernetes: '))).toBe(true);
    // And the Serverless binding still landed: one ecosystem's failure is not all of them.
    expect(result.edges.some(e => e.kind === 'deploys_symbol')).toBe(true);
  });
});
