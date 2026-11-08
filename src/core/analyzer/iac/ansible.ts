/**
 * Ansible extraction (spec-07).
 *
 * Nodes: plays, named tasks, handlers, roles, role vars/defaults.
 * Edges: notify (task → handler), include_/import_ (tasks/role/playbook → target),
 * play `roles:` (play → role), role meta dependencies (role → role).
 * Jinja2 `{{ }}` in values is tolerated. A templated include target backed by
 * a static `loop`/`with_items` list resolves to each literal item; fully
 * dynamic targets (no static list) are dropped rather than guessed.
 */

import { dirname, posix as posixPath } from 'node:path';
import { YAML_QUIET, reportStringifiedCollectionKeys } from '../yaml-diagnostics.js';
import { parseDocument, LineCounter } from 'yaml';
import type { IacGraph, IacReference, IacResource } from './types.js';
import { emptyIacGraph } from './types.js';

interface InFile { path: string; content: string }

const INCLUDE_TASK_KEYS = ['include_tasks', 'import_tasks', 'ansible.builtin.include_tasks', 'ansible.builtin.import_tasks'];
const INCLUDE_ROLE_KEYS = ['include_role', 'import_role', 'ansible.builtin.include_role', 'ansible.builtin.import_role'];
const INCLUDE_PB_KEYS = ['import_playbook', 'ansible.builtin.import_playbook'];

export function extractAnsible(files: InFile[]): IacGraph {
  const graph = emptyIacGraph();
  const declared = new Set<string>();
  const pendingRefs: IacReference[] = [];

  const addResource = (r: IacResource) => { declared.add(r.address); graph.resources.push(r); };

  for (const file of files) {
    const posix = file.path.replace(/\\/g, '/');
    const lc = new LineCounter();
    let js: unknown;
    try {
      const doc = parseDocument(file.content, { ...YAML_QUIET, lineCounter: lc });
      reportStringifiedCollectionKeys(doc, file.path);
      js = doc.toJS();
    } catch {
      continue;
    }

    const roleMatch = /(^|\/)roles\/([^/]+)\/(tasks|handlers|defaults|vars|meta)\//.exec(posix);
    if (roleMatch) {
      const roleName = roleMatch[2];
      const section = roleMatch[3];
      const roleAddr = `role.${roleName}`;
      if (!declared.has(roleAddr)) {
        addResource({ address: roleAddr, type: 'role', kind: 'role', filePath: file.path, startLine: 1, signature: `role: ${roleName}`, language: 'Ansible' });
      }
      ingestRoleSection(roleName, roleAddr, section, js, file, graph, addResource, pendingRefs);
      continue;
    }

    if (isPlaybook(js)) {
      ingestPlaybook(js as unknown[], file, graph, addResource, pendingRefs);
      continue;
    }

    // Generic tasks file (included from elsewhere): scope = file path.
    if (Array.isArray(js)) {
      const scope = `tasks:${posix}`;
      addResource({ address: scope, type: 'tasks', kind: 'task', filePath: file.path, startLine: 1, signature: `tasks: ${posix}`, language: 'Ansible' });
      ingestTaskList(js, scope, scope, file, graph, addResource, pendingRefs);
    }
  }

  // Resolve pending references against declared addresses (drop unresolved).
  for (const ref of pendingRefs) {
    if (declared.has(ref.toAddress) && declared.has(ref.fromAddress)) {
      graph.references.push(ref);
    }
  }
  return graph;
}

function ingestPlaybook(
  plays: unknown[], file: InFile, graph: IacGraph,
  addResource: (r: IacResource) => void, refs: IacReference[],
): void {
  const posix = file.path.replace(/\\/g, '/');
  plays.forEach((play, idx) => {
    if (!play || typeof play !== 'object') return;
    const p = play as Record<string, unknown>;
    if (INCLUDE_PB_KEYS.some((k) => k in p)) {
      const target = String(p[INCLUDE_PB_KEYS.find((k) => k in p)!]);
      const resolved = resolveRel(file.path, target);
      refs.push({ fromAddress: `playbook:${posix}`, toAddress: `playbook:${resolved}`, kind: 'references' });
      return;
    }
    const name = typeof p.name === 'string' ? p.name : `play[${idx}]`;
    const hosts = typeof p.hosts === 'string' ? p.hosts : Array.isArray(p.hosts) ? p.hosts.join(',') : '';
    const playAddr = `play:${posix}#${idx}`;
    addResource({ address: playAddr, type: 'play', kind: 'play', filePath: file.path, startLine: 1, signature: `play: ${name} (hosts: ${hosts})`, language: 'Ansible' });

    // roles: list → role nodes + play→role edges.
    const roles = p.roles;
    if (Array.isArray(roles)) {
      for (const r of roles) {
        const roleName = typeof r === 'string' ? r : (r && typeof r === 'object' ? String((r as Record<string, unknown>).role ?? (r as Record<string, unknown>).name ?? '') : '');
        if (!roleName) continue;
        const roleAddr = `role.${roleName}`;
        addResource({ address: roleAddr, type: 'role', kind: 'role', filePath: file.path, startLine: 1, signature: `role: ${roleName}`, language: 'Ansible' });
        refs.push({ fromAddress: playAddr, toAddress: roleAddr, kind: 'references' });
      }
    }

    // tasks / pre_tasks / post_tasks share the play scope.
    for (const key of ['pre_tasks', 'tasks', 'post_tasks']) {
      const list = p[key];
      if (Array.isArray(list)) ingestTaskList(list, playAddr, posix, file, graph, addResource, refs);
    }
    // handlers declared in the play.
    const handlers = p.handlers;
    if (Array.isArray(handlers)) registerHandlers(handlers, posix, file, addResource);
  });
}

