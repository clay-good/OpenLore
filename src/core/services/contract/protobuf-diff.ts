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

import { mergeRanges, inRanges, type ProtoDocument, type ProtoEnum, type ProtoField, type ProtoMessage, type ProtoReserved, type ProtoRpc, type ProtoService } from '../../analyzer/contract/protobuf.js';
import { CONTRACT_RULES, type ContractChange, type ContractRule } from './contract-diff.js';

type Located<T> = { file: string; el: T };

const change = (file: string, address: string, line: number, rule: ContractRule, detail: string, element?: string): ContractChange =>
  ({ file, address, rule, class: CONTRACT_RULES[rule], ...(element ? { element } : {}), detail, line });

/** A revision's reservations, merged once so each lookup is a binary search. */
interface Reserved { ranges: Array<[number, number]>; names: Set<string> }
const reservedOf = (r: ProtoReserved): Reserved => ({ ranges: mergeRanges(r.ranges), names: new Set(r.names) });
const reservedNumber = (r: Reserved, n: number) => inRanges(r.ranges, n);

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
  const wasByName = new Map(b.fields.map(f => [f.name, f]));
  const nowByName = new Map(m.fields.map(f => [f.name, f]));
  const baseReserved = reservedOf(b.reserved);
  const headReserved = reservedOf(m.reserved);
  /**
   * Each base `oneof` mapped to the head `oneof` its surviving members share. A oneof's NAME is on
   * neither the wire nor JSON, so a renamed oneof is the same oneof; members split across two head
   * oneofs map to none, so every one of them is reported.
   */
  const oneofMap = new Map<string, string | null>();
  for (const old of b.fields) {
    if (!old.oneof) continue;
    const into = now.get(old.number)?.oneof;
    if (!into) continue;
    const prior = oneofMap.get(old.oneof);
    oneofMap.set(old.oneof, prior === undefined || prior === into ? into : null);
  }
  // Two base oneofs merged into one head oneof: setting one member now clears the other.
  const intoCount = new Map<string, number>();
  for (const into of oneofMap.values()) if (into) intoCount.set(into, (intoCount.get(into) ?? 0) + 1);
  const sameOneof = (old: ProtoField, f: ProtoField): boolean =>
    (!old.oneof || !f.oneof) ? old.oneof === f.oneof : oneofMap.get(old.oneof) === f.oneof && intoCount.get(f.oneof) === 1;
  for (const [n, f] of now) {
    const old = was.get(n);
    const sameName = wasByName.get(f.name);
    // The same name under another number is a different field on the wire, whatever now sits on
    // its old number — a swap of two fields' numbers is two of these, never two renames.
    if (sameName && sameName.number !== n) {
      push('field-number-changed', `field \`${f.name}\`: number ${sameName.number} → ${n}`, f.line, fieldLabel(f));
      continue;
    }
    if (!old) {
      if (reservedNumber(baseReserved, n) || baseReserved.names.has(f.name)) push('reserved-number-reused', `field ${n} (\`${f.name}\`) uses a number or name the previous revision reserved`, f.line, fieldLabel(f));
      else push('field-added', `field ${n} (\`${f.name}\`) added`, f.line, fieldLabel(f));
      continue;
    }
    if (old.name !== f.name) {
      // The field that held this number moved to another one: that move is the breaking change,
      // reported on it; this is a new field on the freed number.
      if (nowByName.has(old.name)) { push('field-added', `field ${n} (\`${f.name}\`) added on the number \`${old.name}\` used`, f.line, fieldLabel(f)); continue; }
      push('field-renamed', `field ${n}: \`${old.name}\` → \`${f.name}\``, f.line, fieldLabel(f));
    }
    const same = sameType(old, f);
    if (same === false) push('field-type-changed', `field ${n} (\`${f.name}\`): ${old.resolved ?? old.type} → ${f.resolved ?? f.type}`, f.line, fieldLabel(f));
    else if (same === undefined) push('schema-unassessed', `field ${n} (\`${f.name}\`): the type \`${old.type}\` → \`${f.type}\` does not resolve on both sides, so it is not compared`, f.line, fieldLabel(f));
    if (kind(old) !== kind(f)) push('field-label-changed', `field ${n} (\`${f.name}\`): ${kind(old)} → ${kind(f)}`, f.line, fieldLabel(f));
    else if ((old.label === 'optional') !== (f.label === 'optional')) push('field-presence-changed', `field ${n} (\`${f.name}\`): ${old.label === 'optional' ? 'explicit presence removed' : 'explicit presence added'}`, f.line, fieldLabel(f));
    if (!sameOneof(old, f)) push('field-oneof-changed', `field ${n} (\`${f.name}\`): oneof ${old.oneof ?? '(none)'} → ${f.oneof ?? '(none)'}`, f.line, fieldLabel(f));
    if (f.deprecated && !old.deprecated) push('field-deprecated', `field ${n} (\`${f.name}\`) is now deprecated`, f.line, fieldLabel(f));
    if (old.optionsHash !== f.optionsHash) push('schema-unassessed', `field ${n} (\`${f.name}\`): its options changed outside the model (json_name, packed, or a custom option)`, f.line, fieldLabel(f));
  }
  for (const [n, old] of was) {
    // Still on its number — unless what holds the number now is ANOTHER base field moved onto
    // it, in which case this one is gone (base `a=1, b=2`, head `a=2`: `b` was removed).
    const holder = now.get(n);
    if (holder && !(holder.name !== old.name && wasByName.has(holder.name))) continue;
    if (nowByName.has(old.name)) continue; // moved: reported as field-number-changed above
    const reserved = reservedNumber(headReserved, n);
    push(reserved ? 'field-removed-reserved' : 'field-removed',
      reserved ? `field ${n} (\`${old.name}\`) removed; its number is reserved`
        : `field ${n} (\`${old.name}\`) removed without reserving its number, so a later field can reuse it`,
      m.line, fieldLabel(old));
  }
  diffReserved(baseReserved, headReserved, (detail) => push('reserved-removed', detail, m.line));
  if (b.optionsHash !== m.optionsHash) push('schema-unassessed', `message ${m.name}: its options changed outside the model`, m.line);
}

