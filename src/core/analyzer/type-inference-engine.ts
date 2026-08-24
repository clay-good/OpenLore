/**
 * TypeInferenceEngine — lightweight regex-based type inference for 7 languages.
 *
 * Given the source text of a single function body, returns a map of
 * { variableName → className } inferred from declarations, annotations,
 * and constructor calls.
 *
 * Intentionally NOT a full type system — false positives are acceptable;
 * false negatives (missing resolutions) are the only cost.  Only class names
 * starting with an uppercase letter are tracked (conventional in all supported
 * languages), which eliminates most false positives from primitive types.
 */

import type { FunctionRegistryTrie } from './function-registry-trie.js';
import type { FunctionNode } from './call-graph.js';

/** variableName → className */
export type InferredTypes = Map<string, string>;

/**
 * Languages for which {@link inferTypesFromSource} returns real inferred types (rather
 * than an empty map). Authoritative source for the `typeInference` capability flag in
 * the declarative language-support registry (change: add-declarative-language-support-registry).
 * MUST list exactly the non-`default` cases of the switch below; a behavioral test asserts
 * a fixture in each member yields a non-empty map and a non-member yields an empty one.
 */
export const TYPE_INFERENCE_LANGUAGES: ReadonlySet<string> = new Set<string>([
  'Python', 'C++', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'C#', 'Ruby', 'Kotlin', 'Dart',
]);

export function inferTypesFromSource(source: string, language: string): InferredTypes {
  switch (language) {
    case 'Python':     return inferPython(source);
    case 'C++':        return inferCpp(source);
    case 'TypeScript':
    case 'JavaScript': return inferTypeScript(source);
    case 'Go':         return inferGo(source);
    case 'Rust':       return inferRust(source);
    case 'Java':       return inferJava(source);
    case 'C#':         return inferCSharp(source);
    case 'Ruby':       return inferRuby(source);
    case 'Kotlin':     return inferKotlin(source);
    case 'Dart':       return inferDart(source);
    default:           return new Map();
  }
}

/** Receiver names declared at more than one lexical site cannot be represented
 * by the function-wide inference map. Resolution callers use this to refuse
 * legacy name-only fallback for those names instead of guessing a binding. */
export function findAmbiguousTypeBindings(source: string, language: string): ReadonlySet<string> {
  const clean = maskCommentsAndStrings(source, true);
  const sites = new Map<string, Set<number>>();
  const record = (name: string, index: number): void => {
    const found = sites.get(name) ?? new Set<number>();
    found.add(index);
    sites.set(name, found);
  };
  if (language === 'Kotlin') {
    for (const match of clean.matchAll(/\b(?:val|var)\s+(\w+)\b/g)) {
      record(match[1], match.index + match[0].lastIndexOf(match[1]));
    }
  } else if (language === 'Dart') {
    for (const match of clean.matchAll(/\b(?:final|var|late|const)\s+(?:(?:[A-Z]\w*)\s+)?(\w+)\b/g)) {
      record(match[1], match.index + match[0].lastIndexOf(match[1]));
    }
    for (const match of clean.matchAll(/\b[A-Z]\w*\s+(\w+)\s*(?:=|;)/g)) {
      record(match[1], match.index + match[0].indexOf(match[1]));
    }
  }
  return new Set([...sites].filter(([, positions]) => positions.size > 1).map(([name]) => name));
}

/** Resolve one Kotlin/Dart receiver at one call site. Unlike the legacy
 * function-wide map, this contract observes declaration order and brace scope.
 * Any intervening write is refused because a regex pass cannot prove its control
 * flow; returning no type is preferable to inventing a dispatch edge. */
