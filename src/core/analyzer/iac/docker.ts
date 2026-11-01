/**
 * Docker container extraction (spec-07 deferred follow-up: add-docker-container-graph).
 *
 * Parses Dockerfiles and docker-compose files together — they are cross-referential
 * (a compose `build:` resolves to a Dockerfile stage), so one extractor sees both —
 * and produces the normalized IacGraph that project.ts maps onto FunctionNode/CallEdge.
 *
 * Edge direction is dependent → dependency (like the rest of IaC), so depth-1 callers
 * of a base image answer "every stage/service rebuilt if this image moves".
 *
 * Static only: no `docker build`, no compose interpolation, no registry access.
 * Dynamic references (FROM ${ARG}, fully-templated build context) emit no edge.
 */

import { parseDocument } from 'yaml';
import type { IacGraph, IacReference } from './types.js';
import { emptyIacGraph } from './types.js';

interface InFile { path: string; content: string; language: string }

/**
 * True when a path names a Dockerfile: `Dockerfile`, `Dockerfile.<suffix>`,
 * `<name>.Dockerfile`, or `Containerfile` (Podman's equivalent). Compose files are
 * `.yaml`/`.yml` and are classified by `classifyYaml`, not here.
 */
export { isDockerfilePath } from '../language-detection.js';

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

/** A parsed Dockerfile stage and the address compose resolves a build to. */
interface DockerfileInfo {
  /** stage name → stage address, for COPY --from / FROM-stage resolution. */
  stageAddrByName: Map<string, string>;
  /** stage addresses in build order, for numeric COPY --from=<index>. */
  stageAddrByIndex: string[];
  /** The default build target: address of the last stage. */
  finalStageAddress: string;
}

const EXTERNAL_IMAGE_LANG = 'Dockerfile'; // one canonical tag so images dedupe across files

export function extractDocker(files: InFile[]): IacGraph {
  const graph = emptyIacGraph();
  const dockerfiles = files.filter((f) => f.language === 'Dockerfile');
  const composeFiles = files.filter((f) => f.language === 'Docker Compose');

  // External image nodes are deduped by reference across the whole set.
  const externalImages = new Set<string>();
  const ensureImage = (ref: string) => {
    if (externalImages.has(ref)) return;
    externalImages.add(ref);
    graph.resources.push({
      address: ref,
      type: 'image',
      kind: 'resource',
      filePath: '',
      startLine: 1,
      isExternal: true,
      signature: `image ${ref}`,
      language: EXTERNAL_IMAGE_LANG,
    });
  };

  // Parse Dockerfiles first so compose `build:` can resolve to a real stage address.
  const dockerInfoByPath = new Map<string, DockerfileInfo>();
  for (const f of dockerfiles) {
    dockerInfoByPath.set(posixNormalize(f.path), parseDockerfile(f.path, f.content, graph, ensureImage));
  }

  for (const f of composeFiles) {
    parseCompose(f.path, f.content, graph, ensureImage, dockerInfoByPath);
  }

  return graph;
}

// ── Dockerfile ───────────────────────────────────────────────────────────────