/** Up to this many dropped numbers or ranges are named in one detail. */
const MAX_LISTED = 10;

/** Reservations the base made that the head no longer makes: the set difference of the ranges. */
function diffReserved(b: Reserved, a: Reserved, report: (detail: string) => void): void {
  const dropped: string[] = [];
  let total = 0;
  // Both lists are merged and sorted: one linear sweep.
  let j = 0;
  for (const [lo, hi] of b.ranges) {
    let cur = lo;
    while (j < a.ranges.length && a.ranges[j][1] < cur) j++;
    for (let k = j; cur <= hi; k++) {
      const next = a.ranges[k];
      const gapEnd = next ? Math.min(hi, next[0] - 1) : hi;
      if (gapEnd >= cur) { total++; if (dropped.length < MAX_LISTED) dropped.push(cur === gapEnd ? `${cur}` : `${cur} to ${gapEnd}`); }
      if (!next || next[0] > hi) break;
      cur = next[1] + 1;
    }
  }
  for (const name of b.names) {
    if (a.names.has(name)) continue;
    total++;
    if (dropped.length < MAX_LISTED) dropped.push(`"${name}"`);
  }
  if (total) report(`reservation removed for ${dropped.join(', ')}${total > dropped.length ? ` and ${total - dropped.length} more` : ''}, so it can be reused`);
}

