/**
 * Public API surface contract — the exported symbols a package offers the outside
 * world, with their signatures, plus a deterministic breaking-change classification
 * of how that surface changed across a diff. (change: add-public-api-surface-contract)
 *
 * This module is intentionally PURE: it operates on already-extracted signature
 * strings and export sets, so the classification logic is unit-tested without disk,
 * git, or the call graph. The disk/git-backed assembly (base-ref snapshots, continuity
 * rename detection, consumer resolution, confidence-boundary) lives in the handler
 * `../services/mcp-handlers/public-surface.ts`.
 *
 * Discipline (mirrors the proposal's Decision):
 *  - Classify compatibility from the statically-available signature ONLY. No type
 *    checker, no compiler, no build.
 *  - When compatibility CANNOT be proven from the available types, the verdict is
 *    `potentially-breaking` — never silently `non-breaking`. The classifier never
 *    asserts "safe" on evidence it does not have.
 *  - No similarity score, no threshold, no tuning constant, no clock, no model. The
 *    result is a pure, byte-identical function of the two signature views.
 */

import type { ContinuityReason, ContinuityBasis } from '../../types/index.js';

/** A symbol kind on the public surface. */
export type SurfaceKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'const' | 'unknown';

/** A symbol that is part of a module's exported public surface. */
export interface PublicSurfaceSymbol {
  /** Exported name (the contract name a consumer binds to). */
  name: string;
  /** Repo-relative file the symbol is defined in. */
  file: string;
  kind: SurfaceKind;
  /** Normalized one-line declaration (the comparable signature). */
  signature: string;
  /** Call-graph node id (`file::name`) when the symbol resolved to one; for consumer lookup. */
  nodeId?: string;
}

/** The closed breaking-change classification (proposal §2). */
export type ChangeClass = 'breaking' | 'non-breaking' | 'potentially-breaking';

/** How a public-surface symbol changed across the diff. */
export type SurfaceChangeKind = 'removed' | 'added' | 'renamed' | 'signature' | 'visibility-reduced';

/** A single classified change to the public surface. */
export interface SurfaceChange {
  changeKind: SurfaceChangeKind;
  class: ChangeClass;
  /** The symbol's contract name (the base name for removed/renamed/signature/visibility). */
  name: string;
  file: string;
  kind: SurfaceKind;
  /** The base-ref signature, when the symbol existed before. */
  before?: string;
  /** The head signature, when the symbol exists after. */
  after?: string;
  /** Transparent, human-readable reasons behind the class (the evidence, not a score). */
  reasons: string[];
  /** For a rename, the new name/location (detected via symbol-identity continuity). */
  rename?: { to: string; file: string; reason: ContinuityReason; basis: ContinuityBasis };
}

// ── Signature parsing ───────────────────────────────────────────────────────

/** One parsed parameter of a signature. */
export interface ParsedParam {
  name: string;
  /** Optional via `?`, a default value (`=`), or a rest param (`...`). */
  optional: boolean;
  rest: boolean;
  /** The declared type, when statically present; omitted for untyped params. */
  type?: string;
}

/** A best-effort structured view of a normalized signature string. */
export interface ParsedSignature {
  params: ParsedParam[];
  returnType?: string;
  /**
   * `typed`     — params and return carry static types (compatibility is provable);
   * `untyped`   — parsed, but some types are absent (compatibility may be unprovable);
   * `unparsed`  — the param list could not be located (treat any change as unprovable).
   */
  confidence: 'typed' | 'untyped' | 'unparsed';
}

const PARAM_LANGS = new Set(['TypeScript', 'JavaScript', 'Python']);

/** True when the language's signatures are structured enough to parse for compatibility. */
export function signatureClassifiable(language: string): boolean {
  return PARAM_LANGS.has(language);
}

/** Split a parameter list on top-level commas, respecting nested () [] {} <> brackets. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // An arrow `=>` is a 2-char token, NOT a `>` bracket-close and NOT an `=` default
    // assignment — consume it whole so a function-type param (`cb: (x) => void`) neither
    // corrupts the bracket depth nor reads as having a default value.
    if (ch === '=' && s[i + 1] === '>') { cur += '=>'; i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim().length > 0 || out.length > 0) out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Locate the top-level (...) parameter group; returns its inner text and end offset, or null. */