// The trailing `(?:#.*)?` tolerates an inline comment after the instruction
// (`FROM python:3.12-slim  # pinned`) — common, and the `$` anchor would otherwise
// drop the whole FROM. Image refs / stage names never contain unquoted whitespace,
// so the comment is always whitespace-separated from the captured token.
const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*(?:#.*)?$/i;
const COPY_FROM_RE = /^\s*(?:COPY|ADD)\s+(?:[^\n]*?\s)?--from=(\S+)/i;

/**
 * Resolve a value that may carry compose/Dockerfile variable interpolation:
 *  1. inline defaults — `${VAR:-default}` / `${VAR-default}` (e.g. Airflow's
 *     `image: ${AIRFLOW_IMAGE_NAME:-apache/airflow:3.0.0}`);
 *  2. `${NAME}` / `$NAME` whose default is known from a build-arg map (Dockerfile
 *     `ARG NODE_VERSION=20` declared before `FROM node:${NODE_VERSION}` — the most
 *     common base-image parameterization).
 * Any `$` left afterward — an unresolvable `${VAR}`, `${VAR:?err}`, or `$VAR` with no
 * inline or ARG default — makes the value dynamic, so we return null and emit no edge
 * rather than a wrong one. `args` defaults empty (compose has no ARG concept; its bare
 * `${VAR}` is env-sourced and stays dynamic).
 */
function resolveRef(value: string, args: Map<string, string> = new Map()): string | null {
  let v = value.replace(/\$\{[A-Za-z_]\w*:?-([^}]*)\}/g, '$1');
  const sub = (name: string, whole: string) => (args.has(name) ? args.get(name)! : whole);
  v = v.replace(/\$\{([A-Za-z_]\w*)\}/g, (whole, name) => sub(name, whole));
  v = v.replace(/\$([A-Za-z_]\w*)/g, (whole, name) => sub(name, whole));
  if (v.includes('$')) return null;
  return v;
}

// `ARG NAME[=default]`. Only ARGs declared before the first FROM are "global" and
// usable in FROM lines (Docker semantics); a value (the default) makes it resolvable.
const ARG_DECL_RE = /^\s*ARG\s+([A-Za-z_]\w*)(?:=(\S+))?/i;
// A heredoc redirect on an instruction line (`RUN <<EOF`, `COPY <<-'EOF' dest`). The
// `<<` must follow whitespace/start so shell left-shift inside a string ("a<<b") is not
// mistaken for one. Body lines that follow MUST NOT be scanned for FROM/COPY.
const HEREDOC_RE = /(?:^|\s)<<[-~]?\s*['"]?([A-Za-z_]\w*)['"]?/g;

/**
 * Reduce a Dockerfile to its logical instruction lines, carrying each one's 1-based
 * start line: line continuations (`\` at end of line) are joined, and heredoc bodies
 * (`RUN <<EOF … EOF`) and comment lines are dropped, so the FROM/COPY scanner never
 * matches text inside a RUN script.
 */
function toInstructions(content: string): Array<{ text: string; line: number }> {
  const lines = content.split('\n');
  const out: Array<{ text: string; line: number }> = [];
  let pendingHeredocs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (pendingHeredocs.length > 0) {
      // Inside a heredoc body: only a line equal to a delimiter closes it.
      const trimmed = lines[i].trim();
      pendingHeredocs = pendingHeredocs.filter((d) => d !== trimmed);
      continue;
    }
    if (/^\s*#/.test(lines[i])) continue; // comment / parser directive
    const startLine = i + 1;
    let joined = lines[i];
    while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
      joined = joined.replace(/\\\s*$/, ' ') + lines[++i];
    }
    const hd = [...joined.matchAll(HEREDOC_RE)].map((m) => m[1]);
    if (hd.length) pendingHeredocs.push(...hd);
    out.push({ text: joined, line: startLine });
  }
  return out;
}

