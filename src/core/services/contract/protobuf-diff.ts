/**
 * Protobuf change rules (change: add-contract-graph-projection, protobuf phase).
 *
 * The protobuf rows of the closed rule table in `contract-diff.ts`, over the element model of
 * `analyzer/contract/protobuf.ts`. A field's NUMBER is its identity on the wire, so fields are
 * matched by number: the same number under a new name is a rename (the wire still works, JSON and
 * text formats do not), and the same name under a new number is a different field. Types and
 * services are matched by full name across files, so moving a message between files is not a
 * removal.
 *
 * Anything compared only by hash — an option other than `deprecated` (`json_name`, `packed`, a
 * custom option) — is `schema-unassessed`, never silently "no change".
 */

import type { ProtoDocument, ProtoEnum, ProtoField, ProtoMessage, ProtoReserved, ProtoRpc } from '../../analyzer/contract/protobuf.js';
import { CONTRACT_RULES, type ContractChange, type ContractRule } from './contract-diff.js';

type Located<T> = { file: string; el: T };

const change = (file: string, address: string, line: number, rule: ContractRule, detail: string, element?: string): ContractChange =>
  ({ file, address, rule, class: CONTRACT_RULES[rule], ...(element ? { element } : {}), detail, line });

const reservedNumber = (r: ProtoReserved, n: number) => r.ranges.some(([lo, hi]) => n >= lo && n <= hi);

/**
 * A field's type as compared: the resolved full name when both sides resolved it, otherwise the
 * text as written. `undefined` when the two cannot be compared — a reference that resolved on one
 * side only, or two unresolved references written differently (`Timestamp` against
 * `google.protobuf.Timestamp` may be the same type).
 */
function sameType(b: ProtoField, a: ProtoField): boolean | undefined {
  const shape = (f: ProtoField) => (f.label === 'map' ? f.type.replace(/,\s*[^>]+>$/, '') : '');
  if (shape(b) !== shape(a)) return false;
  if (!b.ref && !a.ref) return b.type === a.type;
  if (!b.ref || !a.ref) return false; // a scalar against a message or enum
  if (b.resolved && a.resolved) return b.resolved === a.resolved;
  if (!b.resolved && !a.resolved && b.ref.written === a.ref.written && b.ref.scope === a.ref.scope) return true;
  return undefined;
}

const fieldLabel = (f: ProtoField) => `field ${f.number} (${f.name})`;
const kind = (f: ProtoField) => (f.label === 'repeated' || f.label === 'map' ? f.label : 'singular');

function diffMessage(file: string, b: ProtoMessage, m: ProtoMessage, out: ContractChange[]): void {
  const push = (rule: ContractRule, detail: string, line: number, element?: string) => out.push(change(file, m.name, line, rule, detail, element));
  const was = new Map(b.fields.map(f => [f.number, f]));
  const now = new Map(m.fields.map(f => [f.number, f]));
  const nowByName = new Map(m.fields.map(f => [f.name, f]));
  const wasByName = new Map(b.fields.map(f => [f.name, f]));
  for (const [n, f] of now) {
    const old = was.get(n);
    if (!old) {
      const moved = wasByName.get(f.name);
      // The same name under a new number: a different field on the wire.
      if (moved && !now.has(moved.number)) push('field-number-changed', `field \`${f.name}\`: number ${moved.number} → ${n}`, f.line, fieldLabel(f));
      else if (reservedNumber(b.reserved, n) || b.reserved.names.includes(f.name)) push('reserved-number-reused', `field ${n} (\`${f.name}\`) uses a number or name the previous revision reserved`, f.line, fieldLabel(f));
      else push('field-added', `field ${n} (\`${f.name}\`) added`, f.line, fieldLabel(f));
      continue;
    }
    if (old.name !== f.name) push('field-renamed', `field ${n}: \`${old.name}\` → \`${f.name}\``, f.line, fieldLabel(f));
    const same = sameType(old, f);
    if (same === false) push('field-type-changed', `field ${n} (\`${f.name}\`): ${old.resolved ?? old.type} → ${f.resolved ?? f.type}`, f.line, fieldLabel(f));
    else if (same === undefined) push('schema-unassessed', `field ${n} (\`${f.name}\`): the type \`${old.type}\` → \`${f.type}\` does not resolve on both sides, so it is not compared`, f.line, fieldLabel(f));
    if (kind(old) !== kind(f)) push('field-label-changed', `field ${n} (\`${f.name}\`): ${kind(old)} → ${kind(f)}`, f.line, fieldLabel(f));
    else if ((old.label === 'optional') !== (f.label === 'optional')) push('field-presence-changed', `field ${n} (\`${f.name}\`): ${old.label === 'optional' ? 'explicit presence removed' : 'explicit presence added'}`, f.line, fieldLabel(f));
    if (old.oneof !== f.oneof) push('field-oneof-changed', `field ${n} (\`${f.name}\`): oneof ${old.oneof ?? '(none)'} → ${f.oneof ?? '(none)'}`, f.line, fieldLabel(f));
    if (f.deprecated && !old.deprecated) push('field-deprecated', `field ${n} (\`${f.name}\`) is now deprecated`, f.line, fieldLabel(f));
    if (old.optionsHash !== f.optionsHash) push('schema-unassessed', `field ${n} (\`${f.name}\`): its options changed outside the model (json_name, packed, or a custom option)`, f.line, fieldLabel(f));
  }
  for (const [n, old] of was) {
    if (now.has(n)) continue;
    const moved = nowByName.get(old.name);
    if (moved && !was.has(moved.number)) continue; // reported as field-number-changed above
    const reserved = reservedNumber(m.reserved, n);
    push(reserved ? 'field-removed-reserved' : 'field-removed',
      reserved ? `field ${n} (\`${old.name}\`) removed; its number is reserved`
        : `field ${n} (\`${old.name}\`) removed without reserving its number, so a later field can reuse it`,
      m.line, fieldLabel(old));
  }
  diffReserved(b.reserved, m.reserved, (detail) => push('reserved-removed', detail, m.line));
  if (b.optionsHash !== m.optionsHash) push('schema-unassessed', `message ${m.name}: its options changed outside the model`, m.line);
}

