/**
 * Declared elements in the session ledger (change: add-ledger-contract-hashes).
 *
 * An agent served `POST /v1/checkout` from a specification, or an infrastructure resource, is
 * tracked like a code symbol: the note names the ELEMENT a teammate changed, a reformat is not a
 * change, and the session counts carry its own line.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { SessionLedger, servedItems, recordAgentEdit, type LedgerSnapshot } from './session-ledger.js';
import { hashContractOperations, resolveIacLanguage, hashIacResources } from './declaration-hashes.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'olsld-'));
  dirs.push(d);
  return d;
}
let tick = 1_700_000_000;
function write(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  tick += 10;
  utimesSync(p, tick, tick);
}

const SPEC = `openapi: 3.0.0
info: { title: shop, version: '1' }
paths:
  /v1/checkout:
    post:
      operationId: checkout
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [cart]
              properties:
                cart: { type: string }
      responses: { '201': { description: created } }
  /v1/orders:
    get:
      responses: { '200': { description: ok } }
`;

/** The same document with a required property added to the request body. */
const SPEC_CHANGED = SPEC
  .replace('required: [cart]', 'required: [cart, token]')
  .replace('cart: { type: string }', 'cart: { type: string }\n                token: { type: string }');

/** The same document, re-indented and re-wrapped: no declaration changed. */
const SPEC_REFORMATTED = SPEC
  .replace("info: { title: shop, version: '1' }", "info:\n  title: shop\n  version: '1'")
  .replace("responses: { '200': { description: ok } }", "responses:\n        '200':\n          description: ok");

const TERRAFORM = `resource "aws_s3_bucket" "logs" {
  bucket = "my-logs"
}
resource "aws_s3_bucket" "assets" {
  bucket = "my-assets"
}
`;

const other = [{ file: 'src/elsewhere.ts', at: Date.now() }];

describe('contract operations in the ledger', () => {
  it('names the operation a second process changed, not the file (scenario: a teammate edits the spec)', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed(servedItems('orient', {
      contracts: { contracts: [{ operation: 'POST /v1/checkout', spec: 'openapi.yaml:5' }], note: '' },
    }));
    write(root, 'openapi.yaml', SPEC_CHANGED);
    await ledger.refresh(5000);
    expect(ledger.takeNote(other)).toMatch(/POST \/v1\/checkout \(openapi\.yaml\)/);
    expect(ledger.facts(other).backgroundChanges.map(c => c.name)).toEqual(['POST /v1/checkout']);
  });

  it('re-indenting the specification does not name the operation (scenario: re-indent)', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml', name: 'POST /v1/checkout' }]);
    write(root, 'openapi.yaml', SPEC_REFORMATTED);
    await ledger.refresh(5000);
    // The declaration is unchanged, so no note names it. (A restyle that moves text between
    // lines is still a change to the FILE, as it was before elements existed.)
    expect(ledger.facts(other).backgroundChanges.map(b => b.name)).not.toContain('POST /v1/checkout');
  });

  it('indenting the specification deeper is not a change at all', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml', name: 'POST /v1/checkout' }]);
    write(root, 'openapi.yaml', SPEC.split('\n').map(l => (l.startsWith(' ') ? ` ${l}` : l)).join('\n'));
    await ledger.refresh(5000);
    expect(ledger.takeNote(other)).toBeNull();
    expect(ledger.facts(other).backgroundChanges).toEqual([]);
  });

  it('a change to another operation does not name the one the agent read', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml', name: 'POST /v1/checkout' }]);
    write(root, 'openapi.yaml', SPEC.replace("responses: { '200': { description: ok } }", "responses: { '204': { description: gone } }"));
    await ledger.refresh(5000);
    const named = ledger.facts(other).backgroundChanges.map(b => b.name);
    expect(named).not.toContain('POST /v1/checkout');
    // The file the agent read did change, so the backstop says so — never silence.
    expect(named).toEqual(['openapi.yaml']);
  });

  it('counts the agent\'s own change to a declared operation on its own line', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml' }]);
    await new Promise(r => setTimeout(r, 5));
    write(root, 'openapi.yaml', SPEC_CHANGED);
    recordAgentEdit(root, 'openapi.yaml');
    await new Promise(r => setTimeout(r, 5));
    await ledger.refresh(5000);
    const counts = ledger.changeKinds();
    expect(counts).toMatchObject({ contractElementsChanged: 1, unclassified: 0, bodyOnly: 0, iacResourcesChanged: 0 });
    const snap = ledger.snapshot() as LedgerSnapshot;
    expect(snap.changeKinds?.contractElementsChanged).toBe(1);
  });

  it('falls back to the whole file when the specification cannot be read', async () => {
    const root = repo();
    write(root, 'openapi.yaml', 'openapi: 3.0.0\npaths:\n  - [\n');
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml' }]);
    write(root, 'openapi.yaml', 'openapi: 3.0.0\npaths:\n  - [[\n');
    await ledger.refresh(5000);
    // Still seen — named by its file, because no element could be read.
    expect(ledger.facts(other).backgroundChanges.map(c => c.name)).toEqual(['openapi.yaml']);
  });
});

