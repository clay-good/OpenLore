/**
 * Deploy binding (change: add-iac-deploy-binding): a function resource → the code function it runs.
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from '../call-graph.js';
import { bindDeployHandlers } from './deploy-binding.js';

const ORDERS_TS = 'export function handler(event: unknown) {\n  return process(event);\n}\nfunction process(e: unknown) {\n  return e;\n}\n';
const APP_PY = 'def lambda_handler(event, context):\n    return {"ok": True}\n';

const TF = `resource "aws_lambda_function" "orders" {
  function_name = "orders"
  handler       = "src/orders.handler"
  runtime       = "nodejs20.x"
}
resource "aws_lambda_function" "dynamic" {
  handler = var.handler
}
resource "aws_lambda_function" "built" {
  handler = "dist/orders.handler"
}
resource "aws_lambda_function" "missing" {
  handler = "src/orders.nope"
}
resource "aws_s3_bucket" "logs" {
  bucket = "logs"
}
`;

const SAM = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: python3.12
Resources:
  Api:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: functions/
      Handler: app.lambda_handler
  Sub:
    Type: AWS::Lambda::Function
    Properties:
      Handler: !Sub "\${Prefix}.handler"
  Image:
    Type: AWS::Serverless::Function
    Properties:
      PackageType: Image
`;

async function build(): Promise<SerializedCallGraph> {
  return serializeCallGraph(await new CallGraphBuilder().build([
    { path: 'src/orders.ts', content: ORDERS_TS, language: 'TypeScript' },
    { path: 'infra/sam/functions/app.py', content: APP_PY, language: 'Python' },
    { path: 'infra/main.tf', content: TF, language: 'Terraform' },
    { path: 'infra/sam/template.yaml', content: SAM, language: 'CloudFormation' },
  ]));
}

describe('deploy binding', () => {
  it('binds a Terraform Lambda handler and a SAM handler (CodeUri relative to the template) to their functions', async () => {
    const g = await build();
    const deploys = g.edges.filter(e => e.kind === 'deploys_symbol');
    const pairs = deploys.map(e => `${e.callerId} -> ${e.calleeId}`).sort();
    const handler = g.nodes.find(n => n.name === 'handler' && n.filePath === 'src/orders.ts')!;
    const lambda = g.nodes.find(n => n.name === 'lambda_handler')!;
    expect(pairs).toEqual([
      `infra/main.tf::aws_lambda_function.orders -> ${handler.id}`,
      `infra/sam/template.yaml::Api -> ${lambda.id}`,
    ].sort());
  });

  it('discloses every handler it cannot bind, with the reason', async () => {
    const g = await build();
    const byResource = new Map((g.unresolvedDeployBindings ?? []).map(u => [u.resource, u.reason]));
    expect(byResource.get('aws_lambda_function.dynamic')).toContain('expression');
    expect(byResource.get('aws_lambda_function.built')).toContain('build-output');
    expect(byResource.get('aws_lambda_function.missing')).toContain('no indexed function "nope"');
    expect(byResource.get('Sub')).toContain('intrinsic');
    expect(byResource.has('Image')).toBe(false);
    expect(byResource.has('aws_s3_bucket.logs')).toBe(false);
  });

  it('never matches by similarity: a near-miss module or a twin function stays unresolved', () => {
    const graph = {
      resources: [
        { address: 'aws_lambda_function.a', type: 'aws_lambda_function', kind: 'resource' as const, filePath: 'main.tf', startLine: 1, signature: '', language: 'Terraform' as const, deploys: { handler: 'src/order.handler' } },
        { address: 'aws_lambda_function.b', type: 'aws_lambda_function', kind: 'resource' as const, filePath: 'main.tf', startLine: 5, signature: '', language: 'Terraform' as const, deploys: { handler: 'src/twin.run' } },
      ],
      references: [], modules: [],
    };
    const node = (id: string, name: string, filePath: string) => ({ id, name, filePath, startLine: 1, endLine: 2, startIndex: 0, endIndex: 1, language: 'TypeScript' }) as never;
    const r = bindDeployHandlers(graph as never, [node('o', 'handler', 'src/orders.ts'), node('t1', 'run', 'src/twin.ts'), node('t2', 'run', 'src/twin.ts')]);
    expect(r.edges).toEqual([]);
    expect(r.unresolved.map(u => u.reason)).toEqual([expect.stringContaining('no indexed source file'), expect.stringContaining('more than once')]);
  });
});
