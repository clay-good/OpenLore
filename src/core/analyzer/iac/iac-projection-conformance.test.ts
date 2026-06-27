/**
 * Per-ecosystem IaC projection CONFORMANCE sweep (change: add-language-capability-conformance).
 *
 * The `iacProjection` capability is claimed for 12 ecosystems (`IAC_LANGUAGES`). This drives the real
 * projector (`buildProjectedIac`) against a minimal realistic fixture for every one of them and
 * asserts the projection genuinely fires — resources/jobs/tasks become graph nodes, and where the
 * ecosystem models a cross-reference, a `references`/`depends_on` edge is produced. A coverage guard
 * fails if `IAC_LANGUAGES` grows without a fixture, so the IaC matrix can never silently over-claim.
 *
 * Findings (2026-06-26): all 12 ecosystems project nodes; 8 of them produce reference/dependency
 * edges from a simple two-resource fixture (Terraform, Kubernetes, CloudFormation, Ansible,
 * Dockerfile, Docker Compose, GitHub Actions, Bicep). Helm/Pulumi/CDK/CDKTF project nodes from a
 * single-resource fixture (edges require a cross-reference the minimal fixture omits) — asserted at
 * node level. Pulumi/CDK/CDKTF ride on host languages (TS/JS/Python/Go), not an IaC file tag.
 */
import { describe, it, expect } from 'vitest';
import { buildProjectedIac, IAC_LANGUAGES } from './index.js';

interface InFile { path: string; content: string; language: string }
interface EcoCase {
  eco: string;
  files: InFile[];
  minNodes: number;
  expectNames: string[];
  expectEdgeKind?: 'references' | 'depends_on';
}

const CASES: EcoCase[] = [
  {
    eco: 'Terraform', minNodes: 2, expectNames: ['aws_s3_bucket.logs'], expectEdgeKind: 'references',
    files: [{ path: 'main.tf', language: 'Terraform', content: `resource "aws_s3_bucket" "logs" {}\nresource "aws_s3_bucket_policy" "p" {\n  bucket = aws_s3_bucket.logs.id\n}\n` }],
  },
  {
    eco: 'Kubernetes', minNodes: 2, expectNames: ['Deployment/web', 'ConfigMap/web-config'], expectEdgeKind: 'references',
    files: [{ path: 'app.yaml', language: 'Kubernetes', content: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          envFrom:\n            - configMapRef:\n                name: web-config\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\n` }],
  },
  {
    eco: 'Helm', minNodes: 2, expectNames: ['chart.mychart'],
    files: [
      { path: 'mychart/Chart.yaml', language: 'Helm', content: `apiVersion: v2\nname: mychart\nversion: 0.1.0\n` },
      { path: 'mychart/templates/deployment.yaml', language: 'Helm', content: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}-web\n` },
    ],
  },
  {
    eco: 'CloudFormation', minNodes: 2, expectNames: ['Bucket', 'Policy'], expectEdgeKind: 'references',
    files: [{ path: 'tmpl.yaml', language: 'CloudFormation', content: `Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n  Policy:\n    Type: AWS::S3::BucketPolicy\n    Properties:\n      Bucket: !Ref Bucket\n` }],
  },
  {
    eco: 'Ansible', minNodes: 2, expectNames: [], expectEdgeKind: 'references',
    files: [
      { path: 'site.yml', language: 'Ansible', content: `- hosts: all\n  tasks:\n    - name: a\n      include_tasks: tasks/a.yml\n` },
      { path: 'tasks/a.yml', language: 'Ansible', content: `- name: ping\n  ping:\n` },
    ],
  },
  {
    eco: 'Pulumi', minNodes: 1, expectNames: ['Bucket:my-bucket'],
    files: [{ path: 'index.ts', language: 'TypeScript', content: `import * as aws from '@pulumi/aws';\nconst bucket = new aws.s3.Bucket('my-bucket');\n` }],
  },
  {
    eco: 'CDK', minNodes: 1, expectNames: ['Bucket:B'],
    files: [{ path: 'app.ts', language: 'TypeScript', content: `import * as s3 from 'aws-cdk-lib/aws-s3';\nexport class S extends Stack {\n  constructor(){ super(); new s3.Bucket(this, 'B'); }\n}\n` }],
  },
  {
    eco: 'CDKTF', minNodes: 1, expectNames: ['S3Bucket:b'],
    files: [{ path: 'cdktf.ts', language: 'TypeScript', content: `import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';\nexport class S extends TerraformStack {\n  constructor(){ super(); new S3Bucket(this, 'b', {}); }\n}\n` }],
  },
  {
    eco: 'Dockerfile', minNodes: 2, expectNames: ['Dockerfile::build'], expectEdgeKind: 'references',
    files: [{ path: 'Dockerfile', language: 'Dockerfile', content: `FROM node:20 AS build\nRUN echo hi\nFROM build AS final\n` }],
  },
  {
    eco: 'Docker Compose', minNodes: 2, expectNames: ['docker-compose.yml::service.api', 'docker-compose.yml::service.db'], expectEdgeKind: 'depends_on',
    files: [{ path: 'docker-compose.yml', language: 'Docker Compose', content: `services:\n  api:\n    build: ./api\n    depends_on:\n      - db\n  db:\n    image: postgres:16\n` }],
  },
  {
    eco: 'GitHub Actions', minNodes: 2, expectNames: ['.github/workflows/ci.yml::job.build', '.github/workflows/ci.yml::job.test'], expectEdgeKind: 'depends_on',
    files: [{ path: '.github/workflows/ci.yml', language: 'GitHub Actions', content: `name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n  test:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n` }],
  },
  {
    eco: 'Bicep', minNodes: 2, expectNames: ['sa', 'blob'], expectEdgeKind: 'references',
    files: [{ path: 'main.bicep', language: 'Bicep', content: `resource sa 'Microsoft.Storage/storageAccounts@2022-09-01' = {\n  name: 'mystore'\n}\nresource blob 'Microsoft.Storage/storageAccounts/blobServices@2022-09-01' = {\n  parent: sa\n  name: 'default'\n}\n` }],
  },
];

describe('IaC projection conformance — every claimed ecosystem', () => {
  it('covers every ecosystem in IAC_LANGUAGES', () => {
    const covered = new Set(CASES.map((c) => c.eco));
    const uncovered = [...IAC_LANGUAGES].filter((l) => !covered.has(l));
    expect(uncovered, `IaC ecosystems with no conformance fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  for (const c of CASES) {
    it(`${c.eco}: projects resources onto graph nodes`, () => {
      const p = buildProjectedIac(c.files);
      expect(p.nodes.length, `${c.eco} node count`).toBeGreaterThanOrEqual(c.minNodes);
      const names = p.nodes.map((n) => n.name);
      for (const expected of c.expectNames) {
        expect(names, `${c.eco} expected node ${expected}`).toContain(expected);
      }
    });

    if (c.expectEdgeKind) {
      it(`${c.eco}: projects a ${c.expectEdgeKind} edge`, () => {
        const p = buildProjectedIac(c.files);
        const kinds = new Set(p.edges.map((e) => e.kind));
        expect(kinds.has(c.expectEdgeKind!), `${c.eco} ${c.expectEdgeKind} edge`).toBe(true);
      });
    }
  }
});