function ingestRoleSection(
  roleName: string, roleAddr: string, section: string, js: unknown, file: InFile,
  graph: IacGraph, addResource: (r: IacResource) => void, refs: IacReference[],
): void {
  if (section === 'handlers' && Array.isArray(js)) {
    registerHandlers(js, roleName, file, addResource);
    return;
  }
  if (section === 'tasks' && Array.isArray(js)) {
    ingestTaskList(js, roleAddr, roleName, file, graph, addResource, refs);
    return;
  }
  if (section === 'meta' && js && typeof js === 'object') {
    const deps = (js as Record<string, unknown>).dependencies;
    if (Array.isArray(deps)) {
      for (const d of deps) {
        const dep = typeof d === 'string' ? d : (d && typeof d === 'object' ? String((d as Record<string, unknown>).role ?? (d as Record<string, unknown>).name ?? '') : '');
        if (!dep) continue;
        const depAddr = `role.${dep}`;
        addResource({ address: depAddr, type: 'role', kind: 'role', filePath: file.path, startLine: 1, signature: `role: ${dep}`, language: 'Ansible' });
        refs.push({ fromAddress: roleAddr, toAddress: depAddr, kind: 'depends_on' });
      }
    }
    return;
  }
  if ((section === 'vars' || section === 'defaults') && js && typeof js === 'object') {
    for (const key of Object.keys(js as Record<string, unknown>)) {
      const addr = `var.${roleName}.${key}`;
      addResource({ address: addr, type: section === 'vars' ? 'var' : 'default', kind: 'value', filePath: file.path, startLine: 1, signature: `${section}: ${key}`, language: 'Ansible' });
    }
  }
}

function registerHandlers(list: unknown[], scope: string, file: InFile, addResource: (r: IacResource) => void): void {
  for (const h of list) {
    if (!h || typeof h !== 'object') continue;
    const name = (h as Record<string, unknown>).name;
    if (typeof name !== 'string') continue;
    addResource({ address: `handler:${scope}:${name}`, type: 'handler', kind: 'handler', filePath: file.path, startLine: 1, signature: `handler: ${name}`, language: 'Ansible' });
  }
}

function ingestTaskList(
  list: unknown[], fromScope: string, handlerScope: string, file: InFile,
  graph: IacGraph, addResource: (r: IacResource) => void, refs: IacReference[],
): void {
  list.forEach((task, idx) => {
    if (!task || typeof task !== 'object') return;
    const t = task as Record<string, unknown>;
    // blocks: recurse into block/rescue/always.
    for (const bk of ['block', 'rescue', 'always']) {
      if (Array.isArray(t[bk])) ingestTaskList(t[bk] as unknown[], fromScope, handlerScope, file, graph, addResource, refs);
    }
    const name = typeof t.name === 'string' ? t.name : '';
    const taskAddr = name ? `task:${handlerScope}:${name}` : `task:${handlerScope}:#${idx}`;
    if (name) {
      addResource({ address: taskAddr, type: 'task', kind: 'task', filePath: file.path, startLine: 1, signature: `task: ${name}`, language: 'Ansible' });
    }
    const from = name ? taskAddr : fromScope;

    // notify → handler(s) in the same scope.
    const notify = t.notify;
    const notifyList = typeof notify === 'string' ? [notify] : Array.isArray(notify) ? notify.filter((x): x is string => typeof x === 'string') : [];
    for (const handlerName of notifyList) {
      refs.push({ fromAddress: from, toAddress: `handler:${handlerScope}:${handlerName}`, kind: 'references' });
    }

    // include_tasks / import_tasks → tasks file node.
    for (const k of INCLUDE_TASK_KEYS) {
      if (k in t) {
        const target = includeTarget(t[k]);
        if (target && !target.includes('{{')) {
          const resolved = resolveRel(file.path, target);
          refs.push({ fromAddress: from, toAddress: `tasks:${resolved}`, kind: 'references' });
        } else if (target && target.includes('{{')) {
          // Templated target backed by a static loop list → resolve each literal.
          for (const item of staticLoopItems(t)) {
            const resolved = resolveRel(file.path, item);
            refs.push({ fromAddress: from, toAddress: `tasks:${resolved}`, kind: 'references' });
          }
        }
      }
    }
    // include_role / import_role → role node.
    for (const k of INCLUDE_ROLE_KEYS) {
      if (k in t) {
        const v = t[k];
        const roleName = v && typeof v === 'object' ? String((v as Record<string, unknown>).name ?? '') : '';
        if (roleName) {
          const roleAddr = `role.${roleName}`;
          addResource({ address: roleAddr, type: 'role', kind: 'role', filePath: file.path, startLine: 1, signature: `role: ${roleName}`, language: 'Ansible' });
          refs.push({ fromAddress: from, toAddress: roleAddr, kind: 'references' });
        }
      }
    }
  });
}

/** Literal string items from a task's `loop` / `with_items` (skip templated). */
function staticLoopItems(t: Record<string, unknown>): string[] {
  const list = t.loop ?? t.with_items;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is string => typeof x === 'string' && !x.includes('{{'));
}

function includeTarget(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const f = (v as Record<string, unknown>).file ?? (v as Record<string, unknown>)._raw_params;
    if (typeof f === 'string') return f;
  }
  return null;
}

function resolveRel(fromPath: string, target: string): string {
  const dir = dirname(fromPath.replace(/\\/g, '/'));
  return posixPath.normalize(posixPath.join(dir, target));
}

function isPlaybook(js: unknown): boolean {
  return Array.isArray(js) && js.some((x) => x && typeof x === 'object' && ('hosts' in (x as object) || 'import_playbook' in (x as object) || 'ansible.builtin.import_playbook' in (x as object)));
}