function findParamGroup(sig: string): { inner: string; end: number } | null {
  const open = sig.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    const ch = sig[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { inner: sig.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Parse a single parameter declaration into name / optionality / type. */
function parseParam(raw: string): ParsedParam {
  const rest = raw.startsWith('...');
  const body = rest ? raw.slice(3) : raw;
  // A default value is a TOP-LEVEL `=` (arrows `=>` are consumed whole by splitTopLevel, so a
  // function-type param like `cb: (x) => void` is NOT mistaken for a defaulted/optional param).
  const eqParts = splitTopLevel(body, '=');
  const hasDefault = eqParts.length > 1;
  // The binding is everything before the first top-level `:` (TS); the full type follows — split
  // on the top-level colon (not a native split, which would truncate a function-type at its `=>`).
  const colonParts = splitTopLevel(eqParts[0], ':');
  let binding = colonParts[0]?.trim() ?? '';
  const type = colonParts.length > 1 ? colonParts.slice(1).join(':').trim() : undefined;
  const optionalMark = binding.endsWith('?');
  if (optionalMark) binding = binding.slice(0, -1).trim();
  const name = binding.replace(/[{[].*$/, '').trim() || binding;
  return { name, optional: rest || hasDefault || optionalMark, rest, ...(type ? { type } : {}) };
}

/**
 * Parse a normalized signature string into a best-effort structured view. Tolerant by
 * design: an unlocatable param list yields `confidence: 'unparsed'` (every change is
 * then unprovable → potentially-breaking), never a guessed shape.
 */
export function parseSignature(signature: string, language: string): ParsedSignature {
  const sig = signature.trim();
  const group = findParamGroup(sig);
  if (!group) return { params: [], confidence: 'unparsed' };
  const params = splitTopLevel(group.inner, ',').map(parseParam);
  // Return type: TS uses `): T`, Python uses `) -> T`. Capture up to the body/overload terminator.
  const after = sig.slice(group.end + 1).trim();
  let returnType: string | undefined;
  const arrow = after.indexOf('->');
  const hasColon = language !== 'Python' && after.startsWith(':');
  if (arrow >= 0) {
    // Python `) -> T:` — stop at the body colon or an overload `;`.
    returnType = after.slice(arrow + 2).replace(/[{;].*$/, '').replace(/:\s*$/, '').trim() || undefined;
  } else if (hasColon) {
    // TS `): T`. Strip the body (`{`/`;`) and a TRAILING arrow (an arrow-function declaration ends
    // in `=>`), but keep an interior `=>` so a function-typed return (`: (x) => void`) is preserved.
    returnType = after.slice(1).replace(/[{;].*$/, '').replace(/\s*=>\s*$/, '').trim() || undefined;
  }
  const allTyped = params.every((p) => p.rest || p.type !== undefined) && (params.length === 0 || returnType !== undefined);
  return { params, ...(returnType ? { returnType } : {}), confidence: allTyped ? 'typed' : 'untyped' };
}

// ── Type narrow/widen (union-membership subset test) ─────────────────────────

/** Relationship between two declared types under the union-subset model. */
export type TypeRelation = 'same' | 'narrowed' | 'widened' | 'incomparable';

function unionMembers(type: string): Set<string> {
  return new Set(splitTopLevel(type, '|').map((m) => m.replace(/\s+/g, ' ').trim()).filter(Boolean));
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Compare two declared types by union membership only — the sound fragment we can
 * decide without a type lattice. `narrowed` = the set of admissible types shrank
 * (after ⊊ before); `widened` = it grew; `incomparable` = neither contains the other
 * (the honest "cannot prove a direction" case → potentially-breaking upstream).
 */
export function compareTypes(before: string, after: string): TypeRelation {
  const b = before.replace(/\s+/g, ' ').trim();
  const a = after.replace(/\s+/g, ' ').trim();
  if (b === a) return 'same';
  const bs = unionMembers(b);
  const as = unionMembers(a);
  const aSubB = isSubset(as, bs);
  const bSubA = isSubset(bs, as);
  if (aSubB && bSubA) return 'same';
  if (aSubB) return 'narrowed';
  if (bSubA) return 'widened';
  return 'incomparable';
}

// ── Breaking-change classification of a paired signature change ──────────────

function worst(a: ChangeClass, b: ChangeClass): ChangeClass {
  if (a === 'breaking' || b === 'breaking') return 'breaking';
  if (a === 'potentially-breaking' || b === 'potentially-breaking') return 'potentially-breaking';
  return 'non-breaking';
}

/**
 * Classify a change to a symbol that exists on both sides (same name + file) from its
 * before/after signature. Conservative by construction: any change that cannot be
 * proven compatible from the available types is `potentially-breaking`, never folded
 * into `non-breaking`.
 */
export function classifySignatureChange(
  beforeSig: string,
  afterSig: string,
  language: string,
): { class: ChangeClass; reasons: string[] } {
  if (beforeSig.replace(/\s+/g, ' ').trim() === afterSig.replace(/\s+/g, ' ').trim()) {
    return { class: 'non-breaking', reasons: [] };
  }
  if (!signatureClassifiable(language)) {
    return { class: 'potentially-breaking', reasons: [`signature changed in ${language}; compatibility not statically classifiable`] };
  }
  const before = parseSignature(beforeSig, language);
  const after = parseSignature(afterSig, language);
  if (before.confidence === 'unparsed' || after.confidence === 'unparsed') {
    return { class: 'potentially-breaking', reasons: ['signature changed but could not be parsed into a comparable shape'] };
  }

  const reasons: string[] = [];
  let cls: ChangeClass = 'non-breaking';
  const max = Math.max(before.params.length, after.params.length);
  for (let i = 0; i < max; i++) {
    const b = before.params[i];
    const a = after.params[i];
    if (b && !a) {
      cls = worst(cls, 'breaking');
      reasons.push(`parameter "${b.name}" was removed`);
      continue;
    }
    if (!b && a) {
      if (a.optional) reasons.push(`optional trailing parameter "${a.name}" was added`); // non-breaking
      else {
        cls = worst(cls, 'breaking');
        reasons.push(`required parameter "${a.name}" was added`);
      }
      continue;
    }
    if (!b || !a) continue;
    if (b.optional && !a.optional) {
      cls = worst(cls, 'breaking');
      reasons.push(`parameter "${a.name}" became required`);
    }
    if (b.type !== undefined && a.type !== undefined) {
      const rel = compareTypes(b.type, a.type);
      if (rel === 'narrowed') {
        cls = worst(cls, 'breaking');
        reasons.push(`parameter "${a.name}" type narrowed (${b.type} → ${a.type})`);
      } else if (rel === 'incomparable') {
        cls = worst(cls, 'potentially-breaking');
        reasons.push(`parameter "${a.name}" type changed (${b.type} → ${a.type}); compatibility unprovable`);
      }
    } else if ((b.type ?? '') !== (a.type ?? '')) {
      cls = worst(cls, 'potentially-breaking');
      reasons.push(`parameter "${a.name}" changed but is untyped; compatibility unprovable`);
    }
  }

  // Return type.
  if ((before.returnType ?? '') !== (after.returnType ?? '')) {
    if (before.returnType !== undefined && after.returnType !== undefined) {
      const rel = compareTypes(before.returnType, after.returnType);
      if (rel === 'narrowed') {
        cls = worst(cls, 'breaking');
        reasons.push(`return type narrowed (${before.returnType} → ${after.returnType})`);
      } else if (rel === 'widened') {
        reasons.push(`return type widened (${before.returnType} → ${after.returnType})`); // non-breaking
      } else if (rel === 'incomparable') {
        cls = worst(cls, 'potentially-breaking');
        reasons.push(`return type changed (${before.returnType} → ${after.returnType}); compatibility unprovable`);
      }
    } else {
      cls = worst(cls, 'potentially-breaking');
      reasons.push('return type changed but is untyped; compatibility unprovable');
    }
  }

  // A signature differed but no rule fired (e.g. whitespace/param-name only) — provably benign.
  if (reasons.length === 0) return { class: 'non-breaking', reasons: ['declaration changed without an observable contract effect'] };
  return { class: cls, reasons };
}

/** Roll an overall verdict up from the per-symbol classes (breaking dominates). */
export function overallClass(changes: readonly SurfaceChange[]): ChangeClass {
  let cls: ChangeClass = 'non-breaking';
  for (const c of changes) cls = worst(cls, c.class);
  return cls;
}
