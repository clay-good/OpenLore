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

  it('re-indenting the specification is not a change (scenario: re-indent)', async () => {
    const root = repo();
    write(root, 'openapi.yaml', SPEC);
    const ledger = new SessionLedger(root);
    await ledger.recordServed([{ file: 'openapi.yaml', name: 'POST /v1/checkout' }]);
    write(root, 'openapi.yaml', SPEC_REFORMATTED);
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
    expect(ledger.takeNote(other)).toBeNull();
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

  it('gives two resources of one file distinct hashes', async () => {
    const hashes = await hashIacResources('main.tf', TERRAFORM, 'Terraform');
    const [a, b] = ['main.tf::aws_s3_bucket.logs', 'main.tf::aws_s3_bucket.assets'].map(k => hashes!.get(k)!.hash);
    expect(a).not.toBe(b);
  });
});
