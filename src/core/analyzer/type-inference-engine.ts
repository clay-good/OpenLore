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
  'Python', 'C++', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'C#', 'Ruby',
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
    default:           return new Map();
  }
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
  return trie.findByQualifiedName(className, calleeName)[0];
}