function parseDockerfile(
  filePath: string,
  content: string,
  graph: IacGraph,
  ensureImage: (ref: string) => void,
): DockerfileInfo {
  const stageAddrByName = new Map<string, string>();
  const stageAddrByIndex: string[] = [];
  // pending COPY --from sources per stage index, resolved after all stages are known.
  const copyFromByStage: Array<Array<{ ref: string; line: number }>> = [];
  const fromByStage: Array<{ base: string; line: number } | null> = [];

  const instructions = toInstructions(content);
  let stageIndex = -1;
  // Global build args (declared before the first FROM) with a default value, used to
  // resolve `FROM node:${NODE_VERSION}`-style parameterized base images.
  const globalArgs = new Map<string, string>();

  for (const { text: raw, line: lineNo } of instructions) {
    const fromM = FROM_RE.exec(raw);
    if (fromM) {
      stageIndex++;
      const base = fromM[1];
      const asName = fromM[2];
      const stageName = asName ?? `stage${stageIndex}`;
      const address = `${filePath}::${stageName}`;
      graph.resources.push({
        address,
        type: 'docker-stage',
        kind: 'resource',
        filePath,
        startLine: lineNo,
        signature: asName ? `FROM ${base} AS ${asName}` : `FROM ${base}`,
        language: 'Dockerfile',
      });
      // Stage names are case-insensitive in Docker/BuildKit (`AS Builder` is reachable
      // via `--from=builder`), so key the lookup map by lowercase name.
      stageAddrByName.set(stageName.toLowerCase(), address);
      stageAddrByIndex.push(address);
      fromByStage.push({ base, line: lineNo });
      copyFromByStage.push([]);
      continue;
    }
    const copyM = COPY_FROM_RE.exec(raw);
    if (copyM && stageIndex >= 0) {
      copyFromByStage[stageIndex].push({ ref: copyM[1], line: lineNo });
      continue;
    }
    // Collect global ARG defaults — only those before the first FROM apply to FROM lines.
    if (stageIndex < 0) {
      const argM = ARG_DECL_RE.exec(raw);
      if (argM && argM[2] !== undefined) globalArgs.set(argM[1], argM[2]);
    }
  }

  if (stageIndex < 0) {
    return { stageAddrByName, stageAddrByIndex, finalStageAddress: '' };
  }

  // Resolve FROM bases and COPY --from sources now that every stage name is known.
  const addRef = (from: string, to: string, line: number, kind: IacReference['kind']) => {
    if (from === to) return;
    graph.references.push({ fromAddress: from, toAddress: to, kind, line });
  };

  for (let s = 0; s <= stageIndex; s++) {
    const stageAddr = stageAddrByIndex[s];
    const from = fromByStage[s];
    const base = from ? resolveRef(from.base, globalArgs) : null;
    if (from && base) {
      const earlier = stageAddrByName.get(base.toLowerCase());
      if (earlier) {
        addRef(stageAddr, earlier, from.line, 'references');
      } else if (base.toLowerCase() !== 'scratch') {
        ensureImage(base);
        addRef(stageAddr, base, from.line, 'references');
      }
      // else: `FROM scratch` — the empty base, no dependency.
    }
    for (const cf of copyFromByStage[s]) {
      const ref = resolveRef(cf.ref, globalArgs);
      if (!ref) continue; // dynamic --from, no edge
      const named = stageAddrByName.get(ref.toLowerCase());
      if (named) { addRef(stageAddr, named, cf.line, 'references'); continue; }
      const asIndex = Number(ref);
      if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < stageAddrByIndex.length) {
        addRef(stageAddr, stageAddrByIndex[asIndex], cf.line, 'references');
        continue;
      }
      // Otherwise --from references an external image (e.g. COPY --from=nginx:latest …).
      ensureImage(ref);
      addRef(stageAddr, ref, cf.line, 'references');
    }
  }

  return {
    stageAddrByName,
    stageAddrByIndex,
    finalStageAddress: stageAddrByIndex[stageAddrByIndex.length - 1],
  };
}

// ── docker-compose ─────────────────────────────────────────────────────────────

