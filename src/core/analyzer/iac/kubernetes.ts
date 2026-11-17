/**
 * Kubernetes manifest extraction (spec-07).
 *
 * One node per YAML document (`---`-separated). Edges follow the typed
 * references that operators reason about: label selectors, *KeyRef / envFrom,
 * volume refs, serviceName, ownerReferences, Ingress→Service, serviceAccount.
 * Unknown kinds (CRDs) still become nodes — only unresolved edges are dropped.
 */

import { LineCounter, parseAllDocuments } from 'yaml';
import { YAML_QUIET, reportStringifiedCollectionKeys } from '../yaml-diagnostics.js';
import type { IacGraph, IacReference, IacResource } from './types.js';
import { emptyIacGraph } from './types.js';

interface K8sObject {
  kind: string;
  name: string;
  namespace?: string;
  labels: Record<string, string>;
  templateLabels: Record<string, string>;
  raw: Record<string, unknown>;
  resource: IacResource;
}

const WORKLOAD_KINDS = new Set([
  'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController',
  'Pod', 'Job', 'CronJob',
]);

export function extractKubernetes(
  files: Array<{ path: string; content: string }>,
): IacGraph {
  const graph = emptyIacGraph();
  const objects: K8sObject[] = [];

  for (const file of files) {
    const lc = new LineCounter();
    let docs;
    try {
      docs = parseAllDocuments(file.content, { ...YAML_QUIET, lineCounter: lc });
    } catch {
      continue;
    }
    reportStringifiedCollectionKeys(docs, file.path);
    for (const doc of docs) {
      const obj = doc.toJS() as Record<string, unknown> | null;
      if (!obj || typeof obj !== 'object') continue;
      const kind = typeof obj.kind === 'string' ? obj.kind : '';
      const meta = (obj.metadata ?? {}) as Record<string, unknown>;
      const name = typeof meta.name === 'string' ? meta.name : '';
      if (!kind || !name) continue;
      const namespace = typeof meta.namespace === 'string' ? meta.namespace : undefined;
      const address = namespace ? `${namespace}/${kind}/${name}` : `${kind}/${name}`;
      const start = doc.range?.[0] ?? 0;
      const startLine = lc.linePos(start).line;
      const resource: IacResource = {
        address,
        type: kind,
        kind: 'manifest',
        filePath: file.path,
        startLine,
        module: namespace,
        signature: `${kind}/${name}${namespace ? ` (ns: ${namespace})` : ''}`,
        language: 'Kubernetes',
      };
      graph.resources.push(resource);
      objects.push({
        kind,
        name,
        namespace,
        labels: asStringMap((meta.labels ?? {}) as Record<string, unknown>),
        templateLabels: asStringMap(podTemplateLabels(obj)),
        raw: obj,
        resource,
      });
    }
  }

  resolveEdges(objects, graph);
  return graph;
}