export function inferReceiverTypeAt(
  source: string,
  language: string,
  receiver: string,
  callOffset: number,
): string | undefined {
  if (language !== 'Kotlin' && language !== 'Dart') return undefined;
  const clean = maskCommentsAndStrings(source, true);
  if (callOffset < 0 || callOffset > clean.length) return undefined;

  const scopeAt = (offset: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < offset; i++) {
      if (clean[i] === '{') stack.push(i);
      else if (clean[i] === '}') stack.pop();
    }
    return stack;
  };
  const callScope = scopeAt(callOffset);
  const visible = (declScope: number[]): boolean =>
    declScope.length <= callScope.length && declScope.every((id, i) => callScope[i] === id);

  interface Binding { index: number; end: number; type: string; scope: number[] }
  const bindings: Binding[] = [];
  const declarationSpans: Array<{ start: number; end: number }> = [];
  const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = language === 'Kotlin'
    ? new RegExp(`\\b(?:val|var)\\s+${escaped}(?:\\s*:\\s*([A-Z]\\w*))?\\s*=\\s*([A-Z]\\w*)\\s*\\(`, 'g')
    : new RegExp(`\\b(?:final|var|late|const)\\s+(?:([A-Z]\\w*)\\s+)?${escaped}\\s*=\\s*([A-Z]\\w*)\\s*\\(`, 'g');
  const anyDeclaration = language === 'Kotlin'
    ? new RegExp(`\\b(?:val|var)\\s+${escaped}(?:\\s*:\\s*[A-Z]\\w*)?\\s*=`, 'g')
    : new RegExp(`\\b(?:(?:final|var|late|const)\\s+(?:[A-Z]\\w*\\s+)?|[A-Z]\\w*\\s+)${escaped}\\s*=`, 'g');
  for (const match of clean.slice(0, callOffset).matchAll(anyDeclaration)) {
    declarationSpans.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of clean.slice(0, callOffset).matchAll(declaration)) {
    bindings.push({ index: match.index, end: match.index + match[0].length, type: match[2] ?? match[1], scope: scopeAt(match.index) });
  }
  // Explicitly typed declarations without a constructor are still useful.
  const annotation = language === 'Kotlin'
    ? new RegExp(`\\b(?:val|var)\\s+${escaped}\\s*:\\s*([A-Z]\\w*)\\b`, 'g')
    : new RegExp(`\\b(?:final|late|const)?\\s*([A-Z]\\w*)\\s+${escaped}\\b`, 'g');
  for (const match of clean.slice(0, callOffset).matchAll(annotation)) {
    if (!bindings.some(binding => binding.index === match.index)) {
      bindings.push({ index: match.index, end: match.index + match[0].length, type: match[1], scope: scopeAt(match.index) });
    }
  }
  const candidates = bindings.filter(binding => visible(binding.scope));
  candidates.sort((a, b) => b.scope.length - a.scope.length || b.index - a.index);
  const binding = candidates[0];
  if (!binding) return undefined;

  // A later assignment may be conditional or may change the concrete type. The
  // lightweight pass cannot prove either, so refuse the receiver at this site.
  const write = new RegExp(`\\b${escaped}\\s*=(?!=)`, 'g');
  for (const match of clean.slice(binding.end, callOffset).matchAll(write)) {
    const index = binding.end + match.index;
    if (!declarationSpans.some(span => span.start <= index && index < span.end)) return undefined;
  }
  return binding.type;
}

// ---------------------------------------------------------------------------
// Per-language inference rules
// ---------------------------------------------------------------------------

