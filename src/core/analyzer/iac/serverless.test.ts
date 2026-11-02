/**
 * Serverless Framework extraction (change: add-iac-deploy-binding-commands).
 *
 * The reader's whole job is the `deploys` binding each function carries, and the honest reason
 * when it carries none — so these cases are the shapes a real `serverless.yml` takes.
 */
import { describe, it, expect } from 'vitest';
import { extractServerless, isServerlessPath, looksLikeServerless } from './serverless.js';

const file = (content: string, path = 'serverless.yml') => [{ path, content, language: 'Serverless' }];

const BASE = `service: orders
provider:
  name: aws
  runtime: nodejs20.x
functions:
  createOrder:
    handler: src/orders.create
  getOrder:
    handler: src/orders.get
    runtime: python3.12
`;

describe('isServerlessPath', () => {
  it('names the files the framework itself reads', () => {
    expect(['serverless.yml', 'serverless.yaml', 'serverless.json', 'svc/serverless.yml'].every(isServerlessPath)).toBe(true);
    expect(['serverless.config.yml', 'severless.yml', 'docker-compose.yml'].some(isServerlessPath)).toBe(false);
  });
});

describe('looksLikeServerless', () => {
  it('corroborates by content, so a same-named file is not misclassified', () => {
    expect(looksLikeServerless(BASE)).toBe(true);
    expect(looksLikeServerless('provider:\n  name: aws\nfunctions:\n  a:\n    handler: h.x\n')).toBe(true);
    expect(looksLikeServerless('jobs:\n  build: {}\n')).toBe(false);
  });

  it('corroborates the JSON spelling, which the framework also reads', () => {
    expect(looksLikeServerless('{"service":"orders","functions":{"a":{"handler":"h.x"}}}')).toBe(true);
    expect(looksLikeServerless('{\n  "provider": { "name": "aws" },\n  "functions": {}\n}')).toBe(true);
    expect(looksLikeServerless('{"name":"pkg","version":"1.0.0"}')).toBe(false);
  });
});

describe('extractServerless', () => {
  it('projects the service and one resource per function, with its handler and runtime', () => {
    const g = extractServerless(file(BASE));
    expect(g.resources.map(r => r.displayName)).toEqual(['service.orders', 'function.createOrder', 'function.getOrder']);
    expect(g.resources[1]).toMatchObject({
      address: 'serverless.yml::function.createOrder',
      type: 'serverless:function',
      kind: 'resource',
      deploys: { handler: 'src/orders.create', runtime: 'nodejs20.x' },
    });
    // A function's own runtime wins over the provider's.
    expect(g.resources[2].deploys).toEqual({ handler: 'src/orders.get', runtime: 'python3.12' });
  });

  it('points each function at its declaration', () => {
    const g = extractServerless(file(BASE));
    // The value node, as every other YAML reader here resolves a line: the function's first
    // property. Its `signature` names which function it is.
    expect(g.resources[1].startLine).toBe(7);
    expect(g.resources[1].signature).toBe('functions.createOrder');
    expect(g.resources[2].startLine).toBe(9);
  });

  it('groups the functions under the service', () => {
    const g = extractServerless(file(BASE));
    expect(g.references).toEqual([
      { fromAddress: 'serverless.yml::function.createOrder', toAddress: 'serverless.yml::service', kind: 'depends_on', line: 7 },
      { fromAddress: 'serverless.yml::function.getOrder', toAddress: 'serverless.yml::service', kind: 'depends_on', line: 9 },
    ]);
    expect(g.modules[0].members).toEqual(['serverless.yml::function.createOrder', 'serverless.yml::function.getOrder']);
  });

  it('says why a container function binds to no source', () => {
    const g = extractServerless(file(`${BASE}  imageFn:\n    image: my-image\n`));
    expect(g.resources[3].deploys).toEqual({ unresolved: 'the function runs a container image, not source in this repository' });
  });

  it('says why a handler built from a variable binds to no source', () => {
    const g = extractServerless(file('service: s\nfunctions:\n  a:\n    handler: ${self:custom.base}.handler\n'));
    expect(g.resources[1].deploys).toEqual({ unresolved: 'the handler is built from a Serverless variable' });
  });

  it('says why a function with no handler binds to no source', () => {
    const g = extractServerless(file('service: s\nfunctions:\n  a:\n    events: []\n'));
    expect(g.resources[1].deploys).toEqual({ unresolved: 'the function declares no handler' });
  });

  it('reads a service declared as an object', () => {
    const g = extractServerless(file('service:\n  name: orders\nfunctions:\n  a:\n    handler: h.x\n'));
    expect(g.resources[0].displayName).toBe('service.orders');
  });

  it('reads a serverless.json manifest end to end', () => {
    const g = extractServerless([{
      path: 'serverless.json',
      language: 'Serverless',
      content: JSON.stringify({
        service: 'orders',
        provider: { name: 'aws', runtime: 'nodejs20.x' },
        functions: { createOrder: { handler: 'src/orders.create' } },
      }, null, 2),
    }]);
    expect(g.resources.map(r => r.displayName)).toEqual(['service.orders', 'function.createOrder']);
    expect(g.resources[1].deploys).toEqual({ handler: 'src/orders.create', runtime: 'nodejs20.x' });
  });

  it('reads nothing from a file that is not a service manifest, or will not parse', () => {
    expect(extractServerless(file('jobs:\n  build: {}\n')).resources).toEqual([]);
    expect(extractServerless(file('service: s\nfunctions:\n  - [\n')).resources).toEqual([]);
    expect(extractServerless(file(BASE, 'other.yml')).resources).toEqual([]);
  });

  it('reads a functions block that is not a mapping as no functions, not a crash', () => {
    const g = extractServerless(file('service: s\nfunctions: []\n'));
    expect(g.resources.map(r => r.displayName)).toEqual(['service.orders'.replace('orders', 's')]);
  });
});
