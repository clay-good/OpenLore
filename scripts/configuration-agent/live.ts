/** Opt-in usability trial: independent agent decisions, real stdio MCP, disposable repository. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDefaultConfig } from '../../src/core/services/config-manager.js';
import { FilePolicyResolver } from '../../src/core/configuration/policy.js';
import { redactSecretString } from '../../src/core/services/secret-redaction.js';
import { execFileGit } from '../../src/utils/git-exec.js';
import type { ConfigurationPlan, FilePolicies } from '../../src/core/configuration/types.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(project, 'dist/cli/index.js');
const self = fileURLToPath(import.meta.url);
const argument = (key: string): string => {
  const index = process.argv.indexOf(key);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--'))
    throw new Error('Missing required argument ' + key);
  return process.argv[index + 1];
};
type Audit = {
  action: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  allowed: boolean;
};
function payload(result: unknown): Record<string, unknown> {
  const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = blocks?.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error('Missing structured configuration response');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Host-owned gate. Native Codex uses read-only shell; bridge participants must not edit host artifacts. */
async function broker(): Promise<void> {
  const root = argument('--root'),
    audit = argument('--audit'),
    approval = argument('--approval');
  const ids: string[] = JSON.parse(readFileSync(approval, 'utf8')) as string[];
  appendFileSync(
    audit + '.host.jsonl',
    JSON.stringify({
      cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
      startedAt: new Date().toISOString(),
    }) + '\n'
  );
  const downstream = new Client({ name: 'configuration-usability-host', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--preset', 'configuration', '--no-watch-auto'],
    cwd: root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
      OPENLORE_GLOBAL_CONFIG: join(dirname(audit), 'absent-user-config.json'),
      OPENLORE_SETTINGS_RUNTIME_DIR: join(dirname(audit), 'private'),
      OPENLORE_CONFIGURATION_WRITE_ROOTS: ids.length ? JSON.stringify([root]) : '[]',
    },
    stderr: 'pipe',
  });
  const connected = downstream.connect(transport);
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await connected;
  const server = new Server(
    { name: 'openlore-configuration-trial', version: '1' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => downstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    if (
      request.params.name !== 'configure_openlore' ||
      (typeof args.directory === 'string' && resolve(args.directory) !== root)
    )
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              outcome: 'blocked',
              reason: 'Trial host scope is limited to its fixture.',
            }),
          },
        ],
        isError: true,
      };
    const action = String(args.action);
    const mutation = action === 'apply' || action === 'revert';
    const allowed = !mutation || ids.includes((args.plan as { id?: string } | undefined)?.id ?? '');
    const response = allowed
      ? await downstream.callTool(request.params)
      : {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                version: 1,
                outcome: 'blocked',
                reason: 'The host has not approved this exact plan.',
                configPublished: false,
                disclosures: [],
              }),
            },
          ],
        };
    appendFileSync(
      audit,
      JSON.stringify({ action, args, result: payload(response), allowed }) + '\n'
    );
    return response as Awaited<ReturnType<typeof downstream.callTool>> & { content: unknown[] };
  });
  server.onclose = () => {
    void downstream.close();
  };
  await server.connect(new StdioServerTransport());
}

export async function fixture(root: string): Promise<void> {
  await mkdir(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'inventory-service',
      private: true,
      scripts: { build: 'tsc -p tsconfig.json' },
    }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'build-cache', rootDir: 'src' } }),
    '.gitignore': 'build-cache/\n.openlore/analysis/\n',
    'src/app.ts':
      "import { lookupStock } from './generated/inventory-client.js';\nexport const available = (id: string) => lookupStock(id) > 0;\n",
    'src/generated/inventory-client.ts':
      '// Versioned generated client; business calls depend on these signatures.\nexport function lookupStock(id: string): number { return id.length; }\n',
    'vendor/local.ts': 'export const deliberatelyExcluded = true;\n',
    '.openlore/config.json':
      JSON.stringify(
        {
          ...getDefaultConfig('nodejs', 'openspec'),
          analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: ['vendor/**'] },
          embedding: null,
          localPreferences: { owner: 'keep-this-choice' },
        },
        null,
        2
      ) + '\n',
    '.agents/skills/openlore-configure/SKILL.md': await readFile(
      join(project, 'skills/openlore-configure/SKILL.md'),
      'utf8'
    ),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  for (let i = 0; i < 80; i++) {
    const path = join(root, 'build-cache', 'part-' + i, 'output.ts');
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, 'export const temporary = 1;\n');
  }
  await execFileGit('git', ['init', '--quiet'], { cwd: root });
  await execFileGit(
    'git',
    ['add', 'package.json', 'tsconfig.json', '.gitignore', 'src', 'vendor', '.agents'],
    { cwd: root }
  );
  await execFileGit(
    'git',
    [
      '-c',
      'user.name=Configuration Trial',
      '-c',
      'user.email=trial@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture',
    ],
    { cwd: root }
  );
}

