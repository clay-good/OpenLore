/**
 * GitHub Actions extraction (spec-07 deferred follow-up: add-github-actions-workflow-graph).
 *
 * Parses `.github/workflows/*.yml` workflow files and `action.yml`/`action.yaml`
 * action-metadata files together — they are cross-referential (a job's
 * `uses: ./.github/actions/x` resolves to that action's metadata file) — and
 * produces the normalized IacGraph that project.ts maps onto FunctionNode/CallEdge.
 *
 * Edge direction is dependent → dependency (like the rest of IaC), so depth-1 callers
 * of a composite action answer "every job that breaks if this action changes", and
 * depth-1 callers of a job answer "every job whose `needs:` lists it".
 *
 * Static only: no `${{ }}` evaluation, no matrix expansion, no `act`, no API calls.
 * Dynamic references (`uses: ${{ matrix.action }}`, a templated reusable path) and a
 * local `./` ref whose target is not in the indexed set emit no edge, never a wrong one.
 */

import { parseDocument } from 'yaml';
import type { IacGraph, IacReference } from './types.js';
import { emptyIacGraph } from './types.js';

// `language` is unused here — files are routed by path — so it is optional, letting
// callers (and unit tests) pass bare `{ path, content }` pairs.
interface InFile { path: string; content: string; language?: string }

const LANG = 'GitHub Actions';

/**
 * Placeholder a `${{ … }}` expression is masked to before YAML parsing. GitHub's own
 * parser tolerates `${{ … }}` anywhere, but strict YAML 1.2 (the `yaml` package) chokes
 * on it inside a flow mapping — `with: { x: ${{ y }} }` — because `{{`/`}}` read as nested
 * flow-map delimiters, and the resulting errors desync the parse and drop downstream jobs.
 * Masking neutralizes that while keeping the value detectable as dynamic (a `uses:` that
 * contains the sentinel is unresolvable → no edge). Mirrors the Helm `{{ }}` masking pre-pass.
 */
const GHA_EXPR = '__OPENLORE_GHA_EXPR__';

/** Replace every `${{ … }}` with the sentinel, preserving newline count so line numbers stay stable. */
function maskExpressions(content: string): string {
  return content.replace(/\$\{\{[\s\S]{0,10000}?\}\}/g, (m) => GHA_EXPR + m.replace(/[^\n]/g, ''));
}

/** True for `.github/workflows/<name>.yml` / `.yaml` (the workflow directory is fixed). */
export function isWorkflowPath(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path.replace(/\\/g, '/'));
}

/** True when a path is an action-metadata file: `action.yml` / `action.yaml`. */
export function isActionMetadataPath(path: string): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return base === 'action.yml' || base === 'action.yaml';
}

const posixDir = (p: string): string => {
  const posix = p.replace(/\\/g, '/');
  const i = posix.lastIndexOf('/');
  return i === -1 ? '' : posix.slice(0, i);
};

/** Normalize a POSIX path, resolving `.` and `..` segments. */
function posixNormalize(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); }
    else out.push(s);
  }
  return out.join('/');
}

function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Resolution context shared by workflow and action parsers (cross-file `uses:`). */
interface Ctx {
  /** normalized workflow file path → workflow-handle address (reusable-workflow target). */
  workflowHandleByPath: Map<string, string>;
  /** normalized action directory → action-node address (local-action target). */
  actionAddrByDir: Map<string, string>;
  /** normalized action file path → action-node address (direct file target). */
  actionAddrByFile: Map<string, string>;
  /** Register/dedupe an external action reference and return having created its node. */
  ensureExternal: (ref: string) => void;
}

