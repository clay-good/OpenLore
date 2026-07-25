/**
 * AWS CDK + CDKTF framework detector (spec-07).
 *
 * Like Pulumi, CDK and CDKTF programs are ordinary TS/JS/Python/Go that
 * construct resources — already parsed for the call graph. We recognize the
 * construct instantiations and emit extra `CDK` / `CDKTF` resource nodes +
 * reference edges, leaving the normal call graph untouched.
 *
 * The distinguishing shape: a construct's **first** argument is the scope
 * (`this`/`self`/an identifier) and the **second** argument is the logical id
 * string — `new s3.Bucket(this, "MyBucket", { … })`. (Pulumi puts the name
 * first.) We never synthesize CFN/Terraform; this is static detection only.
 *
 * Scope conservatively: a construction is only recognized when its root
 * identifier is bound to a CDK (`aws-cdk-lib`, `@aws-cdk/*`, `aws_cdk`) or
 * CDKTF (`cdktf`, `@cdktf/*`) import. Unknown roots → no nodes.
 */

import type { IacGraph, IacLanguage, IacResource } from './types.js';
import { emptyIacGraph } from './types.js';

interface InFile { path: string; content: string; language: string }

type Flavor = 'CDK' | 'CDKTF';

interface Construction {
  address: string;
  service: string;
  id: string;
  line: number;
  flavor: Flavor;
  varName?: string;
  argsText: string;
}

export function extractCdk(files: InFile[]): IacGraph {
  const graph = emptyIacGraph();
  for (const file of files) {
    if (file.language === 'TypeScript' || file.language === 'JavaScript') {
      ingest(file, detectTsNames(file.content), 'ts', graph);
    } else if (file.language === 'Python') {
      ingest(file, detectPyNames(file.content), 'py', graph);
    } else if (file.language === 'Go') {
      ingest(file, detectGoNames(file.content), 'go', graph);
    }
  }
  return graph;
}

function ingest(file: InFile, names: Map<string, Flavor>, syntax: 'ts' | 'py' | 'go', graph: IacGraph): void {
  if (names.size === 0) return;
  const constructions = findConstructions(file.content, names, syntax);
  const byVar = new Map<string, string>();
  for (const c of constructions) if (c.varName) byVar.set(c.varName, c.address);

  for (const c of constructions) {
    const r: IacResource = {
      address: c.address, type: c.service, kind: 'resource', filePath: file.path,
      startLine: c.line, signature: `${c.flavor}: ${c.service}("${c.id}")`, language: c.flavor as IacLanguage,
    };
    graph.resources.push(r);
  }
  for (const c of constructions) {
    const seen = new Set<string>();
    for (const tok of c.argsText.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      const target = byVar.get(tok[1]);
      if (target && target !== c.address && !seen.has(target)) {
        seen.add(target);
        graph.references.push({ fromAddress: c.address, toAddress: target, kind: 'references', line: c.line });
      }
    }
  }
}

function findConstructions(content: string, names: Map<string, Flavor>, syntax: 'ts' | 'py' | 'go'): Construction[] {
  const out: Construction[] = [];
  // Second positional arg is the logical id. Go ids may be wrapped: jsii.String("id").
  const idArg = syntax === 'go' ? `(?:jsii\\.String\\(\\s*)?["']([^"']+)["']` : `["']([^"']+)["']`;
  const re = syntax === 'ts'
    ? new RegExp(`(?:(?:const|let|var)\\s+(\\w+)\\s*=\\s*)?new\\s+([A-Za-z_]\\w*(?:\\.\\w+)*)\\s*\\(\\s*[^,()\\n]+?,\\s*${idArg}`, 'g')
    : syntax === 'py'
      ? new RegExp(`(?:(\\w+)\\s*=\\s*)?([A-Za-z_]\\w*(?:\\.\\w+)*)\\s*\\(\\s*[^,()\\n]+?,\\s*${idArg}`, 'g')
      : new RegExp(`(?:(\\w+)\\s*(?:,\\s*\\w+\\s*)?:?=\\s*)?([A-Za-z_]\\w*(?:\\.\\w+)*)\\s*\\(\\s*[^,()\\n]+?,\\s*${idArg}`, 'g');

  for (const m of content.matchAll(re)) {
    const varName = m[1];
    const dotted = m[2];
    const id = m[3];
    // Go constructors are `pkg.NewService` → strip the `New` prefix.
    const segs = dotted.split('.');
    if (syntax === 'go') {
      const last = segs[segs.length - 1];
      if (!last.startsWith('New')) continue;
      segs[segs.length - 1] = last.slice(3);
      // No write back to `dotted`: everything below reads `segs`, so re-joining it
      // was a dead store left from an earlier shape of this loop.
    }
    const root = segs[0];
    const service = segs[segs.length - 1];
    const flavor = names.get(root);
    if (!flavor) continue;
    if (!/^[A-Z]/.test(service)) continue;
    const callParen = (m.index ?? 0) + m[0].indexOf('(');
    out.push({
      address: `${service}:${id}`, service, id, flavor,
      line: lineOf(content, m.index ?? 0), varName, argsText: sliceArgs(content, callParen),
    });
  }
  return out;
}

