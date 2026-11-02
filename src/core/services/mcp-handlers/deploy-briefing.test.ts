/**
 * The infrastructure briefing for a handler in scope (change: add-iac-deploy-binding-commands).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { infrastructureForFunctions } from './deploy-briefing.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };

const HANDLER = `export function handler(event: unknown) {
  const table = process.env.TABLE_NAME;
  const region = process.env.AWS_REGION;
  return { table, region };
}
export function helper() { return process.env.UNRELATED; }
`;

const TERRAFORM = `resource "aws_lambda_function" "orders" {
  function_name = "orders"
  handler       = "src/orders.handler"
  runtime       = "nodejs20.x"
  environment {
    variables = {
      TABLE_NAME = "orders-table"
    }
  }
}
`;

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'oldeploy-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env: GIT_ENV });
  return root;
}

function fn(id: string, startLine: number, endLine: number): FunctionNode {
  return {
    id, name: id.slice(id.indexOf('::') + 2), filePath: id.slice(0, id.indexOf('::')),
    isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, startLine, endLine,
  };
}

const RESOURCE: FunctionNode = {
  id: 'main.tf::aws_lambda_function.orders', name: 'aws_lambda_function.orders', filePath: 'main.tf',
  isAsync: false, language: 'Terraform', startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, startLine: 1, endLine: 10,
};

const deploysEdge: CallEdge = {
  callerId: RESOURCE.id, calleeId: 'src/orders.ts::handler', calleeName: 'handler',
  confidence: 'import', kind: 'deploys_symbol', line: 1,
};

function graph(edges: CallEdge[] = [deploysEdge]): SerializedCallGraph {
  return {
    nodes: [fn('src/orders.ts::handler', 1, 5), fn('src/orders.ts::helper', 6, 6), RESOURCE],
    edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: 3, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

const scope = [{ name: 'handler', filePath: 'src/orders.ts' }];

describe('infrastructureForFunctions', () => {
  it('names the resource that runs the function and the site that sets each variable it reads', async () => {
    const root = repo({ 'src/orders.ts': HANDLER, 'main.tf': TERRAFORM });
    const out = await infrastructureForFunctions(root, graph(), scope);
    expect(out?.deployedBy).toEqual([{
      resource: 'aws_lambda_function.orders', ecosystem: 'Terraform', declaredAt: 'main.tf:1', runs: 'handler',
    }]);
    const table = out?.environment.find(e => e.name === 'TABLE_NAME');
    expect(table?.setBy).toEqual([{ ecosystem: 'Terraform', resource: 'aws_lambda_function.orders', at: 'main.tf:7' }]);
  });

  it('says a variable nothing in the repository sets is undeclared, rather than omitting it', async () => {
    const root = repo({ 'src/orders.ts': HANDLER, 'main.tf': TERRAFORM });
    const out = await infrastructureForFunctions(root, graph(), scope);
    expect(out?.environment.find(e => e.name === 'AWS_REGION')).toEqual({ name: 'AWS_REGION', setBy: [], undeclared: true });
  });

  it('reads only the variables the functions in scope read, not the whole file', async () => {
    const root = repo({ 'src/orders.ts': HANDLER, 'main.tf': TERRAFORM });
    const out = await infrastructureForFunctions(root, graph(), scope);
    // `UNRELATED` is read by `helper`, which is not in scope.
    expect(out?.environment.map(e => e.name)).toEqual(['AWS_REGION', 'TABLE_NAME']);
  });

  it('reads nothing at all when no resource runs a function in scope', async () => {
    const root = repo({ 'src/orders.ts': HANDLER, 'main.tf': TERRAFORM });
    // The function reads two variables, but nothing deploys it: this field is about a deployed
    // handler, and `analyze_env_impact` answers the configuration question on its own.
    expect(await infrastructureForFunctions(root, graph([]), scope)).toBeUndefined();
  });

  it('names only the variables the DEPLOYED function reads', async () => {
    const root = repo({ 'src/orders.ts': HANDLER, 'main.tf': TERRAFORM });
    const out = await infrastructureForFunctions(root, graph(), [...scope, { name: 'helper', filePath: 'src/orders.ts' }]);
    // `helper` is in scope but nothing deploys it, so its `UNRELATED` is not here.
    expect(out?.environment.map(e => e.name)).toEqual(['AWS_REGION', 'TABLE_NAME']);
  });

  it('discloses a file of a deployed function it could not re-read', async () => {
    const root = repo({ 'main.tf': TERRAFORM });
    const out = await infrastructureForFunctions(root, graph(), scope);
    expect(out?.deployedBy).toHaveLength(1);
    expect(out?.scanBoundaries?.join(' ')).toMatch(/could not be re-read/);
  });

  it('returns nothing for a scope with no deployment and no variable', async () => {
    const root = repo({ 'src/plain.ts': 'export function plain() { return 1; }\n' });
    const out = await infrastructureForFunctions(root, {
      ...graph([]), nodes: [fn('src/plain.ts::plain', 1, 1)],
    }, [{ name: 'plain', filePath: 'src/plain.ts' }]);
    expect(out).toBeUndefined();
  });

  it('returns nothing for a scope whose functions no resource runs', async () => {
    const root = repo({ 'src/orders.ts': HANDLER, 'main.tf': TERRAFORM });
    expect(await infrastructureForFunctions(root, graph(), [{ name: 'helper', filePath: 'src/orders.ts' }])).toBeUndefined();
  });
});