function diffEnum(file: string, b: ProtoEnum, e: ProtoEnum, out: ContractChange[]): void {
  const push = (rule: ContractRule, detail: string, line: number, element?: string) => out.push(change(file, e.name, line, rule, detail, element));
  const was = new Map(b.values.map(v => [v.name, v]));
  const now = new Map(e.values.map(v => [v.name, v]));
  // Names by number on each side, built once: a renamed enum of 40,000 values was quadratic.
  const namesByNumber = (vs: ProtoEnum['values']) => {
    const m = new Map<number, string[]>();
    for (const v of vs) { const at = m.get(v.number); if (at) at.push(v.name); else m.set(v.number, [v.name]); }
    return m;
  };
  const wasByNumber = namesByNumber(b.values);
  const nowByNumber = namesByNumber(e.values);
  const wasNumbers = new Set(wasByNumber.keys());
  const nowNumbers = new Set(nowByNumber.keys());
  const baseReserved = reservedOf(b.reserved);
  const headReserved = reservedOf(e.reserved);
  for (const [name, v] of now) {
    const old = was.get(name);
    if (!old) {
      if (reservedNumber(baseReserved, v.number) || baseReserved.names.has(name)) push('reserved-number-reused', `enum value ${name} = ${v.number} uses a number or name the previous revision reserved`, v.line, name);
      else if (!wasNumbers.has(v.number)) push('enum-value-added', `enum value ${name} = ${v.number} added`, v.line, name);
      // A new name on a number the base had and still has under its old name: a new alias.
      // (When the old name is gone, it is a rename, reported once below.)
      else if ((wasByNumber.get(v.number) ?? []).some(n => now.has(n))) push('enum-value-added', `enum value ${name} = ${v.number} added as an alias`, v.line, name);
      continue;
    }
    if (old.number !== v.number) push('enum-value-number-changed', `enum value ${name}: ${old.number} → ${v.number}`, v.line, name);
    if (v.deprecated && !old.deprecated) push('enum-value-deprecated', `enum value ${name} is now deprecated`, v.line, name);
    if (old.optionsHash !== v.optionsHash) push('schema-unassessed', `enum value ${name}: its options changed outside the model`, v.line, name);
  }
  for (const [name, old] of was) {
    if (now.has(name)) continue;
    // The number survives under another name: the wire still works, JSON and text do not.
    if (nowNumbers.has(old.number)) {
      const into = (nowByNumber.get(old.number) ?? []).filter(n => !was.has(n));
      push('enum-value-renamed', `enum value ${name} = ${old.number} ${into.length ? `renamed to ${into.join(', ')}` : 'removed; another name keeps its number'}`, e.line, name);
      continue;
    }
    // Safe only when the NUMBER is reserved: a reserved name alone leaves the number free to reuse.
    const reserved = reservedNumber(headReserved, old.number);
    push(reserved ? 'enum-value-removed-reserved' : 'enum-value-removed', `enum value ${name} = ${old.number} removed${reserved ? '; its number is reserved' : ''}`, e.line, name);
  }
  diffReserved(baseReserved, headReserved, (detail) => push('reserved-removed', detail, e.line));
  if (b.optionsHash !== e.optionsHash) push('schema-unassessed', `enum ${e.name}: its options changed outside the model`, e.line);
}

function diffRpc(file: string, b: ProtoRpc, r: ProtoRpc, out: ContractChange[]): void {
  const push = (rule: ContractRule, detail: string, element?: string) => out.push(change(file, r.address, r.line, rule, detail, element));
  if (r.deprecated && !b.deprecated) push('rpc-deprecated', `rpc ${r.address} is now deprecated`);
  for (const [side, bt, rt, bw, rw] of [
    ['request', b.requestType, r.requestType, b.request.written, r.request.written],
    ['response', b.responseType, r.responseType, b.response.written, r.response.written],
  ] as const) {
    if (bt && rt) { if (bt !== rt) push('rpc-type-changed', `rpc ${r.address}: ${side} ${bt} → ${rt}`, side); }
    else if (bw !== rw || (bt ?? '') !== (rt ?? '')) push('schema-unassessed', `rpc ${r.address}: the ${side} type does not resolve on both sides, so it is not compared`, side);
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
  const services = new Map<string, Array<Located<ProtoService>>>();
  const add = <T>(m: Map<string, Array<Located<T>>>, k: string, v: Located<T>) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const d of docs) {
    for (const t of [...d.messages, ...d.enums]) add(types, t.name, { file: d.file, el: t });
    for (const s of d.services) {
      add(services, s.name, { file: d.file, el: s });
      for (const r of s.rpcs) add(rpcs, r.address, { file: d.file, el: r });
    }
  }
  return { types, rpcs, services };
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
  // A service's own options (`option deprecated = true;`, a custom option) are compared by hash.
  for (const [name, ns] of now.services) {
    const bs = was.services.get(name);
    if (bs?.length !== 1 || ns.length !== 1) continue; // removed services surface as removed RPCs
    if (bs[0].el.optionsHash !== ns[0].el.optionsHash) out.push(change(ns[0].file, name, ns[0].el.line, 'schema-unassessed', `service ${name}: its options changed outside the model`));
  }
  const sortKey = (c: ContractChange) => `${c.address}\0${c.rule}\0${c.element ?? ''}\0${c.detail}`;
  return out.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
}