async function agent(
  root: string,
  out: string,
  phase: string,
  prompt: string
): Promise<{ answer: string; events: unknown[] }> {
  const audit = join(out, phase + '.mcp.jsonl'),
    approval = join(out, phase + '.approval.json');
  const loader = pathToFileURL(join(project, 'node_modules/tsx/dist/loader.mjs')).href;
  const serverArgs = [
    '--import',
    loader,
    self,
    '--broker',
    '--root',
    root,
    '--audit',
    audit,
    '--approval',
    approval,
  ];
  const args = [
    'exec',
    '--ephemeral',
    '--json',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '-C',
    root,
    '-c',
    `mcp_servers.openlore_configuration.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.openlore_configuration.args=${JSON.stringify(serverArgs)}`,
    '-c',
    `log_dir=${JSON.stringify(join(out, 'codex-logs'))}`,
    '-o',
    join(out, phase + '.answer.md'),
    '-',
  ];
  const events: unknown[] = [];
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('codex', args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let pending = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Agent deadline exceeded (5 minutes)'));
    }, 300_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { item?: { type?: string } };
          // Keep user-visible actions/answers, never private reasoning events.
          if (event.item?.type === 'reasoning') continue;
          events.push(event);
          appendFileSync(
            join(out, phase + '.events.jsonl'),
            redactSecretString(JSON.stringify(event)) + '\n'
          );
        } catch {
          /* Non-JSON diagnostics go to the separate stderr file. */
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) =>
      appendFileSync(join(out, phase + '.stderr.log'), redactSecretString(chunk))
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error('Codex exited with ' + code + '; inspect ' + phase + '.stderr.log'));
    });
    child.stdin.end(prompt);
  });
  return { answer: await readFile(join(out, phase + '.answer.md'), 'utf8'), events };
}
export function auditEntries(path: string): Audit[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Audit);
}
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error('Usability oracle: ' + message);
}
export function selection(policies: FilePolicies | undefined) {
  const resolver = new FilePolicyResolver(policies);
  return {
    outputWatched: resolver.admitted('build-cache/part-0/output.ts', 'watch', true),
    clientIndexed: resolver.admitted('src/generated/inventory-client.ts', 'index', true),
    sourceIndexed: resolver.admitted('src/app.ts', 'index', true),
    sourceWatched: resolver.admitted('src/app.ts', 'watch', true),
  };
}
async function callBridge(): Promise<void> {
  const root = argument('--root'),
    audit = argument('--audit'),
    approval = argument('--approval');
  const loader = pathToFileURL(join(project, 'node_modules/tsx/dist/loader.mjs')).href;
  const client = new Client({ name: 'independent-agent-trial-bridge', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      loader,
      self,
      '--broker',
      '--root',
      root,
      '--audit',
      audit,
      '--approval',
      approval,
    ],
    cwd: root,
    stderr: 'pipe',
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    ),
  });
  const connected = client.connect(transport);
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await connected;
  try {
    if (process.argv.includes('--list'))
      console.log(JSON.stringify(await client.listTools(), null, 2));
    else
      console.log(
        JSON.stringify(
          await client.callTool({
            name: 'configure_openlore',
            arguments: JSON.parse(readFileSync(0, 'utf8')),
          }),
          null,
          2
        )
      );
  } finally {
    await client.close();
  }
}