describe('IaC resources in the ledger', () => {
  it('names the resource a second process changed', async () => {
    const root = repo();
    write(root, 'main.tf', TERRAFORM);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'main.tf', name: 'aws_s3_bucket.logs' }]);
    write(root, 'main.tf', TERRAFORM.replace('"my-logs"', '"my-logs-2"'));
    await ledger.refresh(5000);
    expect(ledger.facts(other).backgroundChanges.map(c => c.name)).toEqual(['aws_s3_bucket.logs']);
  });

  it('re-indenting the manifest is not a change', async () => {
    const root = repo();
    write(root, 'main.tf', TERRAFORM);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'main.tf', name: 'aws_s3_bucket.logs' }]);
    write(root, 'main.tf', TERRAFORM.replace('  bucket = "my-logs"', '    bucket   = "my-logs"'));
    await ledger.refresh(5000);
    expect(ledger.facts(other).backgroundChanges).toEqual([]);
  });

  it('counts the agent\'s own change to a resource on its own line', async () => {
    const root = repo();
    write(root, 'main.tf', TERRAFORM);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'main.tf' }]);
    await new Promise(r => setTimeout(r, 5));
    write(root, 'main.tf', TERRAFORM.replace('"my-logs"', '"my-logs-2"'));
    recordAgentEdit(root, 'main.tf');
    await new Promise(r => setTimeout(r, 5));
    await ledger.refresh(5000);
    expect(ledger.changeKinds()).toMatchObject({ iacResourcesChanged: 1, contractElementsChanged: 0, unclassified: 0 });
  });
});

const K8S = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.25
`;

const COMPOSE = `services:
  api:
    image: node:20
    ports: ["80:80"]
  db:
    image: postgres:16