function diffReserved(b: ProtoReserved, a: ProtoReserved, report: (detail: string) => void): void {
  // A number reserved before and not now. Checked per range endpoint and per number for small
  // ranges; a dropped part of a large range is found through its endpoints.
  const dropped: string[] = [];
  for (const [lo, hi] of b.ranges) {
    const probe = hi - lo <= 64 ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [lo, hi];
    const lost = probe.filter(n => !reservedNumber(a, n));
    if (lost.length) dropped.push(lost.length === probe.length && lo !== hi ? `${lo} to ${hi}` : lost.join(', '));
  }
  for (const name of b.names) if (!a.names.includes(name)) dropped.push(`"${name}"`);
  if (dropped.length) report(`reservation removed for ${dropped.join(', ')}, so it can be reused`);
}

function diffEnum(file: string, b: ProtoEnum, e: ProtoEnum, out: ContractChange[]): void {
  const push = (rule: ContractRule, detail: string, line: number, element?: string) => out.push(change(file, e.name, line, rule, detail, element));
  const was = new Map(b.values.map(v => [v.name, v]));
  const now = new Map(e.values.map(v => [v.name, v]));
  for (const [name, v] of now) {
    const old = was.get(name);
    if (!old) push(reservedNumber(b.reserved, v.number) || b.reserved.names.includes(name) ? 'reserved-number-reused' : 'enum-value-added',
      `enum value ${name} = ${v.number} added`, v.line, name);
    else if (old.number !== v.number) push('enum-value-number-changed', `enum value ${name}: ${old.number} → ${v.number}`, v.line, name);
  }
  for (const [name, old] of was) {
    if (now.has(name)) continue;
    const reserved = reservedNumber(e.reserved, old.number) || e.reserved.names.includes(name);
    push(reserved ? 'enum-value-removed-reserved' : 'enum-value-removed', `enum value ${name} = ${old.number} removed${reserved ? '; it is reserved' : ''}`, e.line, name);
  }
  diffReserved(b.reserved, e.reserved, (detail) => push('reserved-removed', detail, e.line));
  if (b.optionsHash !== e.optionsHash) push('schema-unassessed', `enum ${e.name}: its options changed outside the model`, e.line);
}

