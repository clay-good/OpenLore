/**
 * Environment-variable declaration sites in infrastructure files (change: add-iac-code-binding).
 *
 * Where a deployment SETS an env var: a Kubernetes container `env`, a compose `environment`, a
 * Dockerfile `ENV`, a Terraform/OpenTofu or CloudFormation/SAM function environment map, an ECS
 * container definition, or a GitHub Actions `env`. Each site records the key, the ecosystem, the
 * resource, the file and line, and whether a value is written there literally — NEVER the value.
 *
 * A source that sets variables this reader cannot enumerate (Kubernetes `envFrom`, compose
 * `env_file`, an environment map built by an expression) is returned as an opaque source, so the
 * caller can say the variable may be set there instead of implying it is not.
 *
 * Pure and deterministic: one file in, sites out. No I/O, no rendering (Helm), no `terraform plan`.
 */

import { LineCounter, parseAllDocuments, isMap, isSeq, isScalar, type Node } from 'yaml';
import { scanHclBlocks } from './terraform.js';

export type EnvEcosystem = 'Kubernetes' | 'Docker Compose' | 'Dockerfile' | 'Terraform' | 'CloudFormation' | 'GitHub Actions';

export interface EnvDeclaration {
  name: string;
  ecosystem: EnvEcosystem;
  /** The resource that sets it: `Deployment/api`, `service/web`, `aws_lambda_function.orders`, `job/build`. */
  resource: string;
  file: string;
  line: number;
  /** Whether a value is written at this site as a literal (no interpolation, reference, or secret source). */
  literalValue: boolean;
}

/** A place that sets variables this reader cannot enumerate. */
export interface OpaqueEnvSource {
  ecosystem: EnvEcosystem;
  resource: string;
  file: string;
  line: number;
  reason: string;
}

export interface EnvDeclarationScan {
  declarations: EnvDeclaration[];
  opaque: OpaqueEnvSource[];
}