function resolveEdges(objects: K8sObject[], graph: IacGraph): void {
  // Index by (namespace, kind, name) → address for name-based refs.
  const byKindName = new Map<string, string>();
  const key = (ns: string | undefined, kind: string, name: string) => `${ns ?? ''}\0${kind}\0${name}`;
  for (const o of objects) byKindName.set(key(o.namespace, o.kind, o.name), o.resource.address);

  const ref = (from: string, to: string | undefined, kind: IacReference['kind'] = 'references') => {
    if (!to || to === from) return;
    graph.references.push({ fromAddress: from, toAddress: to, kind });
  };
  const lookup = (ns: string | undefined, kind: string, name: string) => byKindName.get(key(ns, kind, name));

  for (const o of objects) {
    const ns = o.namespace;
    const addr = o.resource.address;

    // Service selector → matching workloads (Service depends on the pods it routes to).
    if (o.kind === 'Service') {
      const sel = asStringMap((((o.raw.spec ?? {}) as Record<string, unknown>).selector ?? {}) as Record<string, unknown>);
      if (Object.keys(sel).length > 0) {
        for (const target of objects) {
          if (!WORKLOAD_KINDS.has(target.kind) || target.namespace !== ns) continue;
          const labels = { ...target.labels, ...target.templateLabels };
          if (selectorMatches(sel, labels)) ref(addr, target.resource.address);
        }
      }
    }

    // Workload references to ConfigMaps / Secrets / PVCs / ServiceAccount.
    if (WORKLOAD_KINDS.has(o.kind)) {
      const podSpec = findPodSpec(o.raw);
      if (podSpec) {
        for (const cm of collectRefs(podSpec, 'configMap', 'configMapKeyRef', 'configMapRef')) {
          ref(addr, lookup(ns, 'ConfigMap', cm));
        }
        for (const sec of collectRefs(podSpec, 'secret', 'secretKeyRef', 'secretRef', 'secretName')) {
          ref(addr, lookup(ns, 'Secret', sec));
        }
        for (const pvc of collectRefs(podSpec, 'persistentVolumeClaim')) {
          ref(addr, lookup(ns, 'PersistentVolumeClaim', pvc));
        }
        const sa = (podSpec.serviceAccountName ?? podSpec.serviceAccount) as string | undefined;
        if (typeof sa === 'string') ref(addr, lookup(ns, 'ServiceAccount', sa));
      }
    }

    // StatefulSet.spec.serviceName → Service.
    if (o.kind === 'StatefulSet') {
      const svcName = (((o.raw.spec ?? {}) as Record<string, unknown>).serviceName) as string | undefined;
      if (typeof svcName === 'string') ref(addr, lookup(ns, 'Service', svcName));
    }

    // ownerReferences → owner (dependent child → owner).
    const ownerRefs = ((o.raw.metadata ?? {}) as Record<string, unknown>).ownerReferences;
    if (Array.isArray(ownerRefs)) {
      for (const owner of ownerRefs as Array<Record<string, unknown>>) {
        if (typeof owner.kind === 'string' && typeof owner.name === 'string') {
          ref(addr, lookup(ns, owner.kind, owner.name), 'depends_on');
        }
      }
    }

    // Ingress backend.service.name → Service.
    if (o.kind === 'Ingress') {
      for (const svc of ingressServices(o.raw)) ref(addr, lookup(ns, 'Service', svc));
    }
  }
}

// ---------------------------------------------------------------------------

function podTemplateLabels(obj: Record<string, unknown>): Record<string, unknown> {
  const spec = (obj.spec ?? {}) as Record<string, unknown>;
  const template = (spec.template ?? {}) as Record<string, unknown>;
  const meta = (template.metadata ?? {}) as Record<string, unknown>;
  // CronJob nests one level deeper.
  if (obj.kind === 'CronJob') {
    const jobSpec = ((spec.jobTemplate ?? {}) as Record<string, unknown>).spec as Record<string, unknown> | undefined;
    const jt = ((jobSpec?.template ?? {}) as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    return (jt?.labels ?? {}) as Record<string, unknown>;
  }
  return (meta.labels ?? {}) as Record<string, unknown>;
}

function findPodSpec(obj: Record<string, unknown>): Record<string, unknown> | null {
  const spec = (obj.spec ?? {}) as Record<string, unknown>;
  if (obj.kind === 'Pod') return spec;
  if (obj.kind === 'CronJob') {
    const jobSpec = (spec.jobTemplate as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined;
    return ((jobSpec?.template as Record<string, unknown> | undefined)?.spec ?? null) as Record<string, unknown> | null;
  }
  const template = spec.template as Record<string, unknown> | undefined;
  return (template?.spec ?? null) as Record<string, unknown> | null;
}

/** Recursively collect string values stored under any of the given keys. */
function collectRefs(node: unknown, ...keys: string[]): string[] {
  const out: string[] = [];
  const keySet = new Set(keys);
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (keySet.has(k)) {
          if (typeof v === 'string') out.push(v);
          else if (v && typeof v === 'object') {
            const name = (v as Record<string, unknown>).name;
            if (typeof name === 'string') out.push(name);
          }
        }
        walk(v);
      }
    }
  };
  walk(node);
  return out;
}

function ingressServices(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n && typeof n === 'object') {
      const rec = n as Record<string, unknown>;
      // networking.k8s.io/v1: backend.service.name
      const svc = (rec.service ?? {}) as Record<string, unknown>;
      if (typeof svc.name === 'string') out.push(svc.name);
      // extensions/v1beta1: backend.serviceName
      if (typeof rec.serviceName === 'string') out.push(rec.serviceName);
      for (const v of Object.values(rec)) walk(v);
    }
  };
  walk(obj.spec);
  return out;
}

function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

function asStringMap(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}