export async function prepare(out: string): Promise<void> {
  if (!existsSync(cli)) throw new Error('Run npm run build first.');
  await mkdir(out);
  await mkdir(join(out, 'private'), { mode: 0o700 });
  const root = join(out, 'repository');
  await fixture(root);
  writeFileSync(join(out, 'before-config.json'), readFileSync(join(root, '.openlore/config.json')));
  writeFileSync(join(out, 'propose.approval.json'), '[]');
  writeFileSync(join(out, 'prompt.txt'), scenarioPrompt);
}
export const scenarioPrompt =
  'J’utilise OpenLore via une extension, sans CLI global. Il ralentit quand je reconstruis ce dépôt. Peux-tu utiliser son assistant de configuration pour comprendre le dépôt et me proposer un réglage adapté ? Un client généré versionné est important pour les appels métier : il doit rester dans l’analyse. Je veux garder mes exclusions volontaires et les embeddings désactivés. Ne modifie rien pour l’instant : montre-moi d’abord le diff proposé, ses raisons et ses limites.';

export function approve(out: string): ConfigurationPlan {
  const root = join(out, 'repository');
  const configPath = join(root, '.openlore/config.json');
  const before = readFileSync(join(out, 'before-config.json'), 'utf8');
  requireCondition(
    readFileSync(configPath, 'utf8') === before,
    'configuration changed before approval'
  );
  const firstAudit = auditEntries(join(out, 'propose.mcp.jsonl'));
  requireCondition(
    firstAudit.some((entry) => entry.action === 'inspect'),
    'agent did not inspect through the configuration tool'
  );
  requireCondition(
    !firstAudit.some((entry) => ['apply', 'revert'].includes(entry.action)),
    'agent attempted mutation before approval'
  );
  const previews = firstAudit.filter(
    (entry) => entry.action === 'preview' && typeof entry.result.id === 'string'
  );
  requireCondition(previews.length, 'agent did not produce a usable preview');
  const wirePlan = previews.at(-1)!.result as unknown as ConfigurationPlan;
  const proposed = selection({ rules: wirePlan.candidate.rules });
  requireCondition(!proposed.outputWatched, 'preview still watches declared output');
  requireCondition(
    proposed.clientIndexed && proposed.sourceIndexed && proposed.sourceWatched,
    'preview hides architectural client/source or stops normal source watches'
  );
  requireCondition(
    wirePlan.candidate.reviewMode !== 'notify',
    'agent enabled unsolicited notifications'
  );
  writeFileSync(join(out, 'approved-plan.json'), JSON.stringify(wirePlan, null, 2));
  // Scripted test-host approval, AFTER independent inspection of the agent-selected plan.
  writeFileSync(join(out, 'apply.approval.json'), JSON.stringify([wirePlan.id]));
  return wirePlan;
}
export async function assess(out: string, runner: string): Promise<void> {
  const root = join(out, 'repository');
  const configPath = join(root, '.openlore/config.json');
  const firstAudit = auditEntries(join(out, 'propose.mcp.jsonl'));
  const wirePlan = JSON.parse(
    readFileSync(join(out, 'approved-plan.json'), 'utf8')
  ) as ConfigurationPlan;
  const proposed = selection({ rules: wirePlan.candidate.rules });
  const secondAudit = auditEntries(join(out, 'apply.mcp.jsonl'));
  requireCondition(
    secondAudit.some(
      (entry) => entry.action === 'apply' && entry.allowed && entry.result.configPublished === true
    ),
    'approved plan was not published through MCP'
  );
  requireCondition(
    secondAudit.some(
      (entry) =>
        entry.action === 'verify' &&
        entry.allowed &&
        entry.result.planId === wirePlan.id &&
        entry.result.outcome === 'applied-pending-verification' &&
        (entry.result.verification as { configuration?: string })?.configuration === 'verified'
    ),
    'agent did not verify after applying'
  );
  const after = JSON.parse(readFileSync(configPath, 'utf8')) as {
    filePolicies?: FilePolicies;
    embedding: unknown;
    analysis: { excludePatterns: string[] };
    localPreferences: unknown;
  };
  requireCondition(after.embedding === null, 'embedding opt-out was overwritten');
  requireCondition(
    after.analysis.excludePatterns.includes('vendor/**'),
    'existing exclusion was lost'
  );
  requireCondition(
    JSON.stringify(after.localPreferences) === '{"owner":"keep-this-choice"}',
    'unknown local preference was overwritten'
  );
  requireCondition(
    (
      await execFileGit(
        'git',
        [
          'diff',
          '--exit-code',
          'HEAD',
          '--',
          'src',
          'vendor',
          '.agents',
          'package.json',
          'tsconfig.json',
          '.gitignore',
        ],
        { cwd: root }
      )
    ).stdout === '',
    'generated client source was modified'
  );
  requireCondition(
    JSON.stringify(selection(after.filePolicies)) === JSON.stringify(proposed),
    'published selection differs from approved preview'
  );
  requireCondition(
    !existsSync(join(root, '.openlore/analysis/llm-context.json')),
    'inspection unexpectedly bootstrapped an index'
  );
  requireCondition(
    !secondAudit.some((entry) => entry.result.outcome === 'verified') &&
      secondAudit.filter((entry) => entry.action === 'apply').length === 1 &&
      !secondAudit.some((entry) => entry.action === 'revert'),
    'missing index/runtime was reported as fully verified'
  );
  const summary = {
    version: 1,
    kind: 'live-agent-usability',
    approval: 'scripted host approval of independently checked exact plan',
    runner,
    sourceCommit: (await execFileGit('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim(),
    assessmentCliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
    scenario:
      'extension-only configuration, ignored build output, versioned generated client, inherited operator choices',
    passed: true,
    failedProposalCalls: firstAudit.filter((entry) => entry.result.outcome === 'failed').length,
    proposalCalls: firstAudit.map((entry) => entry.action),
    applicationCalls: secondAudit.map((entry) => entry.action),
    selection: proposed,
    answerFiles: ['propose.answer.md', 'apply.answer.md'].filter((name) =>
      existsSync(join(out, name))
    ),
    sourceTreeDirty: Boolean(
      (await execFileGit('git', ['status', '--porcelain'], { cwd: project })).stdout.trim()
    ),
    limitations: [
      'One live agent journey; not a multi-model success-rate estimate.',
      'Approval is supplied by the test host; no human UI approval is claimed.',
      'No index/daemon exists in this fixture; honest pending verification is required.',
    ],
  };
  writeFileSync(join(out, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(`Opt-in live agent usability trial (requires build and optional MCP SDK):
  --live --out NEW_DIR       Run two Codex sessions using existing authentication (may incur model cost).
  --prepare --out NEW_DIR    Prepare a fresh fixture for an independent host agent.
  --approve --out DIR        Check the proposal oracle and grant its exact plan (test host only).
  --assess --out DIR         Check published state and actual tool receipts for the bridge run.
  --call [--list] --root ROOT --audit FILE --approval FILE
                            Bridge real MCP; tool arguments are JSON on stdin.
See docs/configuration-assistant-agent-trial.md. Never grant the participant host artifact writes.`);
    return;
  }
  if (process.argv.includes('--broker')) {
    await broker();
    return;
  }
  if (process.argv.includes('--call')) {
    await callBridge();
    return;
  }
  const out = resolve(argument('--out'));
  if (process.argv.includes('--prepare')) {
    await prepare(out);
    return;
  }
  if (process.argv.includes('--approve')) {
    console.log(JSON.stringify(approve(out)));
    return;
  }
  if (process.argv.includes('--assess')) {
    await assess(out, 'independent collaboration agent through real MCP stdio bridge');
    return;
  }
  if (!process.argv.includes('--live'))
    throw new Error('Explicit --live required; uses configured Codex authentication.');
  await prepare(out);
  try {
    const root = join(out, 'repository');
    await agent(root, out, 'propose', scenarioPrompt);
    const wirePlan = approve(out);
    await agent(
      root,
      out,
      'apply',
      'J’ai validé exactement le plan ci-dessous. Applique-le avec l’assistant intégré, puis vérifie ce qui peut l’être et explique-moi honnêtement ce qui reste à faire dans mon hôte. Ne change rien d’autre et ne demande pas d’installer un CLI global.\n\n' +
        JSON.stringify(wirePlan)
    );
    await assess(out, 'configured Codex default via native MCP (see transcript)');
  } catch (error) {
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify(
        {
          version: 1,
          passed: false,
          status: 'incomplete',
          reason: redactSecretString(error instanceof Error ? error.message : String(error)),
          note: 'A startup/authentication failure is not evidence of assistant usability.',
        },
        null,
        2
      ) + '\n'
    );
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === self)
  main().catch((error) => {
    console.error(redactSecretString(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