/** Interpolation or substitution markers: a value containing one is not literal. */
const INTERPOLATED = /\$\{|\$\(|\$[A-Za-z_]|\{\{/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

type Pair = { key: unknown; value: unknown };
const keyOf = (p: Pair): string | undefined => (isScalar(p.key) && typeof p.key.value === 'string' ? p.key.value : undefined);
const pairsOf = (n: unknown): Pair[] => (isMap(n) ? (n.items as Pair[]) : []);
const get = (n: unknown, key: string): unknown => pairsOf(n).find(p => keyOf(p) === key)?.value;
const strOf = (n: unknown): string | undefined => (isScalar(n) && n.value !== null && n.value !== undefined ? String(n.value) : undefined);

/** Whether a YAML value node is a literal written value (a plain scalar, no tag, no interpolation). */
function literalNode(n: unknown): boolean {
  if (!isScalar(n) || n.value === null || n.value === undefined) return false;
  if ((n as { tag?: string }).tag && !(n as { tag?: string }).tag!.startsWith('tag:yaml.org')) return false;
  return !INTERPOLATED.test(String(n.value));
}

export function extractEnvDeclarations(file: { path: string; content: string; language: string }): EnvDeclarationScan {
  const out: EnvDeclarationScan = { declarations: [], opaque: [] };
  try {
    switch (file.language) {
      case 'Dockerfile': dockerfile(file, out); break;
      case 'Terraform': terraform(file, out); break;
      case 'Kubernetes': case 'Docker Compose': case 'CloudFormation': case 'GitHub Actions': yamlLike(file, out); break;
      default: break;
    }
  } catch {
    // A file that cannot be read yields nothing here; the caller discloses parse limits.
  }
  return out;
}

// ── Dockerfile ──────────────────────────────────────────────────────────────

function dockerfile(file: { path: string; content: string }, out: EnvDeclarationScan): void {
  const lines = file.content.split('\n');
  let stage = 'Dockerfile';
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let text = lines[i];
    // Join line continuations.
    while (/\\\s*$/.test(text) && i + 1 < lines.length) text = text.replace(/\\\s*$/, ' ') + lines[++i];
    const from = /^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(text);
    if (from) { stage = from[1] ? `stage/${from[1]}` : 'Dockerfile'; continue; }
    const env = /^\s*ENV\s+(.*)$/i.exec(text);
    if (!env) continue;
    const body = env[1].trim();
    const add = (name: string, value: string | undefined) => {
      if (ENV_NAME.test(name)) out.declarations.push({ name, ecosystem: 'Dockerfile', resource: stage, file: file.path, line: start + 1, literalValue: value !== undefined && value !== '' && !INTERPOLATED.test(value) });
    };
    if (/^[A-Za-z_][\w.-]*=/.test(body)) {
      // ENV KEY=value KEY2="value two"
      for (const m of body.matchAll(/([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g)) add(m[1], m[2].replace(/^["']|["']$/g, ''));
    } else {
      // Legacy form: ENV KEY value
      const legacy = /^([A-Za-z_][\w.-]*)\s+(.*)$/.exec(body);
      if (legacy) add(legacy[1], legacy[2]);
    }
  }
}

// ── Terraform / OpenTofu (HCL and JSON) ─────────────────────────────────────

/** The matching close brace of the `{` at `open` in HCL text (strings skipped), or -1. */
function closeBrace(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (c === '"') { k++; while (k < text.length && text[k] !== '"') { if (text[k] === '\\') k++; k++; } continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return -1;
}

function terraform(file: { path: string; content: string }, out: EnvDeclarationScan): void {
  if (file.path.toLowerCase().endsWith('.json')) { yamlLike({ ...file, language: 'Terraform' }, out); return; }
  for (const block of scanHclBlocks(file.content)) {
    if (block.type !== 'resource' && block.type !== 'module') continue;
    const resource = block.type === 'module' ? `module.${block.labels[0] ?? ''}` : block.labels.join('.');
    const body = block.body;
    const lineOf = (off: number) => block.startLine + (body.slice(0, off).match(/\n/g)?.length ?? 0);
    // environment { variables = { KEY = value } }
    for (const m of body.matchAll(/\bvariables\s*=\s*/g)) {
      const at = m.index! + m[0].length;
      if (body[at] !== '{') {
        out.opaque.push({ ecosystem: 'Terraform', resource, file: file.path, line: lineOf(m.index!), reason: 'an environment map built by an expression' });
        continue;
      }
      const end = closeBrace(body, at);
      const inner = body.slice(at + 1, end === -1 ? body.length : end);
      for (const kv of inner.matchAll(/(?:^|[\n,{])\s*"?([A-Za-z_][\w.-]*)"?\s*=\s*([^\n,}]*)/g)) {
        const value = kv[2].trim();
        out.declarations.push({
          name: kv[1], ecosystem: 'Terraform', resource, file: file.path, line: lineOf(at + 1 + kv.index! + kv[0].indexOf(kv[1])),
          literalValue: /^"[^"]*"$/.test(value) && !INTERPOLATED.test(value),
        });
      }
    }
    // kubernetes provider: env { name = "KEY" value = "..." }
    for (const m of body.matchAll(/\benv\s*\{/g)) {
      const at = m.index! + m[0].length - 1;
      const end = closeBrace(body, at);
      const inner = body.slice(at + 1, end === -1 ? body.length : end);
      const name = /\bname\s*=\s*"([^"]+)"/.exec(inner);
      if (!name || !ENV_NAME.test(name[1])) continue;
      const value = /\bvalue\s*=\s*([^\n]*)/.exec(inner)?.[1].trim() ?? '';
      out.declarations.push({ name: name[1], ecosystem: 'Terraform', resource, file: file.path, line: lineOf(m.index!), literalValue: /^"[^"]*"$/.test(value) && !INTERPOLATED.test(value) });
    }
  }
}

// ── YAML / JSON ecosystems ──────────────────────────────────────────────────

function yamlLike(file: { path: string; content: string; language: string }, out: EnvDeclarationScan): void {
  const lc = new LineCounter();
  const docs = parseAllDocuments(file.content, { lineCounter: lc, uniqueKeys: false });
  const lineOf = (n: unknown) => {
    const r = (n as { range?: [number, number, number] } | undefined)?.range;
    return r ? lc.linePos(r[0]).line : 1;
  };
  const eco = file.language as EnvEcosystem;
  const declare = (name: string, resource: string, keyNode: unknown, valueNode: unknown, literal?: boolean) => {
    if (ENV_NAME.test(name)) out.declarations.push({ name, ecosystem: eco, resource, file: file.path, line: lineOf(keyNode), literalValue: literal ?? literalNode(valueNode) });
  };
  const opaque = (resource: string, node: unknown, reason: string) => out.opaque.push({ ecosystem: eco, resource, file: file.path, line: lineOf(node), reason });
  /** A `KEY: value` map, or an opaque source when the map is an expression. */
  const envMap = (n: unknown, resource: string, owner: unknown) => {
    if (isMap(n)) for (const p of n.items as Pair[]) { const k = keyOf(p); if (k) declare(k, resource, p.key, p.value); }
    else if (n !== undefined && n !== null) opaque(resource, owner, 'an environment map built by an expression');
  };

  for (const doc of docs) {
    if (!(doc as { contents?: unknown }).contents) continue;
    const root = (doc as { contents: Node }).contents;
    if (file.language === 'Kubernetes') kubernetes(root);
    else if (file.language === 'Docker Compose') compose(root);
    else if (file.language === 'GitHub Actions') actions(root);
    else if (file.language === 'CloudFormation') cloudFormation(root);
    else if (file.language === 'Terraform') tfJson(root);
  }

  function kubernetes(root: Node): void {
    const resource = `${strOf(get(root, 'kind')) ?? 'Resource'}/${strOf(get(get(root, 'metadata'), 'name')) ?? '?'}`;
    // Every container list anywhere in the object (pods, deployments, jobs, cron jobs).
    const stack: unknown[] = [root];
    while (stack.length) {
      const n = stack.pop();
      if (isSeq(n)) { for (const i of n.items) stack.push(i); continue; }
      if (!isMap(n)) continue;
      for (const p of n.items as Pair[]) {
        const k = keyOf(p);
        if ((k === 'containers' || k === 'initContainers' || k === 'ephemeralContainers') && isSeq(p.value)) {
          for (const c of p.value.items) {
            const cname = strOf(get(c, 'name'));
            const where = cname ? `${resource}/${cname}` : resource;
            const env = get(c, 'env');
            if (isSeq(env)) {
              for (const e of env.items) {
                const name = strOf(get(e, 'name'));
                if (!name) continue;
                const nameNode = pairsOf(e).find(x => keyOf(x) === 'name')?.key;
                declare(name, where, nameNode, get(e, 'value'), get(e, 'valueFrom') === undefined && literalNode(get(e, 'value')));
              }
            }
            const envFrom = get(c, 'envFrom');
            if (envFrom !== undefined) opaque(where, pairsOf(c).find(x => keyOf(x) === 'envFrom')?.key, 'envFrom (a ConfigMap or Secret whose keys are not read here)');
          }
        } else stack.push(p.value);
      }
    }
  }

  function compose(root: Node): void {
    for (const s of pairsOf(get(root, 'services'))) {
      const svc = keyOf(s);
      if (!svc) continue;
      const resource = `service/${svc}`;
      const env = get(s.value, 'environment');
      if (isSeq(env)) {
        for (const item of env.items) {
          const text = strOf(item);
          if (!text) continue;
          const eq = text.indexOf('=');
          const name = eq === -1 ? text : text.slice(0, eq);
          const value = eq === -1 ? undefined : text.slice(eq + 1);
          declare(name, resource, item, undefined, value !== undefined && value !== '' && !INTERPOLATED.test(value));
        }
      } else envMap(env, resource, s.key);
      const envFile = pairsOf(s.value).find(x => keyOf(x) === 'env_file');
      if (envFile) opaque(resource, envFile.key, 'env_file (a file whose keys are not read here)');
    }
  }

  function actions(root: Node): void {
    const at = (n: unknown, resource: string) => {
      const p = pairsOf(n).find(x => keyOf(x) === 'env');
      if (p) envMap(p.value, resource, p.key);
    };
    at(root, `workflow`);
    for (const j of pairsOf(get(root, 'jobs'))) {
      const job = keyOf(j);
      if (!job) continue;
      at(j.value, `job/${job}`);
      at(get(j.value, 'container'), `job/${job}/container`);
      for (const svc of pairsOf(get(j.value, 'services'))) at(svc.value, `job/${job}/service/${keyOf(svc) ?? '?'}`);
      const steps = get(j.value, 'steps');
      if (isSeq(steps)) steps.items.forEach((st, i) => at(st, `job/${job}/step/${strOf(get(st, 'id')) ?? strOf(get(st, 'name')) ?? i + 1}`));
    }
  }

  function cloudFormation(root: Node): void {
    const variables = (owner: unknown, resource: string) => {
      const env = get(owner, 'Environment');
      const v = pairsOf(env).find(x => keyOf(x) === 'Variables');
      if (v) envMap(v.value, resource, v.key);
    };
    variables(get(get(root, 'Globals'), 'Function'), 'Globals/Function');
    for (const r of pairsOf(get(root, 'Resources'))) {
      const id = keyOf(r);
      if (!id) continue;
      const props = get(r.value, 'Properties');
      variables(props, id);
      // ECS: ContainerDefinitions[].Environment[] { Name, Value }
      const defs = get(props, 'ContainerDefinitions');
      if (isSeq(defs)) {
        for (const d of defs.items) {
          const where = `${id}/${strOf(get(d, 'Name')) ?? '?'}`;
          const env = get(d, 'Environment');
          if (!isSeq(env)) continue;
          for (const e of env.items) {
            const name = strOf(get(e, 'Name'));
            if (name) declare(name, where, pairsOf(e).find(x => keyOf(x) === 'Name')?.key, get(e, 'Value'));
          }
        }
      }
    }
  }

  function tfJson(root: Node): void {
    for (const t of pairsOf(get(root, 'resource'))) {
      for (const r of pairsOf(t.value)) {
        const resource = `${keyOf(t)}.${keyOf(r)}`;
        const bodies = isSeq(r.value) ? r.value.items : [r.value];
        for (const b of bodies) {
          const env = get(b, 'environment');
          for (const e of isSeq(env) ? env.items : [env]) {
            const v = pairsOf(e).find(x => keyOf(x) === 'variables');
            if (v) envMap(v.value, resource, v.key);
          }
        }
      }
    }
  }
}
