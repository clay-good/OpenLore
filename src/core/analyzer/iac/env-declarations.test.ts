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

describe('adversarial review regressions', () => {
  const names = (path: string, language: string, content: string) => scan(path, language, content).declarations.map(d => d.name);
  const lambda = (body: string) => `resource "aws_lambda_function" "f" {\n  environment {\n    variables = {\n${body}\n    }\n  }\n}\n`;

  it('Terraform: text inside a value, a nested map, or a heredoc is never a name', () => {
    expect(names('m.tf', 'Terraform', lambda('      DB_URL = "postgres://h?a=1,sslpass=Sup3rS3cret"\n      A = "a, FAKE = b"\n      C = { nested = 1, other = 2 }\n      H = <<EOT\nFAKE_IN_HEREDOC = 1\nEOT\n      D = "ok"')))
      .toEqual(['DB_URL', 'A', 'C', 'H', 'D']);
  });

  it('Terraform: comments are not code, and a comment brace does not end the map', () => {
    const tf = lambda('      # OLD = "x" }\n      A = "1" # trailing { comment\n      // B = "2"\n      C = "x}y"');
    expect(scan('m.tf', 'Terraform', tf).declarations.map(d => `${d.name} ${d.literalValue}`)).toEqual(['A true', 'C true']);
    expect(names('m.tf', 'Terraform', '# resource "aws_lambda_function" "x" {\n#   environment { variables = { OLD = "x" } }\n# }\n')).toEqual([]);
  });

  it('Terraform: only environment.variables in resource blocks; module inputs and templatefile maps are not env', () => {
    const tf = 'resource "aws_ssm_document" "d" {\n  content = templatefile("x.tpl", { variables = { NOTENV = 1 } })\n}\nmodule "m" {\n  variables = { MOD = 1 }\n}\n';
    expect(names('m.tf', 'Terraform', tf)).toEqual([]);
  });

  it('Terraform: dynamic env and env_from are opaque; CRLF files read', () => {
    const tf = 'resource "kubernetes_deployment" "d" {\n  spec {\n    dynamic "env" {\n      for_each = var.e\n    }\n    env_from {\n      config_map_ref { name = "c" }\n    }\n  }\n}\n';
    expect(scan('m.tf', 'Terraform', tf).opaque.map(o => o.reason)).toEqual(['a dynamic env block', expect.stringContaining('env_from')]);
    expect(names('m.tf', 'Terraform', lambda('      A = "1"').replace(/\n/g, '\r\n'))).toEqual(['A']);
  });

  it('Dockerfile: CRLF, escaped spaces, heredocs, comments in continuations, FROM flags', () => {
    expect(names('Dockerfile', 'Dockerfile', 'FROM x\r\nENV A=1\r\nENV B 2\r\n')).toEqual(['A', 'B']);
    expect(names('Dockerfile', 'Dockerfile', 'ENV A=x\\ hunter2=y\n')).toEqual(['A']);
    expect(names('Dockerfile', 'Dockerfile', 'RUN <<EOF\nENV FAKE=1\nEOF\nENV REAL=1\n')).toEqual(['REAL']);
    expect(names('Dockerfile', 'Dockerfile', 'ENV A=1 \\\n# c\n    B=2\n')).toEqual(['A', 'B']);
    expect(scan('Dockerfile', 'Dockerfile', 'FROM --platform=$B node AS build\nENV A=1\n').declarations[0].resource).toBe('stage/build');
  });

  it('YAML aliases and merge keys are resolved', () => {
    const k = 'kind: Pod\nmetadata: {name: p}\nspec:\n  containers:\n    - name: c\n      env:\n        - &shared {name: A, value: "1"}\n    - name: d\n      env:\n        - *shared\n';
    expect(scan('k.yaml', 'Kubernetes', k).declarations.map(d => d.resource)).toEqual(['Pod/p/c', 'Pod/p/d']);
    const c = 'x-env: &env {SHARED: "1"}\nx-base: &base\n  environment: {BASE: "1"}\nservices:\n  web:\n    environment: {<<: *env, OWN: "2"}\n  api:\n    <<: *base\n';
    expect(names('docker-compose.yml', 'Docker Compose', c).sort()).toEqual(['BASE', 'OWN', 'SHARED']);
  });

  it('Kubernetes List items; ECS Secrets and EnvironmentFiles; null compose environment', () => {
    expect(scan('k.yaml', 'Kubernetes', 'kind: List\nitems:\n  - kind: Pod\n    metadata: {name: p}\n    spec:\n      containers:\n        - name: c\n          env: [{name: A, value: "1"}]\n').declarations[0].resource).toBe('Pod/p/c');
    const cfn = 'Resources:\n  T:\n    Type: AWS::ECS::TaskDefinition\n    Properties:\n      ContainerDefinitions:\n        - Name: app\n          Secrets: [{Name: DB_PASSWORD, ValueFrom: arn}]\n          EnvironmentFiles: [{Value: arn, Type: s3}]\n';
    const r = scan('t.yaml', 'CloudFormation', cfn);
    expect(r.declarations.map(d => `${d.name} ${d.literalValue}`)).toEqual(['DB_PASSWORD false']);
    expect(r.opaque.map(o => o.reason)).toEqual([expect.stringContaining('EnvironmentFiles')]);
    expect(scan('docker-compose.yml', 'Docker Compose', 'services:\n  a:\n    environment:\n')).toEqual({ declarations: [], opaque: [] });
  });

  it('an empty value is not literal in any ecosystem', () => {
    expect(scan('k.yaml', 'Kubernetes', 'kind: Pod\nmetadata: {name: p}\nspec:\n  containers:\n    - name: c\n      env: [{name: E, value: ""}]\n').declarations[0].literalValue).toBe(false);
    expect(scan('Dockerfile', 'Dockerfile', 'ENV E=\n').declarations[0].literalValue).toBe(false);
  });

  it('hostile input stays linear (8x the input, well under 64x the time)', () => {
    const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };
    const nested = (n: number) => `resource "aws_lambda_function" "f" {\n  environment {\n${'    variables = {\n'.repeat(n)}  }\n}\n`;
    const cont = (n: number) => `ENV A=1 \\\n${'  B=2 \\\n'.repeat(n)}  C=3\n`;
    for (const [label, gen, lang] of [['tf', nested, 'Terraform'], ['df', cont, 'Dockerfile']] as const) {
      const p = label === 'tf' ? 'm.tf' : 'Dockerfile';
      time(() => scan(p, lang, gen(1000)));
      const a = Math.min(time(() => scan(p, lang, gen(2000))), time(() => scan(p, lang, gen(2000))));
      const b = Math.min(time(() => scan(p, lang, gen(16000))), time(() => scan(p, lang, gen(16000))));
      expect(b / Math.max(a, 1)).toBeLessThan(24);
    }
  });
});
