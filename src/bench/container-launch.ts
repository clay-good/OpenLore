import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreregisteredRule } from './preregistered-rule.js';

export interface BenchmarkContainerSpec {
  baseImage: string;
  definitionSha256: string;
  tag: string;
}

export function readBenchmarkContainerSpec(root: string, expectedBaseImage: string): BenchmarkContainerSpec {
  const dockerfile = readFileSync(join(root, 'bench', 'Dockerfile'), 'utf8');
  const declaredBase = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
  if (declaredBase !== expectedBaseImage) {
    throw new Error(`Benchmark Dockerfile base does not match the corpus image: ${String(declaredBase)}.`);
  }
  const definitionHash = createHash('sha256');
  for (const path of [
    'bench/Dockerfile',
    'bench/container-entrypoint.sh',
    'bench/container/package.json',
    'bench/container/package-lock.json',
  ]) {
    definitionHash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  }
  const definitionSha256 = definitionHash.digest('hex');
  return {
    baseImage: expectedBaseImage,
    definitionSha256,
    tag: `openlore-benchmark:${definitionSha256.slice(0, 16)}`,
  };
}

export function launchBenchmarkContainer(
  root: string,
  spec: BenchmarkContainerSpec,
  rule: PreregisteredRule,
  args: string[],
): void {
  execFileSync('docker', ['build', '--file', join(root, 'bench', 'Dockerfile'), '--tag', spec.tag, join(root, 'bench')], {
    cwd: root,
    stdio: 'inherit',
  });
  const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', spec.tag], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error(`Docker returned an invalid benchmark image id: ${imageId}.`);

  const dockerArgs = [
    'run', '--rm',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--workdir', '/workspace',
    '--tmpfs', `/workspace:rw,exec,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000}`,
    '--volume', `${root}:/source:ro`,
    '--volume', `${join(root, 'bench', 'results')}:/results`,
    '--env', 'HOME=/tmp/openlore-bench-home',
    '--env', `OPENLORE_BENCH_RUNTIME_IMAGE_ID=${imageId}`,
    '--env', `OPENLORE_BENCH_DEFINITION_SHA256=${spec.definitionSha256}`,
    '--env', `OPENLORE_BENCH_RULE_PATH=${rule.path}`,
    '--env', `OPENLORE_BENCH_RULE_SHA256=${rule.sha256}`,
    '--env', `OPENLORE_BENCH_RULE_COMMIT=${rule.commit}`,
  ];
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) {
    if (process.env[name]) dockerArgs.push('--env', name);
  }
  dockerArgs.push(imageId, ...args);
  execFileSync('docker', dockerArgs, { cwd: root, stdio: 'inherit' });
}
