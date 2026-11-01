import { describe, it, expect } from 'vitest';
import { extractEnvDeclarations } from './env-declarations.js';
import { detectLanguage } from '../language-detection.js';
import { extractTerraform } from './terraform.js';

const scan = (path: string, language: string, content: string) => extractEnvDeclarations({ path, content, language });
const sites = (path: string, language: string, content: string) =>
  scan(path, language, content).declarations.map(d => `${d.name}@${d.line} ${d.resource} ${d.literalValue ? 'literal' : 'ref'}`);

describe('extractEnvDeclarations', () => {
  it('Dockerfile: both ENV forms, continuations, stages', () => {
    expect(sites('Dockerfile', 'Dockerfile', 'FROM node AS build\nENV A=1 B="two words" \\\n    C=$HOME\nFROM alpine\nENV LEGACY some value\n'))
      .toEqual(['A@2 stage/build literal', 'B@2 stage/build literal', 'C@2 stage/build ref', 'LEGACY@5 Dockerfile literal']);
  });

  it('Terraform: environment variables, expression maps, and the kubernetes provider', () => {
    const tf = [
      'resource "aws_lambda_function" "orders" {',
      '  environment {',
      '    variables = {',
      '      DB = var.db',
      '      "STAGE" = "prod"',
      '    }',
      '  }',
      '}',
      'resource "aws_lambda_function" "dyn" {',
      '  environment { variables = local.env }',
      '}',
      'resource "kubernetes_deployment" "k" {',
      '  env {',
      '    name  = "PORT"',
      '    value = "8080"',
      '  }',
      '}',
    ].join('\n');
    const r = scan('main.tf', 'Terraform', tf);
    expect(r.declarations.map(d => `${d.name}@${d.line} ${d.resource} ${d.literalValue}`))
      .toEqual(['DB@4 aws_lambda_function.orders false', 'STAGE@5 aws_lambda_function.orders true', 'PORT@13 kubernetes_deployment.k true']);
    expect(r.opaque).toEqual([expect.objectContaining({ resource: 'aws_lambda_function.dyn', line: 10 })]);
  });

  it('Terraform JSON', () => {
    expect(sites('main.tf.json', 'Terraform', '{"resource": {"aws_lambda_function": {"f": {"environment": {"variables": {"K": "v"}}}}}}'))
      .toEqual(['K@1 aws_lambda_function.f literal']);
  });

  it('Kubernetes: every container list, valueFrom is not literal, envFrom is opaque, multi-document files', () => {
    const k = [
      'kind: CronJob', 'metadata: {name: nightly}', 'spec:', '  jobTemplate:', '    spec:', '      template:', '        spec:',
      '          initContainers:', '            - name: init', '              env: [{name: A, value: "1"}]',
      '          containers:', '            - name: run', '              env:', '                - name: B', '                  valueFrom: {secretKeyRef: {name: s, key: k}}',
      '              envFrom: [{secretRef: {name: s}}]', '---', 'kind: Pod', 'metadata: {name: p}', 'spec:', '  containers:', '    - env: [{name: C, value: "$(A)"}]',
    ].join('\n');
    const r = scan('k.yaml', 'Kubernetes', k);
    expect(r.declarations.map(d => `${d.name} ${d.resource} ${d.literalValue}`)).toEqual(['A CronJob/nightly/init true', 'B CronJob/nightly/run false', 'C Pod/p false']);
    expect(r.opaque.map(o => o.resource)).toEqual(['CronJob/nightly/run']);
  });

  it('Compose: list and map forms, env_file is opaque', () => {
    expect(sites('docker-compose.yml', 'Docker Compose', 'services:\n  a:\n    environment:\n      - X=1\n      - Y\n      - Z=${Q}\n  b:\n    environment:\n      W: two\n    env_file: .env\n'))
      .toEqual(['X@4 service/a literal', 'Y@5 service/a ref', 'Z@6 service/a ref', 'W@9 service/b literal']);
  });

  it('CloudFormation and SAM: function variables, globals, ECS containers, intrinsic values', () => {
    const cfn = [
      'AWSTemplateFormatVersion: "2010-09-09"', 'Globals:', '  Function:', '    Environment:', '      Variables: {G: g}',
      'Resources:', '  Fn:', '    Type: AWS::Serverless::Function', '    Properties:', '      Environment:', '        Variables:',
      '          TABLE: !Ref Table', '          MODE: fast', '  Task:', '    Type: AWS::ECS::TaskDefinition', '    Properties:',
      '      ContainerDefinitions:', '        - Name: app', '          Environment:', '            - {Name: PORT, Value: "80"}',
    ].join('\n');
    expect(sites('template.yaml', 'CloudFormation', cfn)).toEqual(['G@5 Globals/Function literal', 'TABLE@12 Fn ref', 'MODE@13 Fn literal', 'PORT@20 Task/app literal']);
  });

  it('GitHub Actions: workflow, job, container, and step env; expressions are not literal', () => {
    const wf = 'on: push\nenv: {W: 1}\njobs:\n  build:\n    env: {J: "${{ secrets.T }}"}\n    container: {image: x, env: {C: 2}}\n    steps:\n      - id: s\n        env: {S: 3}\n        run: echo\n';
    expect(sites('.github/workflows/ci.yml', 'GitHub Actions', wf)).toEqual(['W@2 workflow literal', 'J@5 job/build ref', 'C@6 job/build/container literal', 'S@9 job/build/step/s literal']);
  });

  it('never carries a value into its output', () => {
    const r = scan('docker-compose.yml', 'Docker Compose', 'services:\n  a:\n    environment:\n      PW: hunter2-SECRET\n');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('a broken file yields nothing rather than throwing', () => {
    expect(scan('k.yaml', 'Kubernetes', 'kind: [unclosed\n')).toEqual({ declarations: [], opaque: [] });
  });
});

describe('OpenTofu files are Terraform', () => {
  it('detects .tofu and .tofu.json, and projects them like .tf', () => {
    expect(detectLanguage('infra/main.tofu')).toBe('Terraform');
    expect(detectLanguage('infra/main.tofu.json')).toBe('Terraform');
    const hcl = 'resource "aws_s3_bucket" "logs" {\n  bucket = "x"\n}\n';
    const strip = (g: ReturnType<typeof extractTerraform>) => g.resources.map(r => ({ ...r, file: undefined, filePath: undefined }));
    expect(strip(extractTerraform([{ path: 'main.tofu', content: hcl }]))).toEqual(strip(extractTerraform([{ path: 'main.tf', content: hcl }])));
    const json = '{"resource": {"aws_s3_bucket": {"logs": {"bucket": "x"}}}}';
    expect(extractTerraform([{ path: 'main.tofu.json', content: json }]).resources.map(r => r.address)).toEqual(['aws_s3_bucket.logs']);
  });
});