function diffRpc(file: string, b: ProtoRpc, r: ProtoRpc, out: ContractChange[]): void {
  const push = (rule: ContractRule, detail: string) => out.push(change(file, r.address, r.line, rule, detail));
  if (r.deprecated && !b.deprecated) push('rpc-deprecated', `rpc ${r.address} is now deprecated`);
  for (const [side, bt, rt, bw, rw] of [
    ['request', b.requestType, r.requestType, b.request.written, r.request.written],
    ['response', b.responseType, r.responseType, b.response.written, r.response.written],
  ] as const) {
    if (bt && rt) { if (bt !== rt) push('rpc-type-changed', `rpc ${r.address}: ${side} ${bt} → ${rt}`); }
    else if (bw !== rw || (bt ?? '') !== (rt ?? '')) push('schema-unassessed', `rpc ${r.address}: the ${side} type does not resolve on both sides, so it is not compared`);
  }
  if (b.clientStreaming !== r.clientStreaming || b.serverStreaming !== r.serverStreaming) {
    const mode = (x: ProtoRpc) => `${x.clientStreaming ? 'stream ' : ''}request, ${x.serverStreaming ? 'stream ' : ''}response`;
    push('rpc-streaming-changed', `rpc ${r.address}: ${mode(b)} → ${mode(r)}`);
  }
  if (b.optionsHash !== r.optionsHash) push('schema-unassessed', `rpc ${r.address}: its options changed outside the model`);
}

/** Every element of one revision, by its full name; more than one per name is compared as a set. */
function index(docs: readonly ProtoDocument[]) {
  const types = new Map<string, Array<Located<ProtoMessage | ProtoEnum>>>();
  const rpcs = new Map<string, Array<Located<ProtoRpc>>>();
  const add = <T>(m: Map<string, Array<Located<T>>>, k: string, v: Located<T>) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const d of docs) {
    for (const t of [...d.messages, ...d.enums]) add(types, t.name, { file: d.file, el: t });
    for (const s of d.services) for (const r of s.rpcs) add(rpcs, r.address, { file: d.file, el: r });
  }
  return { types, rpcs };
}

/** A content key for an element declared in more than one file (no file, no line). */
const fingerprint = (x: ProtoMessage | ProtoEnum | ProtoRpc): string => JSON.stringify(x, (k, v) => (k === 'line' ? undefined : v));

/**
 * Compare the protobuf schemas of two revisions. Each side must already be resolved
 * (`resolveProtoTypes`) over every `.proto` file of that revision.
 */
export function diffProtobuf(base: readonly ProtoDocument[], head: readonly ProtoDocument[]): ContractChange[] {
  const was = index(base);
  const now = index(head);
  const out: ContractChange[] = [];
  for (const [name, bs] of was.types) {
    const ns = now.types.get(name);
    const b = bs[0];
    if (!ns) { out.push(change(b.file, name, b.el.line, 'type-removed', `${b.el.kind} ${name} removed`)); continue; }
    if (bs.length > 1 || ns.length > 1) {
      const set = (l: typeof bs) => l.map(x => fingerprint(x.el)).sort().join('\n');
      if (set(bs) !== set(ns)) out.push(change(ns[0].file, name, ns[0].el.line, 'schema-unassessed', `${name} is declared more than once and changed`));
      continue;
    }
    const n = ns[0];
    if (b.el.kind !== n.el.kind) { out.push(change(n.file, name, n.el.line, 'type-removed', `${name} changed from ${b.el.kind} to ${n.el.kind}`)); continue; }
    if (b.el.kind === 'message') diffMessage(n.file, b.el, n.el as ProtoMessage, out);
    else diffEnum(n.file, b.el, n.el as ProtoEnum, out);
  }
  for (const [name, ns] of now.types) {
    if (!was.types.has(name)) out.push(change(ns[0].file, name, ns[0].el.line, 'type-added', `${ns[0].el.kind} ${name} added`));
  }
  for (const [address, bs] of was.rpcs) {
    const ns = now.rpcs.get(address);
    if (!ns) { out.push(change(bs[0].file, address, bs[0].el.line, 'rpc-removed', `rpc ${address} removed`)); continue; }
    if (bs.length > 1 || ns.length > 1) {
      const set = (l: typeof bs) => l.map(x => fingerprint(x.el)).sort().join('\n');
      if (set(bs) !== set(ns)) out.push(change(ns[0].file, address, ns[0].el.line, 'schema-unassessed', `rpc ${address} is declared more than once and changed`));
      continue;
    }
    diffRpc(ns[0].file, bs[0].el, ns[0].el, out);
  }
  for (const [address, ns] of now.rpcs) {
    if (!was.rpcs.has(address)) out.push(change(ns[0].file, address, ns[0].el.line, 'rpc-added', `rpc ${address} added`));
  }
  const sortKey = (c: ContractChange) => `${c.address}\0${c.rule}\0${c.element ?? ''}\0${c.detail}`;
  return out.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
}
