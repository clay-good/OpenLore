/**
 * Deploy binding (change: add-iac-deploy-binding): a function resource → the code function it runs.
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from '../call-graph.js';
import { bindDeployHandlers } from './deploy-binding.js';
import type { FunctionNode } from '../call-graph-types.js';

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
    expect(byResource.get('aws_lambda_function.missing')).toContain('no top-level function "nope"');
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

describe('deploy binding: adversarial review regressions', () => {
  const graphOf = async (files: Array<[string, string, string]>) =>
    serializeCallGraph(await new CallGraphBuilder().build(files.map(([path, content, language]) => ({ path, content, language }))));
  const pairs = (g: SerializedCallGraph) => g.edges.filter(e => e.kind === 'deploys_symbol').map(e => `${e.callerId} -> ${e.calleeId}`);
  const reasons = (g: SerializedCallGraph) => Object.fromEntries((g.unresolvedDeployBindings ?? []).map(u => [u.resource, u.reason]));
  const TS = (name: string) => `export function ${name}(e: unknown) {\n  return e;\n}\n`;
  const PY = (name: string) => `def ${name}(event, context):\n    return 1\n`;
  const cfn = (resources: string, globals = '') => `AWSTemplateFormatVersion: '2010-09-09'\nTransform: AWS::Serverless-2016-10-31\n${globals}Resources:\n${resources}`;

  it('inline code, S3 code, and Globals on a plain Lambda never bind', async () => {
    const g = await graphOf([
      ['index.ts', TS('handler'), 'TypeScript'],
      ['src/app.py', PY('handler'), 'Python'],
      ['template.yaml', cfn(`  Inline:\n    Type: AWS::Lambda::Function\n    Properties:\n      Handler: index.handler\n      Code:\n        ZipFile: "exports.handler = () => 1"\n  Plain:\n    Type: AWS::Lambda::Function\n    Properties:\n      Code: {S3Bucket: b, S3Key: k}\n`,
        `Globals:\n  Function:\n    Handler: app.handler\n    CodeUri: src/\n`), 'CloudFormation'],
    ]);
    expect(pairs(g)).toEqual([]);
    expect(reasons(g).Inline).toContain('inline');
  });

  it('Globals PackageType Image on a SAM function is honored', async () => {
    const g = await graphOf([
      ['app.py', PY('handler'), 'Python'],
      ['template.yaml', cfn(`  F:\n    Type: AWS::Serverless::Function\n    Properties:\n      Handler: app.handler\n`, `Globals:\n  Function:\n    PackageType: Image\n`), 'CloudFormation'],
    ]);
    expect(pairs(g)).toEqual([]);
  });

  it('a known CodeUri is the only base; no fallback to the repository root', async () => {
    const g = await graphOf([
      ['app.py', PY('handler'), 'Python'],
      ['template.yaml', cfn(`  F:\n    Type: AWS::Serverless::Function\n    Properties:\n      CodeUri: functions/orders/\n      Handler: app.handler\n`), 'CloudFormation'],
    ]);
    expect(pairs(g)).toEqual([]);
    expect(reasons(g).F).toContain('under functions/orders');
  });

  it('the runtime picks the language; an unsupported runtime is disclosed', async () => {
    const tf = (runtime: string) => `resource "aws_lambda_function" "f" {\n  handler = "src/app.handler"\n  runtime = "${runtime}"\n}\n`;
    const files: Array<[string, string, string]> = [['src/app.ts', TS('handler'), 'TypeScript'], ['src/app.py', PY('handler'), 'Python']];
    expect(pairs(await graphOf([...files, ['main.tf', tf('python3.12'), 'Terraform']]))[0]).toContain('src/app.py');
    expect(reasons(await graphOf([...files, ['main.tf', tf('java21'), 'Terraform']]))['aws_lambda_function.f']).toContain('java21 runtime is not bound');
    const ambiguous = await graphOf([...files, ['main.tf', 'resource "aws_lambda_function" "f" {\n  handler = "src/app.handler"\n}\n', 'Terraform']]);
    expect(pairs(ambiguous)).toEqual([]);
    expect(reasons(ambiguous)['aws_lambda_function.f']).toContain('more than one file');
  });

  it('Terraform: a bare module without source_dir is not bound; nested handler keys are ignored; modules are disclosed', async () => {
    const g = await graphOf([
      ['index.ts', TS('handler'), 'TypeScript'],
      ['other.py', PY('run'), 'Python'],
      ['infra/main.tf', [
        'resource "aws_lambda_function" "bare" {\n  filename = "lambda.zip"\n  handler  = "index.handler"\n}',
        'resource "aws_lambda_function" "nested" {\n  environment {\n    variables = {\n      handler = "other.run"\n    }\n  }\n  handler = var.h\n}',
        'module "lambda" {\n  source  = "terraform-aws-modules/lambda/aws"\n  handler = "app.handler"\n}',
      ].join('\n'), 'Terraform'],
    ]);
    expect(pairs(g)).toEqual([]);
    const r = reasons(g);
    expect(r['aws_lambda_function.bare']).toContain('no code location');
    expect(r['aws_lambda_function.nested']).toContain('expression');
    expect(r['module.lambda']).toContain('through a module');
  });

  it('a class method is not a handler; a Python dotted module is a path, not a dotted file name', async () => {
    const g = await graphOf([
      ['src/app.ts', 'export class A {\n  handle() {\n    return 1;\n  }\n}\n', 'TypeScript'],
      ['pkg/mod.py', PY('handler'), 'Python'],
      ['pkg.mod.py', PY('handler'), 'Python'],
      ['main.tf', 'resource "aws_lambda_function" "m" {\n  handler = "src/app.handle"\n}\nresource "aws_lambda_function" "p" {\n  handler = "pkg.mod.handler"\n  runtime = "python3.12"\n  source_dir = "."\n}\n', 'Terraform'],
    ]);
    expect(reasons(g)['aws_lambda_function.m']).toContain('no top-level function');
    expect(pairs(g)).toEqual([expect.stringContaining('pkg/mod.py')]);
  });
});

/**
 * A template in a subdirectory: the handler is relative to the TEMPLATE's own directory, never
 * also the repository root — that would bind a bare `app.handler` to an unrelated same-named file
 * (change: add-serverless-and-build-output-binding).
 */
describe('a template in a subdirectory', () => {
  const template = (dir: string) => ({
    path: `${dir}/template.yml`,
    content: 'Resources:\n  Fn:\n    Type: AWS::Serverless::Function\n    Properties:\n      Handler: app.handler\n      CodeUri: .\n      Runtime: nodejs20.x\n',
    language: 'CloudFormation',
  });
  const node = (file: string): FunctionNode => ({
    id: `${file}::handler`, name: 'handler', filePath: file, isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, startLine: 1, endLine: 2,
  });

  it('does not bind to a same-named file at the repository root', async () => {
    const { extractCloudFormation } = await import('./cloudformation.js');
    const graph = extractCloudFormation([template('infra')]);
    const bound = bindDeployHandlers(graph, [node('app.ts')]);
    expect(bound.edges).toEqual([]);
    expect(bound.unresolved).toHaveLength(1);
  });

  it('binds to the file beside the template, with no ambiguity from a root twin', async () => {
    const { extractCloudFormation } = await import('./cloudformation.js');
    const graph = extractCloudFormation([template('infra')]);
    const bound = bindDeployHandlers(graph, [node('app.ts'), node('infra/app.ts')]);
    expect(bound.edges.map(e => e.calleeId)).toEqual(['infra/app.ts::handler']);
  });
});