export function extractGitHubActions(files: InFile[]): IacGraph {
  const graph = emptyIacGraph();
  const workflowFiles = files.filter((f) => isWorkflowPath(f.path));
  const actionFiles = files.filter((f) => !isWorkflowPath(f.path) && isActionMetadataPath(f.path));
  if (workflowFiles.length === 0 && actionFiles.length === 0) return graph;

  const externals = new Set<string>();
  const ensureExternal = (ref: string) => {
    if (externals.has(ref)) return;
    externals.add(ref);
    graph.resources.push({
      address: ref,
      type: 'action',
      kind: 'resource',
      filePath: '',
      startLine: 1,
      isExternal: true,
      signature: `uses ${ref}`,
      language: LANG,
    });
  };

  // Pre-pass: map every local workflow/action to its target address BEFORE parsing, so a
  // cross-file `uses:` from any file resolves regardless of file order. Nodes are pushed
  // during the parse pass; the projector resolves edges by address against those nodes.
  const ctx: Ctx = {
    workflowHandleByPath: new Map(),
    actionAddrByDir: new Map(),
    actionAddrByFile: new Map(),
    ensureExternal,
  };
  for (const f of workflowFiles) {
    ctx.workflowHandleByPath.set(posixNormalize(f.path), `${f.path}::workflow`);
  }
  for (const f of actionFiles) {
    const norm = posixNormalize(f.path);
    const addr = `${f.path}::action`;
    ctx.actionAddrByFile.set(norm, addr);
    const dir = posixDir(norm);
    if (dir) ctx.actionAddrByDir.set(dir, addr);
  }

  for (const f of workflowFiles) parseWorkflow(f.path, f.content, graph, ctx);
  for (const f of actionFiles) parseAction(f.path, f.content, graph, ctx);

  return graph;
}

// ── shared ──────────────────────────────────────────────────────────────────

function addRef(graph: IacGraph, from: string, to: string, kind: IacReference['kind'], line?: number): void {
  if (from === to) return;
  graph.references.push({ fromAddress: from, toAddress: to, kind, line });
}

/**
 * Resolve a `uses:` value to a target address, or null to emit no edge.
 * `./`-prefixed refs are local (GitHub resolves them relative to the repo root): a
 * `.yml`/`.yaml` target is a reusable workflow, anything else is a local action directory.
 * A dynamic `${{ … }}` ref, or a local ref whose target is not indexed, returns null.
 * Every other ref (`owner/repo@v4`, `owner/repo/path@sha`, `docker://image`) is external.
 */
function resolveUses(uses: string, ctx: Ctx): string | null {
  const ref = uses.trim();
  // Dynamic (a raw `${{ }}` or its masked sentinel, incl. partial refs like `org/x@${{v}}`) → no edge.
  if (!ref || ref.includes('${{') || ref.includes(GHA_EXPR)) return null;
  if (ref.startsWith('./') || ref.startsWith('../')) {
    const norm = posixNormalize(ref);
    if (/\.ya?ml$/i.test(norm)) return ctx.workflowHandleByPath.get(norm) ?? null;
    return ctx.actionAddrByDir.get(norm) ?? ctx.actionAddrByFile.get(norm) ?? null;
  }
  ctx.ensureExternal(ref);
  return ref;
}

/** Line of a YAML key path (1-based), best-effort via the document's node range. */
function lineOfPath(doc: ReturnType<typeof parseDocument>, content: string, path: (string | number)[]): number {
  const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
  const off = node?.range?.[0];
  return off != null ? offsetToLine(content, off) : 1;
}

// ── workflow ──────────────────────────────────────────────────────────────────