const CDK_TS = ['aws-cdk-lib', '@aws-cdk/'];
const CDKTF_TS = ['cdktf', '@cdktf/'];

/** Local names bound to a CDK/CDKTF import (TS/JS). */
function detectTsNames(content: string): Map<string, Flavor> {
  const names = new Map<string, Flavor>();
  const add = (n: string | undefined, f: Flavor) => { if (n) names.set(n.trim(), f); };
  for (const m of content.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+["']([^"']+)["']/g)) {
    const flavor = flavorOf(m[2]); if (flavor) add(m[1], flavor);
  }
  for (const m of content.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
    const flavor = flavorOf(m[2]); if (!flavor) continue;
    for (const part of m[1].split(',')) {
      const n = (part.match(/\bas\s+(\w+)/) ?? part.match(/(\w+)/))?.[1];
      add(n, flavor);
    }
  }
  for (const m of content.matchAll(/(\w+)\s*=\s*require\(\s*["']([^"']+)["']/g)) {
    const flavor = flavorOf(m[2]); if (flavor) add(m[1], flavor);
  }
  return names;

  function flavorOf(src: string): Flavor | null {
    if (CDKTF_TS.some((p) => src === p || src.startsWith(p))) return 'CDKTF';
    if (CDK_TS.some((p) => src === p || src.startsWith(p))) return 'CDK';
    return null;
  }
}

/** Local names bound to a CDK/CDKTF import (Python). */
function detectPyNames(content: string): Map<string, Flavor> {
  const names = new Map<string, Flavor>();
  const add = (n: string | undefined, f: Flavor) => { if (n) names.set(n.trim(), f); };
  // import aws_cdk.aws_s3 as s3  /  import cdktf as cdktf
  for (const m of content.matchAll(/import\s+([\w.]+)(?:\s+as\s+(\w+))?/g)) {
    const flavor = pyFlavor(m[1]); if (!flavor) continue;
    add(m[2] ?? m[1].split('.').pop(), flavor);
  }
  // from aws_cdk import aws_s3 as s3, Stack
  for (const m of content.matchAll(/from\s+([\w.]+)\s+import\s+([^\n#]+)/g)) {
    const flavor = pyFlavor(m[1]); if (!flavor) continue;
    for (const part of m[2].split(',')) {
      const n = (part.match(/\bas\s+(\w+)/) ?? part.match(/(\w+)/))?.[1];
      add(n, flavor);
    }
  }
  return names;

  function pyFlavor(mod: string): Flavor | null {
    if (mod === 'cdktf' || mod.startsWith('cdktf_') || mod.startsWith('cdktf.')) return 'CDKTF';
    if (mod === 'aws_cdk' || mod.startsWith('aws_cdk.') || mod.startsWith('aws_cdk_')) return 'CDK';
    return null;
  }
}

/** Go package local names bound to a CDK/CDKTF import path. */
function detectGoNames(content: string): Map<string, Flavor> {
  const names = new Map<string, Flavor>();
  for (const m of content.matchAll(/(?:(\w+)\s+)?"([^"]+)"/g)) {
    const alias = m[1];
    const path = m[2];
    let flavor: Flavor | null = null;
    if (path.includes('hashicorp/terraform-cdk-go/cdktf') || path.includes('cdktf/cdktf-provider')) flavor = 'CDKTF';
    else if (path.includes('aws/aws-cdk-go/awscdk') || path.includes('aws/constructs-go')) flavor = 'CDK';
    if (!flavor) continue;
    names.set(alias ?? path.split('/').pop()!, flavor);
  }
  return names;
}

function sliceArgs(content: string, parenIndex: number): string {
  let depth = 0;
  let i = parenIndex;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  return content.slice(parenIndex, i);
}

function lineOf(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') n++;
  return n;
}
