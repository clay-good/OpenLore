/**
 * Binding a generated client to the operation it calls (change: add-contract-graph-projection).
 *
 * The dangerous direction is a WRONG edge: a hand-written `getOrder` tied to an operation it has
 * nothing to do with. The gate is the module's own header naming the specification, so the cases
 * that must NOT bind are asserted as carefully as the ones that must.
 */
import { describe, it, expect } from 'vitest';
import { generatedClientFunctionsFor, headerNamesSpec } from './generated-client.js';

const fn = (name: string, filePath: string) => ({ name, filePath });

describe('headerNamesSpec', () => {
  it('accepts a generator banner naming the path or the base name', () => {
    expect(headerNamesSpec('/** @generated from api/openapi.yaml */\n', 'api/openapi.yaml')).toBe(true);
    expect(headerNamesSpec('// Code generated from openapi.yaml. DO NOT EDIT.\n', 'api/openapi.yaml')).toBe(true);
    expect(headerNamesSpec('# generated from api/openapi.yaml\n', 'api/openapi.yaml')).toBe(true);
  });

  // A prose reference is not a statement that the file was produced from the document. Without
  // this, "// See api/openapi.yaml for the wire contract these mirror." on a HAND-WRITTEN module
  // bound its functions to that document's operations.
  it('rejects a mention with no generation claim on the line', () => {
    expect(headerNamesSpec('// See api/openapi.yaml for the wire contract these mirror.\n', 'api/openapi.yaml')).toBe(false);
    expect(headerNamesSpec('// Order helpers. Matches api/openapi.yaml.\n', 'api/openapi.yaml')).toBe(false);
  });

  // `openapi.yaml` is the common filename, and a bare substring test let one document's header
  // match ANOTHER whose base name is a substring of it: a client naming `api/openapi.yaml` bound
  // to `third-party/stripe/openapi.yaml` too, and the graph asserted the repo called Stripe.
  it('never matches a different specification whose base name is a substring', () => {
    const header = '/** @generated from api/openapi.yaml - do not edit */\n';
    expect(headerNamesSpec(header, 'api/openapi.yaml')).toBe(true);
    expect(headerNamesSpec(header, 'third-party/stripe/openapi.yaml')).toBe(false);
  });

  it('matches a bare base name only on a path boundary', () => {
    expect(headerNamesSpec('// @generated from openapi.yaml\n', 'api/openapi.yaml')).toBe(true);
    expect(headerNamesSpec('// @generated from my-openapi.yaml\n', 'api/openapi.yaml')).toBe(false);
    expect(headerNamesSpec('// @generated from openapi.yaml.bak\n', 'api/openapi.yaml')).toBe(false);
  });

  it('ignores a specification path that is not in a comment', () => {
    // A loader that READS the specification at runtime is not generated from it.
    expect(headerNamesSpec("const spec = await read('api/openapi.yaml'); // generated\n", 'api/openapi.yaml')).toBe(false);
    expect(headerNamesSpec("export const SPEC_PATH = 'api/openapi.yaml';\n", 'api/openapi.yaml')).toBe(false);
  });

  it('ignores a reference past the header', () => {
    const body = 'export const x = 1;\n'.repeat(60) + '// @generated from api/openapi.yaml\n';
    expect(headerNamesSpec(body, 'api/openapi.yaml')).toBe(false);
  });

  it('does not match a different specification', () => {
    expect(headerNamesSpec('/** @generated from api/pets.yaml */\n', 'api/openapi.yaml')).toBe(false);
  });
});

describe('generatedClientFunctionsFor', () => {
  const nodes = new Map<string, Array<{ name: string; filePath: string }>>([
    ['src/generated/api-client.ts', [fn('getOrder', 'src/generated/api-client.ts'), fn('listOrders', 'src/generated/api-client.ts')]],
    ['src/handwritten.ts', [fn('getOrder', 'src/handwritten.ts')]],
  ]);
  const content = (f: string) => f === 'src/generated/api-client.ts'
    ? '/** @generated from api/openapi.yaml */\n'
    : 'export function getOrder() {}\n';

  it('indexes only the functions of a module whose header names the specification', () => {
    const byName = generatedClientFunctionsFor('api/openapi.yaml', nodes, content);

    expect([...byName.keys()].sort()).toEqual(['getOrder', 'listOrders']);
    // The hand-written same-named function is NOT in the index — a wrong edge is worse than none.
    expect(byName.get('getOrder')!.map(f => f.filePath)).toEqual(['src/generated/api-client.ts']);
  });

  it('is empty when no module names the specification', () => {
    expect(generatedClientFunctionsFor('api/other.yaml', nodes, content).size).toBe(0);
  });

  it('never treats the specification itself as its own client', () => {
    const withSpec = new Map([['api/openapi.yaml', [fn('getOrder', 'api/openapi.yaml')]]]);
    expect(generatedClientFunctionsFor('api/openapi.yaml', withSpec, () => '# api/openapi.yaml\n').size).toBe(0);
  });

  it('collects same-named functions from several naming modules, so the caller can refuse', () => {
    const two = new Map([
      ['src/gen/a.ts', [fn('getOrder', 'src/gen/a.ts')]],
      ['src/gen/b.ts', [fn('getOrder', 'src/gen/b.ts')]],
    ]);
    const byName = generatedClientFunctionsFor('api/openapi.yaml', two, () => '// @generated from api/openapi.yaml\n');
    expect(byName.get('getOrder')).toHaveLength(2);
  });

  it('skips a file whose content is unavailable rather than assuming', () => {
    expect(generatedClientFunctionsFor('api/openapi.yaml', nodes, () => undefined).size).toBe(0);
  });

  // A test or fixture module whose header names the specification for conformance bound its own
  // helpers to the operations — and a short `operationId` such as `list` collides readily.
  it('excludes a test module even when its header claims the specification', () => {
    const withTest = new Map([['src/orders.test.ts', [fn('getOrder', 'src/orders.test.ts')]]]);
    const claim = () => '// Fixtures generated from api/openapi.yaml\n';
    expect(generatedClientFunctionsFor('api/openapi.yaml', withTest, claim).size, 'no predicate: included').toBe(1);
    expect(generatedClientFunctionsFor('api/openapi.yaml', withTest, claim, f => f.endsWith('.test.ts')).size).toBe(0);
  });
});