`;

const DOCKERFILE = `FROM node:20 AS build
RUN npm ci
`;

const WORKFLOW = `name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
`;

/**
 * The element model of an ecosystem is always narrower than its file, and only Terraform and
 * Bicep close a resource's span. These are the cases where the per-element hash CANNOT see the
 * change — so the file-level backstop must, or the agent is told nothing at all.
 */
describe('the file-level backstop', () => {
  const cases: Array<{ what: string; file: string; before: string; after: string }> = [
    { what: 'a Kubernetes container image', file: 'deploy.yaml', before: K8S, after: K8S.replace('nginx:1.25', 'nginx:1.99') },
    { what: 'a Kubernetes replica count', file: 'deploy.yaml', before: K8S, after: K8S.replace('replicas: 2', 'replicas: 9') },
    { what: 'a compose port mapping', file: 'docker-compose.yml', before: COMPOSE, after: COMPOSE.replace('"80:80"', '"8080:80"') },
    { what: 'a Dockerfile build step', file: 'Dockerfile', before: DOCKERFILE, after: DOCKERFILE.replace('npm ci', 'npm ci --production') },
    { what: 'a workflow step', file: '.github/workflows/ci.yml', before: WORKFLOW, after: WORKFLOW.replace('echo a', 'echo b') },
    { what: 'a path added to a specification', file: 'openapi.yaml', before: SPEC, after: SPEC.replace('paths:\n', "paths:\n  /v1/ping:\n    get:\n      responses: { '200': { description: ok } }\n") },
    { what: 'a security requirement on the served operation', file: 'openapi.yaml', before: SPEC, after: SPEC.replace('      operationId: checkout', '      operationId: checkout\n      security: [{ apiKey: [] }]') },
    { what: 'a non-2xx response', file: 'openapi.yaml', before: SPEC, after: SPEC.replace("responses: { '201': { description: created } }", "responses:\n        '201': { description: created }\n        '404': { description: gone }") },
  ];

  for (const c of cases) {
    it(`names the file when the element model cannot see ${c.what}`, async () => {
      const root = repo();
      write(root, c.file, c.before);
      const ledger = new SessionLedger(root);
      await ledger.recordServed([{ file: c.file }]);
      write(root, c.file, c.after);
      await ledger.refresh(5000);
      const changed = ledger.facts(other).backgroundChanges.map(b => b.name);
      expect(changed.length).toBeGreaterThan(0);
      expect(changed).toContain(c.file);
    });
  }

  it('states one fact per edit: the element names it, the file stays quiet', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml' }]);
    write(root, 'openapi.yaml', SPEC_CHANGED);
    await ledger.refresh(5000);
    expect(ledger.facts(other).backgroundChanges.map(b => b.name)).toEqual(['POST /v1/checkout']);
  });

  it('names the file when a served specification stops parsing mid-session', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml', name: 'POST /v1/checkout' }]);
    write(root, 'openapi.yaml', `${SPEC}  bad: [\n`);
    await ledger.refresh(5000);
    expect(ledger.facts(other).backgroundChanges.map(b => b.name)).toContain('openapi.yaml');
  });

  it('names the file when the served operation is deleted outright', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml' }]);
    write(root, 'openapi.yaml', SPEC.slice(0, SPEC.indexOf('  /v1/checkout:')) + '  /v1/orders:\n    get:\n      responses: { \'200\': { description: ok } }\n');
    await ledger.refresh(5000);
    expect(ledger.facts(other).backgroundChanges.map(b => b.name)).toContain('openapi.yaml');
  });

  it('is not counted as a changed declaration (the whole-file entry is not an element)', async () => {
    const root = repo();
    write(root, 'deploy.yaml', K8S);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'deploy.yaml' }]);
    await new Promise(r => setTimeout(r, 5));
    write(root, 'deploy.yaml', K8S.replace('nginx:1.25', 'nginx:1.99'));
    recordAgentEdit(root, 'deploy.yaml');
    await new Promise(r => setTimeout(r, 5));
    await ledger.refresh(5000);
    // The resource's own hash cannot see the image, and the file entry is not a declaration.
    expect(ledger.changeKinds()).toMatchObject({ iacResourcesChanged: 0, contractElementsChanged: 0, unclassified: 0 });
  });
});

describe('declaration hashes', () => {
  it('keys an operation exactly as the graph projection keys its node', () => {
    const hashes = hashContractOperations('openapi.yaml', SPEC);
    expect([...hashes!.keys()].sort()).toEqual(['openapi.yaml::GET /v1/orders', 'openapi.yaml::POST /v1/checkout']);
    expect(hashes!.get('openapi.yaml::POST /v1/checkout')).toMatchObject({ name: 'POST /v1/checkout', kind: 'contract' });
  });

  it('does not change an operation hash when an operation is added above it', () => {
    const before = hashContractOperations('openapi.yaml', SPEC)!;
    const after = hashContractOperations('openapi.yaml', SPEC.replace('paths:\n', "paths:\n  /v1/ping:\n    get:\n      responses: { '200': { description: ok } }\n"))!;
    expect(after.get('openapi.yaml::POST /v1/checkout')!.hash).toBe(before.get('openapi.yaml::POST /v1/checkout')!.hash);
  });

  it('sees a required name that declares no property of its own', () => {
    // The rule table compares `required` only through the declared properties, so this change is
    // compared nowhere else — a client must now send `token`.
    const before = hashContractOperations('openapi.yaml', SPEC)!;
    const after = hashContractOperations('openapi.yaml', SPEC.replace('required: [cart]', 'required: [cart, token]'))!;
    expect(after.get('openapi.yaml::POST /v1/checkout')!.hash)
      .not.toBe(before.get('openapi.yaml::POST /v1/checkout')!.hash);
  });

  it('sees a changed success-response code', () => {
    const before = hashContractOperations('openapi.yaml', SPEC)!;
    const after = hashContractOperations('openapi.yaml', SPEC.replace("'201': { description: created }", "'200': { description: ok }"))!;
    expect(after.get('openapi.yaml::POST /v1/checkout')!.hash)
      .not.toBe(before.get('openapi.yaml::POST /v1/checkout')!.hash);
  });

  it('sees a change inside a schema the operation only references', () => {
    const referenced = `openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /v1/checkout:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Cart' }
      responses: { '201': { description: created } }
components:
  schemas:
    Cart:
      type: object
      properties:
        item: { type: string }
`;
    const before = hashContractOperations('openapi.yaml', referenced)!;
    const after = hashContractOperations('openapi.yaml', referenced.replace('item: { type: string }', 'item: { type: integer }'))!;
    expect(after.get('openapi.yaml::POST /v1/checkout')!.hash)
      .not.toBe(before.get('openapi.yaml::POST /v1/checkout')!.hash);
  });

  it('is not a specification when the file merely mentions the word', () => {
    expect(hashContractOperations('package.json', '{"dependencies":{"swagger":"^2.0.0"}}')).toBeUndefined();
  });

  it('resolves an IaC language by extension and by content', () => {
    expect(resolveIacLanguage('main.tf', TERRAFORM)).toBe('Terraform');
    expect(resolveIacLanguage('app.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n')).toBe('Kubernetes');
    expect(resolveIacLanguage('tsconfig.json', '{"compilerOptions":{}}')).toBeNull();
  });

  it('keys a resource exactly as the IaC projection keys its node', async () => {
    const hashes = await hashIacResources('main.tf', TERRAFORM, 'Terraform');
    expect([...hashes!.keys()]).toContain('main.tf::aws_s3_bucket.logs');
    expect(hashes!.get('main.tf::aws_s3_bucket.logs')).toMatchObject({ name: 'aws_s3_bucket.logs', kind: 'iac' });
  });

  it('joins two declarations of one address rather than letting the last win', async () => {
    const doubled = `${TERRAFORM}resource "aws_s3_bucket" "logs" {\n  bucket = "second"\n}\n`;
    const before = (await hashIacResources('main.tf', doubled, 'Terraform'))!.get('main.tf::aws_s3_bucket.logs')!.hash;
    const firstChanged = (await hashIacResources('main.tf', doubled.replace('"my-logs"', '"my-logs-2"'), 'Terraform'))!.get('main.tf::aws_s3_bucket.logs')!.hash;
    const secondChanged = (await hashIacResources('main.tf', doubled.replace('"second"', '"third"'), 'Terraform'))!.get('main.tf::aws_s3_bucket.logs')!.hash;
    expect(firstChanged).not.toBe(before);
    expect(secondChanged).not.toBe(before);
    expect(firstChanged).not.toBe(secondChanged);
  });

  it('gives two resources of one file distinct hashes', async () => {
    const hashes = await hashIacResources('main.tf', TERRAFORM, 'Terraform');
    const [a, b] = ['main.tf::aws_s3_bucket.logs', 'main.tf::aws_s3_bucket.assets'].map(k => hashes!.get(k)!.hash);
    expect(a).not.toBe(b);
  });
});