function parseWorkflow(filePath: string, content: string, graph: IacGraph, ctx: Ctx): void {
  let doc;
  try {
    // `merge: true` expands YAML merge keys (`<<: *anchor`) at parse time so a job that
    // inherits `steps`/`needs` from an `&anchor` carries them, rather than leaving them
    // under a literal `<<` property (mirrors the compose parser, add-docker-container-graph).
    doc = parseDocument(maskExpressions(content), { merge: true });
  } catch {
    return;
  }
  // `yaml` collects recoverable syntax errors instead of throwing; bail rather than mint
  // a garbage node from a half-parsed document (same posture as the compose parser).
  if (doc.errors && doc.errors.length > 0) return;
  const js = doc.toJS() as Record<string, unknown> | null;
  if (!js || typeof js !== 'object') return;

  // Workflow handle node — the searchable "this workflow" entity and the target of a
  // reusable-workflow `uses:`. Its signature carries the human name and triggers.
  const wfName = typeof js.name === 'string' && js.name.trim() ? js.name.trim() : baseNameNoExt(filePath);
  const triggers = triggerNames(js.on);
  graph.resources.push({
    address: `${filePath}::workflow`,
    type: 'workflow',
    kind: 'resource',
    filePath,
    startLine: 1,
    signature: triggers.length ? `workflow ${wfName} on [${triggers.join(', ')}]` : `workflow ${wfName}`,
    language: LANG,
  });

  const jobs = js.jobs;
  if (!jobs || typeof jobs !== 'object') return;
  const jobEntries = Object.entries(jobs as Record<string, unknown>);
  const jobIds = new Set(jobEntries.map(([id]) => id));

  // Pass 1: declare every job node (so same-file `needs:` resolves regardless of order).
  for (const [id] of jobEntries) {
    graph.resources.push({
      address: `${filePath}::job.${id}`,
      type: 'workflow-job',
      kind: 'resource',
      filePath,
      startLine: lineOfPath(doc, content, ['jobs', id]),
      signature: `job ${id}`,
      language: LANG,
    });
  }

  // Pass 2: edges (needs / job-level reusable uses / step uses).
  for (const [id, body] of jobEntries) {
    if (!body || typeof body !== 'object') continue;
    const job = body as Record<string, unknown>;
    const from = `${filePath}::job.${id}`;
    const line = lineOfPath(doc, content, ['jobs', id]);

    for (const dep of needsNames(job.needs)) {
      if (jobIds.has(dep)) addRef(graph, from, `${filePath}::job.${dep}`, 'depends_on', line);
    }
    // A job-level `uses:` calls a whole reusable workflow (no `steps:` in this form).
    if (typeof job.uses === 'string') {
      const target = resolveUses(job.uses, ctx);
      if (target) addRef(graph, from, target, 'references', line);
    }
    // Step `uses:` — the job is the unit (steps are not nodes), like a Dockerfile stage.
    for (const step of asArray(job.steps)) {
      if (step && typeof step === 'object' && typeof (step as Record<string, unknown>).uses === 'string') {
        const target = resolveUses((step as Record<string, unknown>).uses as string, ctx);
        if (target) addRef(graph, from, target, 'references', line);
      }
    }
  }
}

// ── action metadata ─────────────────────────────────────────────────────────────

function parseAction(filePath: string, content: string, graph: IacGraph, ctx: Ctx): void {
  let doc;
  try {
    doc = parseDocument(maskExpressions(content), { merge: true });
  } catch {
    return;
  }
  if (doc.errors && doc.errors.length > 0) return;
  const js = doc.toJS() as Record<string, unknown> | null;
  if (!js || typeof js !== 'object') return;
  const runs = js.runs;
  // An action without a `runs:` block is not an action (classifyYaml already gated, but
  // a same-named file that slipped through must not mint a node).
  if (!runs || typeof runs !== 'object') return;

  const name = typeof js.name === 'string' && js.name.trim() ? js.name.trim() : baseDirName(filePath);
  const using = typeof (runs as Record<string, unknown>).using === 'string'
    ? (runs as Record<string, unknown>).using as string
    : 'unknown';
  const addr = `${filePath}::action`;
  graph.resources.push({
    address: addr,
    type: using === 'composite' ? 'composite-action' : 'action',
    kind: 'resource',
    filePath,
    startLine: 1,
    signature: `action ${name} (using: ${using})`,
    language: LANG,
  });

  // A composite action nests other actions via `runs.steps[].uses:`.
  for (const step of asArray((runs as Record<string, unknown>).steps)) {
    if (step && typeof step === 'object' && typeof (step as Record<string, unknown>).uses === 'string') {
      const target = resolveUses((step as Record<string, unknown>).uses as string, ctx);
      if (target) addRef(graph, addr, target, 'references');
    }
  }
}

// ── small helpers ───────────────────────────────────────────────────────────────

/** Trigger names from a workflow `on:` (string, list, or map form). */
function triggerNames(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((x): x is string => typeof x === 'string');
  if (on && typeof on === 'object') return Object.keys(on as Record<string, unknown>);
  return [];
}

/** Job names from a `needs:` (single string or list). */
function needsNames(needs: unknown): string[] {
  if (typeof needs === 'string') return [needs];
  if (Array.isArray(needs)) return needs.filter((x): x is string => typeof x === 'string');
  return [];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function baseNameNoExt(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  return base.replace(/\.ya?ml$/i, '');
}

function baseDirName(filePath: string): string {
  const dir = posixDir(filePath.replace(/\\/g, '/'));
  return dir.split('/').pop() || baseNameNoExt(filePath);
}
