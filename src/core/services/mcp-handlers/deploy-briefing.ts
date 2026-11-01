/**
 * The infrastructure a handler in scope depends on (change: add-iac-deploy-binding-commands).
 *
 * `analyze_env_impact` answers "what breaks if I rename this variable?" and `analyze_impact`
 * crosses to infrastructure when asked. An agent about to edit a deployed handler should see,
 * unasked, the two facts it cannot read off the function itself: which resource runs it, and
 * which infrastructure site sets each environment variable it reads.
 *
 * Both come from indexed evidence, not inference: a `deploys_symbol` edge the deploy binder
 * resolved literally, and the declaration sites the env-declaration scan found. The scan is the
 * expensive half, so it runs ONLY when a function in scope actually reads a variable — a task
 * that touches no handler pays nothing.
 *
 * Read-only, bounded, fail-quiet.
 */

import type { FunctionNode, SerializedCallGraph } from '../../analyzer/call-graph.js';

/** Resources named per briefing. */
const MAX_RESOURCES = 5;
/** Variables named per briefing, and declaration sites per variable. */
const MAX_VARS = 8;
const MAX_SITES = 3;
/** Files re-scanned for environment reads. */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 512 * 1024;

export interface DeployedResource {
  /** `aws_lambda_function.orders`. */
  resource: string;
  /** The ecosystem tag the resource node carries. */
  ecosystem: string;
  /** `main.tf:12`. */
  declaredAt: string;
  /** The function in scope it runs. */
  runs: string;
}

export interface EnvSite { ecosystem: string; resource: string; at: string }

export interface InfrastructureBriefing {
  /** Resources bound to a function in scope by a `deploys_symbol` edge. */
  deployedBy: DeployedResource[];
  /** Environment variables functions in scope read, with the sites that set each. */
  environment: Array<{ name: string; setBy: EnvSite[]; setByOmitted?: number; undeclared?: true }>;
  omitted?: { resources?: number; variables?: number };
  /** What the infrastructure scan could not read, so `undeclared` is never an absolute claim. */
  scanBoundaries?: string[];
  note: string;
}

/**
 * The infrastructure facts for `functions` (the orient scope), or undefined when there are none:
 * no resource runs them and none of them reads a variable.
 */
export async function infrastructureForFunctions(
  root: string,
  cg: SerializedCallGraph,
  functions: ReadonlyArray<{ name: string; filePath: string }>,
): Promise<InfrastructureBriefing | undefined> {
  if (!functions.length) return undefined;
  const { emittedText } = await import('../generated-file-guard.js');
  const inScope = new Set(functions.map(f => `${f.filePath}\0${f.name}`));
  const nodeById = new Map(cg.nodes.map(n => [n.id, n]));
  const isInScope = (n: FunctionNode | undefined): boolean => !!n && inScope.has(`${n.filePath}\0${n.name}`);

  // ── Which resource runs a function in scope ──────────────────────────────
  const deployed: DeployedResource[] = [];
  for (const e of cg.edges) {
    if (e.kind !== 'deploys_symbol') continue;
    const target = nodeById.get(e.calleeId);
    if (!isInScope(target)) continue;
    const resource = nodeById.get(e.callerId);
    if (!resource) continue;
    deployed.push({
      resource: emittedText(resource.name),
      ecosystem: emittedText(resource.language),
      declaredAt: emittedText(`${resource.filePath}:${resource.startLine ?? 1}`),
      runs: emittedText(target!.name),
    });
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  deployed.sort((a, b) => cmp(a.resource, b.resource) || cmp(a.runs, b.runs));

  // ── Which variables they read, and which site sets each ──────────────────
  const files = [...new Set(functions.map(f => f.filePath))].slice(0, MAX_FILES);
  const spans = new Map<string, Array<{ start: number; end: number }>>();
  for (const f of functions) {
    const node = cg.nodes.find(n => n.filePath === f.filePath && n.name === f.name);
    if (!node?.startLine) continue;
    const at = spans.get(f.filePath) ?? [];
    at.push({ start: node.startLine, end: node.endLine ?? node.startLine });
    spans.set(f.filePath, at);
  }
  const names = new Set<string>();
  try {
    const { extractEnvReadSites } = await import('../../analyzer/env-extractor.js');
    const { readFileConfined } = await import('../../../utils/path-confinement.js');
    for (const file of files) {
      const at = spans.get(file);
      if (!at?.length) continue;
      const content = await readFileConfined(root, file, MAX_FILE_BYTES).catch(() => null);
      if (content === null) continue;
      const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')).toLowerCase() : '';
      for (const site of extractEnvReadSites(content, file, ext)) {
        if (!at.some(s => site.line >= s.start && site.line <= s.end)) continue;
        names.add(site.name);
      }
    }
  } catch { /* an unreadable scope simply contributes no variable */ }

  if (!deployed.length && !names.size) return undefined;

  const environment: InfrastructureBriefing['environment'] = [];
  const scanBoundaries: string[] = [];
  if (names.size) {
    const wanted = [...names].sort().slice(0, MAX_VARS);
    try {
      const { scanEnvDeclarations } = await import('../env-declaration-scan.js');
      const scan = await scanEnvDeclarations(root);
      scanBoundaries.push(...scan.boundaries);
      for (const name of wanted) {
        const sites = scan.declarations.filter(d => d.name === name)
          .map(d => ({ ecosystem: d.ecosystem, resource: emittedText(d.resource), at: emittedText(`${d.file}:${d.line}`) }))
          .sort((a, b) => cmp(a.at, b.at));
        environment.push({
          name: emittedText(name),
          setBy: sites.slice(0, MAX_SITES),
          ...(sites.length > MAX_SITES ? { setByOmitted: sites.length - MAX_SITES } : {}),
          ...(sites.length ? {} : { undeclared: true as const }),
        });
      }
    } catch {
      // The scan is the only part that can fail; the variables themselves are still worth naming.
      for (const name of wanted) environment.push({ name: emittedText(name), setBy: [] });
      scanBoundaries.push('The infrastructure scan failed, so no variable here is known to be set or unset.');
    }
  }

  const omitted = {
    ...(deployed.length > MAX_RESOURCES ? { resources: deployed.length - MAX_RESOURCES } : {}),
    ...(names.size > MAX_VARS ? { variables: names.size - MAX_VARS } : {}),
  };
  return {
    deployedBy: deployed.slice(0, MAX_RESOURCES),
    environment,
    ...(Object.keys(omitted).length ? { omitted } : {}),
    ...(scanBoundaries.length ? { scanBoundaries: [...new Set(scanBoundaries)].map(emittedText) } : {}),
    note: 'The infrastructure a function in scope depends on: the resource that runs it (a literally resolved handler binding) and the sites that set each environment variable it reads. A variable marked `undeclared` is set by nothing the scan read — it may come from the deployment environment, or from a source `scanBoundaries` names. `analyze_env_impact` gives the full blast radius of one variable.',
  };
}