function inferPython(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // var = ClassName(...)
  for (const m of source.matchAll(/^\s*(\w+)\s*=\s*([A-Z]\w*)\s*\(/gm))
    result.set(m[1], m[2]);
  // var: ClassName = ...
  for (const m of source.matchAll(/^\s*(\w+)\s*:\s*([A-Z]\w*)\s*=/gm))
    result.set(m[1], m[2]);
  // param: ClassName in signatures
  for (const m of source.matchAll(/\b(\w+)\s*:\s*([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  return result;
}

function inferCpp(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // ClassName var;  or  ClassName var(...)
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*[;({]/g))
    result.set(m[2], m[1]);
  // ClassName* var = new ClassName(...)
  for (const m of source.matchAll(/\b([A-Z]\w*)\s*\*\s*(\w+)\s*=\s*new\s+\1/g))
    result.set(m[2], m[1]);
  // auto var = make_shared<ClassName>(...)  /  make_unique<ClassName>(...)
  for (const m of source.matchAll(/auto\s+(\w+)\s*=\s*(?:make_shared|make_unique)<([A-Z]\w*)>/g))
    result.set(m[1], m[2]);
  // shared_ptr<ClassName> var  /  unique_ptr  /  weak_ptr
  for (const m of source.matchAll(/(?:shared_ptr|unique_ptr|weak_ptr)<([A-Z]\w*)>\s+(\w+)/g))
    result.set(m[2], m[1]);
  return result;
}

function inferTypeScript(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // const var = new ClassName(...)
  for (const m of source.matchAll(/\bconst\s+(\w+)\s*=\s*new\s+([A-Z]\w*)\s*\(/g))
    result.set(m[1], m[2]);
  // let/var/const var: ClassName =
  for (const m of source.matchAll(/\b(?:let|var|const)\s+(\w+)\s*:\s*([A-Z]\w*)\s*=/g))
    result.set(m[1], m[2]);
  // param: ClassName in signatures
  for (const m of source.matchAll(/\b(\w+)\s*:\s*([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  return result;
}

function inferGo(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // var svc *MyService
  for (const m of source.matchAll(/\bvar\s+(\w+)\s+\*?([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  // svc := MyService{...}  or  NewMyService(...)
  for (const m of source.matchAll(/\b(\w+)\s*:=\s*(?:New)?([A-Z]\w*)[{(]/g))
    result.set(m[1], m[2]);
  // svc := &MyService{...}
  for (const m of source.matchAll(/\b(\w+)\s*:=\s*&([A-Z]\w*)\s*{/g))
    result.set(m[1], m[2]);
  // func f(svc *MyService) — parameter annotations
  for (const m of source.matchAll(/\b(\w+)\s+\*?([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  return result;
}

function inferRust(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // let svc: MyService = ...
  for (const m of source.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*:\s*([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  // let svc = MyService::new(...)  /  MyService::default()
  for (const m of source.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*=\s*([A-Z]\w*)::(?:new|default)\s*\(/g))
    result.set(m[1], m[2]);
  // let svc = Box::new(MyService::new(...))
  for (const m of source.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*=\s*Box::new\(([A-Z]\w*)::new/g))
    result.set(m[1], m[2]);
  return result;
}

function inferJava(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // ClassName var = ...  or  ClassName var;
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*(?:=|;)/g))
    result.set(m[2], m[1]);
  // Interface var = new ConcreteClass(...)  — prefer the concrete type
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*=\s*new\s+([A-Z]\w*)\s*\(/g))
    result.set(m[2], m[3]);
  // var v = new ConcreteClass(...)  — Java 10+ local-variable type inference.
  // Without this, `var x = new T(); x.m()` recovers no receiver type and falls to
  // the broad name-arity CHA over-approximation (a precision loss / cross-class leak).
  for (const m of source.matchAll(/\bvar\s+(\w+)\s*=\s*new\s+([A-Z]\w*)/g))
    result.set(m[1], m[2]);
  return result;
}

function inferCSharp(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // Type var = ...  or  Type var;
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*(?:=|;)/g))
    result.set(m[2], m[1]);
  // IInterface var = new ConcreteClass(...)  — prefer the concrete type
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*=\s*new\s+([A-Z]\w*)\s*[(<{]/g))
    result.set(m[2], m[3]);
  // var v = new ConcreteClass(...)  — C# implicitly-typed local
  for (const m of source.matchAll(/\bvar\s+(\w+)\s*=\s*new\s+([A-Z]\w*)/g))
    result.set(m[1], m[2]);
  return result;
}

function inferRuby(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // svc = MyClass.new(...)
  for (const m of source.matchAll(/\b(\w+)\s*=\s*([A-Z]\w*)\.new\b/g))
    result.set(m[1], m[2]);
  return result;
}

function inferKotlin(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  const sites = new Map<string, number>();
  const ambiguous = new Set<string>();
  const record = (name: string, type: string, index: number): void => {
    const prior = sites.get(name);
    if (prior !== undefined && prior !== index) ambiguous.add(name);
    sites.set(name, index);
    result.set(name, type);
  };
  const clean = maskCommentsAndStrings(source, true);
  // val/var svc: MyService = ...
  for (const m of clean.matchAll(/\b(?:val|var)\s+(\w+)\s*:\s*([A-Z]\w*)\b/g))
    record(m[1], m[2], m.index + m[0].indexOf(m[1]));
  // val/var svc = MyService(...) — prefer the concrete constructor type.
  for (const m of clean.matchAll(/\b(?:val|var)\s+(\w+)(?:\s*:\s*[A-Z]\w*)?\s*=\s*([A-Z]\w*)\s*\(/g))
    record(m[1], m[2], m.index + m[0].indexOf(m[1]));
  for (const name of ambiguous) result.delete(name);
  return result;
}

function inferDart(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  const sites = new Map<string, number>();
  const ambiguous = new Set<string>();
  const record = (name: string, type: string, index: number): void => {
    const prior = sites.get(name);
    if (prior !== undefined && prior !== index) ambiguous.add(name);
    sites.set(name, index);
    result.set(name, type);
  };
  const clean = maskCommentsAndStrings(source, true);
  // MyService svc / final MyService svc / late MyService svc.
  for (const m of clean.matchAll(/\b(?:(?:final|late|const)\s+)?([A-Z]\w*)\s+(\w+)\b/g))
    record(m[2], m[1], m.index + m[0].lastIndexOf(m[2]));
  // final/var/late svc = MyService(...) or Type svc = Concrete(...).
  // Run after annotations so the concrete constructor type wins.
  for (const m of clean.matchAll(/\b(?:final|var|late|const)\s+(?:(?:[A-Z]\w*)\s+)?(\w+)\s*=\s*([A-Z]\w*)\s*\(/g))
    record(m[1], m[2], m.index + m[0].indexOf(m[1]));
  for (const m of clean.matchAll(/\b[A-Z]\w*\s+(\w+)\s*=\s*([A-Z]\w*)\s*\(/g))
    record(m[1], m[2], m.index + m[0].indexOf(m[1]));
  for (const name of ambiguous) result.delete(name);
  return result;
}

/** Mask comments and quoted literals without moving any remaining source text.
 * Kotlin and Dart both allow nested block comments, so depth is tracked instead
 * of using a first-terminator regular expression. */
function maskCommentsAndStrings(source: string, nestedBlockComments: boolean): string {
  const out = source.split('');
  const blank = (i: number): void => { if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '; };
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (source.startsWith('/*', i)) {
      let depth = 1;
      blank(i++); blank(i++);
      while (i < source.length && depth > 0) {
        if (nestedBlockComments && source.startsWith('/*', i)) {
          depth++; blank(i++); blank(i++);
        } else if (source.startsWith('*/', i)) {
          depth--; blank(i++); blank(i++);
        } else blank(i++);
      }
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      const triple = source.slice(i, i + 3) === quote.repeat(3);
      const delimiter = triple ? quote.repeat(3) : quote;
      for (let n = 0; n < delimiter.length; n++) blank(i++);
      while (i < source.length) {
        if (source.startsWith(delimiter, i)) {
          for (let n = 0; n < delimiter.length; n++) blank(i++);
          break;
        }
        if (!triple && source[i] === '\\' && i + 1 < source.length) {
          blank(i++); blank(i++);
        } else blank(i++);
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Common resolution helper
// ---------------------------------------------------------------------------

/**
 * Given a receiver variable name and a method name, look up the inferred type
 * of the receiver and resolve the method to a FunctionNode via the trie.
 */
export function resolveViaTypeInference(
  calleeObject: string,
  calleeName: string,
  inferredTypes: InferredTypes,
  trie: FunctionRegistryTrie,
): FunctionNode | undefined {
  const className = inferredTypes.get(calleeObject);
  if (!className) return undefined;
  const candidates = trie.findByQualifiedName(className, calleeName);
  // This low-level helper has no caller-file/import context with which to choose
  // between duplicate qualified types. Refuse ambiguity rather than binding by
  // insertion order; the call-graph builder applies its richer affinity ladder.
  return candidates.length === 1 ? candidates[0] : undefined;
}