function parseCompose(
  filePath: string,
  content: string,
  graph: IacGraph,
  ensureImage: (ref: string) => void,
  dockerInfoByPath: Map<string, DockerfileInfo>,
): void {
  let doc;
  try {
    // `merge: true` expands YAML merge keys (`<<: *anchor`) — the ubiquitous
    // `x-*: &anchor` compose extension pattern — so inherited image/depends_on/build
    // keys are present rather than left under a literal `<<` property. (It must be set
    // at parse time, not on toJS.)
    doc = parseDocument(content, { merge: true });
  } catch {
    return;
  }
  // `yaml` collects recoverable syntax errors instead of throwing and returns a
  // best-effort partial document; bail rather than mint a garbage service node.
  if (doc.errors && doc.errors.length > 0) return;
  const js = doc.toJS() as Record<string, unknown> | null;
  if (!js || typeof js !== 'object') return;
  const services = js.services;
  if (!services || typeof services !== 'object') return;

  const addrOf = (name: string) => `${filePath}::service.${name}`;
  const declared = new Set<string>();
  const composeDir = posixDir(filePath);

  // Pass 1: declare every service node (so same-file references resolve regardless of order).
  const lineOf = (name: string): number => {
    const node = doc.getIn(['services', name], true) as { range?: [number, number, number] } | undefined;
    const off = node?.range?.[0];
    // yaml's LineCounter is overkill here; approximate via the raw text once.
    return off != null ? offsetToLine(content, off) : 1;
  };
  for (const name of Object.keys(services as Record<string, unknown>)) {
    declared.add(name);
    graph.resources.push({
      address: addrOf(name),
      type: 'compose-service',
      kind: 'resource',
      filePath,
      startLine: lineOf(name),
      signature: `service ${name}`,
      language: 'Docker Compose',
    });
  }

  // Pass 2: edges.
  const addRef = (from: string, to: string, kind: IacReference['kind']) => {
    if (from === to) return;
    graph.references.push({ fromAddress: from, toAddress: to, kind });
  };
  for (const [name, body] of Object.entries(services as Record<string, unknown>)) {
    if (!body || typeof body !== 'object') continue;
    const svc = body as Record<string, unknown>;
    const from = addrOf(name);

    // depends_on: list ["db"] or map { db: {condition} }.
    for (const dep of namesOf(svc.depends_on)) {
      if (declared.has(dep)) addRef(from, addrOf(dep), 'depends_on');
    }
    // links: ["db", "db:alias"] — the part before ':' is the service name.
    for (const link of toArray(svc.links)) {
      if (typeof link !== 'string') continue;
      const target = link.split(':')[0].trim();
      if (declared.has(target)) addRef(from, addrOf(target), 'references');
    }

    // build → resolved Dockerfile stage. Wins over `image:` (image is the build's tag name).
    const buildTarget = resolveBuildTarget(svc.build, composeDir, dockerInfoByPath);
    if (buildTarget) {
      addRef(from, buildTarget, 'references');
    } else if (typeof svc.image === 'string') {
      const img = resolveRef(svc.image);
      if (img) {
        ensureImage(img);
        addRef(from, img, 'references');
      }
    }
  }
}

/** Resolve a service `build:` to a Dockerfile stage address, or null if unresolvable. */
function resolveBuildTarget(
  build: unknown,
  composeDir: string,
  dockerInfoByPath: Map<string, DockerfileInfo>,
): string | null {
  if (build == null) return null;
  let context: string;
  let dockerfile = 'Dockerfile';
  let target: string | undefined;
  if (typeof build === 'string') {
    context = build;
  } else if (typeof build === 'object') {
    const b = build as Record<string, unknown>;
    if (typeof b.context !== 'string') return null;
    context = b.context;
    if (typeof b.dockerfile === 'string') dockerfile = b.dockerfile;
    if (typeof b.target === 'string') target = b.target;
  } else {
    return null;
  }
  const ctx = resolveRef(context);
  const dfName = resolveRef(dockerfile);
  if (ctx == null || dfName == null) return null; // unresolvable interpolation → no edge
  const dfPath = posixNormalize([composeDir, ctx, dfName].filter(Boolean).join('/'));
  const info = dockerInfoByPath.get(dfPath);
  if (!info) return null; // Dockerfile not in the indexed set → best-effort, no edge
  if (target) return info.stageAddrByName.get(target.toLowerCase()) ?? null;
  return info.finalStageAddress || null;
}

/** Service names from a compose `depends_on` (array or map form). */
function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (v && typeof v === 'object') return Object.keys(v as Record<string, unknown>);
  return [];
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}
