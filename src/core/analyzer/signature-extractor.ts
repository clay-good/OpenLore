/**
 * Signature Extractor
 *
 * Extracts function/class signatures and docstrings from source files
 * across multiple languages using regex patterns (no AST required).
 *
 * Used to build a compact semantic index of all project files for Stage 1,
 * replacing the simple file-path list with language-aware summaries.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractedSignature {
  kind: 'class' | 'function' | 'method' | 'interface' | 'type' | 'const';
  name: string;
  signature: string;   // compact one-liner
  docstring?: string;  // first meaningful line of doc comment
  decorator?: string;  // e.g. @router.get('/path') for FastAPI
}

export interface FileSignatureMap {
  path: string;        // relative path
  language: string;    // 'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'Java', 'C++', 'Swift',
                       // 'C#', 'Kotlin', 'PHP', 'C', 'Scala', 'Dart', 'Lua', 'Elixir', 'Bash', IaC tags, or 'unknown'
  entries: ExtractedSignature[];
}

// Max signatures per file to keep output compact
const MAX_SIGS_PER_FILE = 25;

// Max chars per Stage 1 chunk (~10k tokens, safe for all providers)
export const STAGE1_MAX_CHARS = 40_000;

// ============================================================================
// LANGUAGE DETECTION
// ============================================================================

export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  // Terraform is unambiguous by extension (incl. the *.tf.json variant).
  if (lower.endsWith('.tf') || lower.endsWith('.tfvars') || lower.endsWith('.tf.json')) {
    return 'Terraform';
  }
  // Bicep is unambiguous by extension (Azure IaC DSL).
  if (lower.endsWith('.bicep')) {
    return 'Bicep';
  }
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'py':           return 'Python';
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'TypeScript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'JavaScript';
    case 'go':           return 'Go';
    case 'rs':           return 'Rust';
    case 'rb':           return 'Ruby';
    case 'java':         return 'Java';
    case 'kt': case 'kts': return 'Kotlin';
    case 'php': case 'phtml': return 'PHP';
    case 'cs':           return 'C#';
    case 'cpp': case 'cc': case 'cxx': case 'h': case 'hpp': return 'C++';
    case 'c':            return 'C';
    case 'swift':        return 'Swift';
    case 'scala': case 'sc': return 'Scala';
    case 'dart':         return 'Dart';
    case 'lua':          return 'Lua';
    case 'ex': case 'exs': return 'Elixir';
    case 'sh': case 'bash': return 'Bash';
    default:             return 'unknown';
  }
}

/**
 * Resolve the language of a `.h` header (spec-08). `.h` is claimed by both C and
 * C++. Rule: a project with `.c` files and no C++ sources → C; otherwise C++
 * (the default / superset, which parses C headers acceptably).
 */
export function resolveHeaderLanguage(hasCSources: boolean, hasCppSources: boolean): 'C' | 'C++' {
  return (!hasCppSources && hasCSources) ? 'C' : 'C++';
}

// ============================================================================
// PYTHON EXTRACTOR
// ============================================================================

function extractPython(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');
  let pendingDecorator: string | undefined;
  let currentClass: string | undefined;
  let currentClassIndent = -1;

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Track class context (methods vs module-level functions)
    if (indent === 0 && currentClass && indent <= currentClassIndent) {
      currentClass = undefined;
      currentClassIndent = -1;
    }

    // Decorator lines
    const decoratorMatch = trimmed.match(/^(@(?:[\w.]+)(?:\([^)]*\))?)/);
    if (decoratorMatch) {
      pendingDecorator = decoratorMatch[1];
      continue;
    }

    // Class declaration
    const classMatch = trimmed.match(/^class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/);
    if (classMatch && indent === 0) {
      const name = classMatch[1];
      const bases = classMatch[2] ? `(${classMatch[2]})` : '';
      const docstring = extractPythonDocstring(lines, i + 1);
      entries.push({
        kind: 'class',
        name,
        signature: `class ${name}${bases}:`,
        docstring,
      });
      currentClass = name;
      currentClassIndent = indent;
      pendingDecorator = undefined;
      continue;
    }

    // Function / method declaration
    const funcMatch = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?\s*:/);
    if (funcMatch) {
      const isAsync = !!funcMatch[1];
      const name = funcMatch[2];
      const params = funcMatch[3].trim();
      const ret = funcMatch[4]?.trim() ?? '';

      // Skip private methods (leading underscore) unless very few entries so far
      if (name.startsWith('_') && name !== '__init__' && entries.length > 2) {
        pendingDecorator = undefined;
        continue;
      }

      const asyncPrefix = isAsync ? 'async ' : '';
      const returnSuffix = ret ? ` -> ${ret}` : '';
      // Compact params: remove 'self' from display
      const displayParams = params
        .split(',')
        .map(p => p.trim())
        .filter(p => p !== 'self' && p !== 'cls')
        .join(', ');
      const sig = `${asyncPrefix}def ${name}(${displayParams})${returnSuffix}`;

      const docstring = extractPythonDocstring(lines, i + 1);
      const kind: ExtractedSignature['kind'] = indent > 0 ? 'method' : 'function';

      entries.push({
        kind,
        name,
        signature: (indent > 0 ? '  ' : '') + sig,
        docstring,
        decorator: pendingDecorator,
      });

      pendingDecorator = undefined;
      continue;
    }

    // Module-level ALL_CAPS constants (PEP 8 convention), only at indent 0 and outside class
    const constMatch = indent === 0 && !currentClass
      ? trimmed.match(/^([A-Z][A-Z0-9_]{1,})\s*(?::\s*[\w[\], |]+)?\s*=/)
      : null;
    if (constMatch) {
      const name = constMatch[1];
      const sig = trimmed.slice(0, 80).replace(/\s+/g, ' ');
      // Use preceding # comment as docstring
      const comment = lines[i - 1]?.trim().startsWith('#')
        ? lines[i - 1].trim().slice(1).trim()
        : undefined;
      entries.push({ kind: 'const', name, signature: sig, docstring: comment });
      pendingDecorator = undefined;
      continue;
    }

    // Reset decorator if line is neither decorator nor def/class
    if (trimmed && !trimmed.startsWith('#')) {
      pendingDecorator = undefined;
    }
  }

  return entries;
}

function extractPythonDocstring(lines: string[], startIdx: number): string | undefined {
  const next = lines[startIdx]?.trimStart() ?? '';
  if (next.startsWith('"""') || next.startsWith("'''")) {
    const quote = next.startsWith('"""') ? '"""' : "'''";
    const inner = next.slice(3);
    // Single-line docstring: """Text"""
    if (inner.includes(quote)) {
      return inner.slice(0, inner.indexOf(quote)).trim() || undefined;
    }
    // Multi-line: take the first non-empty line
    return inner.trim() || lines[startIdx + 1]?.trim() || undefined;
  }
  return undefined;
}

// ============================================================================
// TYPESCRIPT / JAVASCRIPT EXTRACTOR
// ============================================================================

function extractTypeScript(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Collect JSDoc comment above the declaration
    let jsDoc: string | undefined;
    if (i > 0) {
      jsDoc = extractJSDoc(lines, i);
    }

    // export class / export abstract class
    const classMatch = trimmed.match(/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w<>, .]+?))?(?:\s+implements\s+[\w<>, .]+)?\s*\{?/);
    if (classMatch) {
      const name = classMatch[1];
      const ext = classMatch[2] ? ` extends ${classMatch[2].trim()}` : '';
      entries.push({ kind: 'class', name, signature: `export class ${name}${ext}`, docstring: jsDoc });
      continue;
    }

    // export interface
    const ifaceMatch = trimmed.match(/^export\s+(?:default\s+)?interface\s+(\w+)(?:\s+extends\s+[\w<>, .]+)?\s*\{?/);
    if (ifaceMatch) {
      entries.push({ kind: 'interface', name: ifaceMatch[1], signature: `export interface ${ifaceMatch[1]}`, docstring: jsDoc });
      continue;
    }

    // export type
    const typeMatch = trimmed.match(/^export\s+type\s+(\w+)\s*(?:<[^>]*>)?\s*=/);
    if (typeMatch) {
      entries.push({ kind: 'type', name: typeMatch[1], signature: `export type ${typeMatch[1]}`, docstring: jsDoc });
      continue;
    }

    // export function / export async function / export default function
    const fnMatch = trimmed.match(/^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/);
    if (fnMatch) {
      const name = fnMatch[1];
      const params = compactParams(fnMatch[2]);
      const ret = fnMatch[3]?.trim().replace(/\s+/g, ' ') ?? '';
      const sig = `export function ${name}(${params})${ret ? ': ' + ret : ''}`;
      entries.push({ kind: 'function', name, signature: sig, docstring: jsDoc });
      continue;
    }

    // Multi-line export function: `export [async] function name(` with params on following lines
    const fnOpenMatch = trimmed.match(/^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\($/);
    if (fnOpenMatch) {
      const name = fnOpenMatch[1];
      // Scan forward to collect params until closing paren
      let parenDepth = 1;
      const paramLines: string[] = [];
      let retType = '';
      let j = i + 1;
      for (; j < lines.length && parenDepth > 0; j++) {
        const jl = lines[j];
        for (const ch of jl) {
          if (ch === '(') parenDepth++;
          else if (ch === ')') { parenDepth--; if (parenDepth === 0) break; }
        }
        if (parenDepth > 0) paramLines.push(jl.trim().replace(/,$/, ''));
      }
      // Try to get return type from the line after closing paren (e.g. `): Promise<T> {`)
      if (j < lines.length) {
        const retMatch = lines[j].match(/\)\s*:\s*([^{]+)/);
        if (retMatch) retType = retMatch[1].trim().replace(/\s+/g, ' ');
      }
      const params = paramLines.map(p => p.split(':')[0].trim()).filter(Boolean).join(', ');
      const sig = `export function ${name}(${params})${retType ? ': ' + retType : ''}`;
      entries.push({ kind: 'function', name, signature: sig, docstring: jsDoc });
      continue;
    }

    // export const foo = (...) => / export const foo: Type = (...)
    const arrowMatch = trimmed.match(/^export\s+const\s+(\w+)(?:\s*:\s*[\w<>[\], |&]+)?\s*=\s*(?:async\s+)?\(/);
    if (arrowMatch) {
      entries.push({ kind: 'function', name: arrowMatch[1], signature: `export const ${arrowMatch[1]} = (...)`, docstring: jsDoc });
      continue;
    }

    // export const FOO = { ... } / [...] / primitive — objects, arrays, config constants
    const constMatch = trimmed.match(/^export\s+const\s+(\w+)/);
    if (constMatch) {
      const sig = trimmed.slice(0, 80).replace(/\s+/g, ' ');
      entries.push({ kind: 'const', name: constMatch[1], signature: sig, docstring: jsDoc });
      continue;
    }

    // Public/private class methods (indented, not '#' private fields) — single-line params
    // Private methods with JSDoc are included: they're documented because the impl is worth finding.
    const methodMatch = trimmed.match(/^(?:public\s+|static\s+|override\s+|async\s+|private\s+|protected\s+)*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?.*\{/);
    if (methodMatch && line.startsWith('  ') && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('#')) {
      const name = methodMatch[1];
      if (/^[a-z]/.test(name) && name !== 'if' && name !== 'for' && name !== 'while' && name !== 'switch' && name !== 'return') {
        const params = compactParams(methodMatch[2]);
        const ret = methodMatch[3]?.trim().replace(/\s+/g, ' ') ?? '';
        entries.push({ kind: 'method', name, signature: `  ${name}(${params})${ret ? ': ' + ret : ''}`, docstring: jsDoc });
        continue;
      }
    }

    // Multi-line class method: `[static] [async] methodName(` with no closing paren on same line
    const methodOpenMatch = trimmed.match(/^(?:public\s+|static\s+|override\s+|async\s+|private\s+|protected\s+)*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\($/);
    if (methodOpenMatch && line.startsWith('  ') && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('#')) {
      const name = methodOpenMatch[1];
      if (/^[a-z]/.test(name) && name !== 'if' && name !== 'for' && name !== 'while' && name !== 'switch' && name !== 'return') {
        let parenDepth = 1;
        const paramLines: string[] = [];
        let retType = '';
        let j = i + 1;
        for (; j < lines.length && parenDepth > 0; j++) {
          const jl = lines[j];
          for (const ch of jl) {
            if (ch === '(') parenDepth++;
            else if (ch === ')') { parenDepth--; if (parenDepth === 0) break; }
          }
          if (parenDepth > 0) paramLines.push(jl.trim().replace(/,$/, ''));
        }
        if (j < lines.length) {
          const retMatch = lines[j].match(/\)\s*:\s*([^{]+)/);
          if (retMatch) retType = retMatch[1].trim().replace(/\s+/g, ' ');
        }
        const params = paramLines.map(p => p.split(':')[0].trim()).filter(Boolean).join(', ');
        entries.push({ kind: 'method', name, signature: `  ${name}(${params})${retType ? ': ' + retType : ''}`, docstring: jsDoc });
      }
    }
  }

  return entries;
}

function extractJSDoc(lines: string[], declLineIdx: number): string | undefined {
  // Walk backwards to find */ then /**
  let endIdx = declLineIdx - 1;
  // Skip blank lines
  while (endIdx >= 0 && lines[endIdx].trim() === '') endIdx--;
  if (endIdx < 0 || !lines[endIdx].trim().endsWith('*/')) return undefined;

  let startIdx = endIdx;
  while (startIdx >= 0 && !lines[startIdx].trim().startsWith('/**')) startIdx--;
  if (startIdx < 0) return undefined;

  // Find first meaningful @description or plain text line
  for (let j = startIdx + 1; j <= endIdx; j++) {
    const t = lines[j].replace(/^\s*\*\s?/, '').trim();
    if (t && !t.startsWith('@')) return t;
  }
  return undefined;
}

function compactParams(params: string): string {
  return params
    .split(',')
    .map(p => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ');
}

// ============================================================================
// GO EXTRACTOR
// ============================================================================

function extractGo(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    // func (r *Receiver) Name(args) ret or func Name(args) ret
    const match = line.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\([^)]*\)|[\w*[\], ]+))?/);
    if (match) {
      const name = match[1];
      if (name === 'init' || name.startsWith('test') || name.startsWith('Test')) continue;
      // Grab comment above
      const comment = lines[i - 1]?.trim().startsWith('//') ? lines[i - 1].trim().slice(2).trim() : undefined;
      entries.push({ kind: 'function', name, signature: line.trim().replace(/\s*\{.*$/, ''), docstring: comment });
    }

    // type Foo struct or type Foo interface
    const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)\s*\{?/);
    if (typeMatch) {
      entries.push({ kind: typeMatch[2] === 'interface' ? 'interface' : 'class', name: typeMatch[1], signature: `type ${typeMatch[1]} ${typeMatch[2]}` });
    }
  }

  return entries;
}

// ============================================================================
// RUST EXTRACTOR
// ============================================================================

function extractRust(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];

    // pub fn / pub async fn
    const fnMatch = line.match(/^\s*pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/);
    if (fnMatch) {
      const name = fnMatch[1];
      const params = compactParams(fnMatch[2]);
      const ret = fnMatch[3]?.trim() ?? '';
      const sig = `pub fn ${name}(${params})${ret ? ' -> ' + ret : ''}`;
      const comment = lines[i - 1]?.trim().startsWith('///') ? lines[i - 1].trim().slice(3).trim() : undefined;
      entries.push({ kind: 'function', name, signature: sig, docstring: comment });
    }

    // pub struct / pub enum
    const typeMatch = line.match(/^\s*pub(?:\(crate\))?\s+(struct|enum)\s+(\w+)/);
    if (typeMatch) {
      entries.push({ kind: 'class', name: typeMatch[2], signature: `pub ${typeMatch[1]} ${typeMatch[2]}` });
    }
  }

  return entries;
}

// ============================================================================
// RUBY EXTRACTOR
// ============================================================================

function extractRuby(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i].trim();

    const classMatch = line.match(/^class\s+(\w+)(?:\s*<\s*(\w+))?/);
    if (classMatch) {
      const name = classMatch[1];
      const parent = classMatch[2] ? ` < ${classMatch[2]}` : '';
      entries.push({ kind: 'class', name, signature: `class ${name}${parent}` });
      continue;
    }

    const methodMatch = line.match(/^def\s+(\w+)(?:\s*\(([^)]*)\))?/);
    if (methodMatch) {
      const name = methodMatch[1];
      const params = methodMatch[2] ? `(${methodMatch[2]})` : '';
      entries.push({ kind: 'function', name, signature: `def ${name}${params}` });
    }
  }

  return entries;
}

// ============================================================================
// C++ EXTRACTOR
// ============================================================================

/** Keywords that look like function names but are control-flow or declarations */
const CPP_SKIP_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'namespace', 'class', 'struct',
  'return', 'delete', 'do', 'else', 'new', 'sizeof', 'static_assert', 'assert',
  'typedef', 'template', 'decltype', 'alignof', 'typeid',
]);

function extractCpp(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip preprocessor directives, comments, empty lines
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // class / struct declaration (not a forward declaration ending in ;)
    const classMatch = trimmed.match(/^(?:class|struct)\s+(\w+)\b/);
    if (classMatch && !trimmed.endsWith(';')) {
      const keyword = trimmed.startsWith('struct') ? 'struct' : 'class';
      const name = classMatch[1];
      const comment = lines[i - 1]?.trim().startsWith('//') ? lines[i - 1].trim().slice(2).trim() : undefined;
      entries.push({ kind: 'class', name, signature: `${keyword} ${name}`, docstring: comment });
      continue;
    }

    // Function / method: look for Name(params) followed by qualifiers then { or :
    // This regex finds the last word before a ( that has content after closing )
    const fnMatch = trimmed.match(/\b(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:noexcept[^{;]*)?\s*(?:override\s*)?(?:final\s*)?(?:->\s*[\w:*&<>, ]+\s*)?[{:]/);
    if (fnMatch) {
      const name = fnMatch[1];
      if (!CPP_SKIP_NAMES.has(name) && /^[a-zA-Z_]/.test(name)) {
        const params = compactParams(fnMatch[2]);
        const comment = lines[i - 1]?.trim().startsWith('//') ? lines[i - 1].trim().slice(2).trim() : undefined;
        const kind: ExtractedSignature['kind'] = line.startsWith('  ') || line.startsWith('\t') ? 'method' : 'function';
        entries.push({ kind, name, signature: `${name}(${params})`, docstring: comment });
      }
    }
  }

  return entries;
}

// ============================================================================
// SWIFT EXTRACTOR
// ============================================================================

function extractSwift(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Collect /// doc comment above the declaration
    let docstring: string | undefined;
    if (i > 0) {
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === '') j--;
      if (j >= 0 && lines[j].trim().startsWith('///')) {
        docstring = lines[j].trim().slice(3).trim() || undefined;
      }
    }

    // class / struct / actor / enum declaration
    const typeMatch = trimmed.match(/^(?:public\s+|open\s+|internal\s+|private\s+|fileprivate\s+)*(?:final\s+)?(class|struct|actor|enum)\s+(\w+)/);
    if (typeMatch) {
      const keyword = typeMatch[1];
      const name = typeMatch[2];
      const kind: ExtractedSignature['kind'] = keyword === 'enum' ? 'type' : 'class';
      entries.push({ kind, name, signature: `${keyword} ${name}`, docstring });
      continue;
    }

    // protocol declaration
    const protocolMatch = trimmed.match(/^(?:public\s+|internal\s+|private\s+|fileprivate\s+)*protocol\s+(\w+)/);
    if (protocolMatch) {
      entries.push({ kind: 'interface', name: protocolMatch[1], signature: `protocol ${protocolMatch[1]}`, docstring });
      continue;
    }

    // func declaration (free or method)
    const funcMatch = trimmed.match(/^(?:public\s+|open\s+|internal\s+|private\s+|fileprivate\s+|static\s+|class\s+|override\s+|mutating\s+)*(?:async\s+)?func\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*(?:async|throws|rethrows))?\s*(?:->\s*([^{]+))?/);
    if (funcMatch) {
      const name = funcMatch[1];
      const params = compactParams(funcMatch[2]);
      const ret = funcMatch[3]?.trim().replace(/\s+/g, ' ') ?? '';
      const isMethod = line.startsWith('  ') || line.startsWith('\t');
      const sig = `func ${name}(${params})${ret ? ' -> ' + ret : ''}`;
      entries.push({ kind: isMethod ? 'method' : 'function', name, signature: isMethod ? '  ' + sig : sig, docstring });
      continue;
    }

    // init declaration
    const initMatch = trimmed.match(/^(?:public\s+|internal\s+|private\s+|fileprivate\s+|convenience\s+|required\s+)*init\s*(?:\?|!)?(?:<[^>]*>)?\s*\(/);
    if (initMatch) {
      const sig = 'init(' + (trimmed.split('(')[1]?.split(')')[0] ?? '') + ')';
      entries.push({ kind: 'method', name: 'init', signature: '  ' + sig.slice(0, 80), docstring });
      continue;
    }
  }

  return entries;
}

// ============================================================================
// JAVA EXTRACTOR
// ============================================================================

/** Java modifier keywords that can precede a type or method declaration. */
const JAVA_MODIFIER_PREFIX =
  '(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|abstract\\s+|synchronized\\s+|default\\s+|native\\s+|sealed\\s+|non-sealed\\s+)*';

/** Keywords that look like method names but are not. */
const JAVA_SKIP_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'return', 'do', 'else', 'try', 'catch', 'finally',
  'new', 'throw', 'class', 'interface', 'enum', 'record',
]);

/**
 * Statement keywords that can appear in the "return type" position of the
 * method regex on a body line (e.g. `return foo(args);`, `throw new X();`).
 * Because signatures are extracted from raw source (bodies are not stripped),
 * such lines must be rejected — they are calls, not declarations.
 */
const JAVA_STMT_KEYWORDS = new Set([
  'return', 'throw', 'yield', 'assert', 'else', 'case', 'default', 'break',
  'continue', 'new', 'this', 'super',
]);

function extractJava(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Track multi-line `/* … */` blocks. License headers (e.g. Apache's) wrap
    // prose in a block comment whose continuation lines start with spaces, not
    // `*`, so a line like "Licensed to the Apache Software Foundation (ASF)…"
    // would otherwise be mis-parsed as a method declaration.
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true;
      continue;
    }

    // Skip lines that are clearly not declarations
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (trimmed.startsWith('@')) continue; // annotations

    // Collect Javadoc comment above the declaration (walk back through
    // annotations and blank lines to find the closing `*/`).
    const docstring = extractJavadoc(lines, i);

    // class / interface / enum / record / @interface
    const typeMatch = trimmed.match(
      new RegExp('^' + JAVA_MODIFIER_PREFIX + '(class|interface|enum|record|@interface)\\s+(\\w+)')
    );
    if (typeMatch) {
      const keyword = typeMatch[1];
      const name = typeMatch[2];
      const kind: ExtractedSignature['kind'] =
        keyword === 'interface' || keyword === '@interface' ? 'interface' : 'class';
      const sig = trimmed.replace(/\s*\{.*$/, '').slice(0, 120);
      entries.push({ kind, name, signature: sig, docstring });
      continue;
    }

    // Method: `[modifiers] [<generics>] ReturnType name(params) [throws …]`.
    // Captured parts (modifiers, type parameters, throws) are preserved in the
    // signature so the reader can see visibility, abstractness, and checked
    // exceptions. The type-parameter sub-pattern allows one level of nested
    // generics and `&` intersection bounds (`<T extends Number & Comparable<T>>`)
    // so such methods are no longer dropped entirely. See #138.
    const methodMatch = trimmed.match(
      new RegExp(
        '^(' + JAVA_MODIFIER_PREFIX + ')' +
          '(<(?:[^<>]|<[^<>]*>)*>\\s+)?' +     // optional method type params
          '([\\w<>\\[\\], ?.]+?)\\s+' +        // return type
          '(\\w+)\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)' + // name(params) — params may
                                                       // contain annotations with
                                                       // parens, e.g. @PathVariable(...)
          '(?:\\s*throws\\s+([^{;]+))?'         // optional throws clause
      )
    );
    if (methodMatch) {
      const modifiers = methodMatch[1].trim().replace(/\s+/g, ' ');
      const typeParams = (methodMatch[2] ?? '').trim();
      const returnType = methodMatch[3].trim();
      const name = methodMatch[4];
      if (JAVA_SKIP_NAMES.has(name)) continue;
      // Reject body statements like `return foo(args);` that slipped into the
      // declaration regex (signatures are extracted from un-skeletonized source).
      if (JAVA_STMT_KEYWORDS.has(returnType.split(/[\s.]/)[0])) continue;
      // Skip obvious field declarations like `private final Foo bar = ...` —
      // fields don't have `(` so the regex wouldn't match. This path is
      // method-only by construction.
      const params = compactParams(methodMatch[5]);
      const throwsClause = methodMatch[6] ? ` throws ${methodMatch[6].trim().replace(/\s+/g, ' ')}` : '';
      const isMethod = line.startsWith('  ') || line.startsWith('\t');
      const head = [modifiers, typeParams, returnType].filter(Boolean).join(' ');
      const sig = `${head} ${name}(${params})${throwsClause}`;
      entries.push({
        kind: isMethod ? 'method' : 'function',
        name,
        signature: (isMethod ? '  ' : '') + sig,
        docstring,
      });
      continue;
    }
  }

  return entries;
}

/**
 * Walk backwards from declLineIdx, skipping annotations and blank lines, to
 * find a preceding Javadoc block (`/** … *\/`). Returns the first meaningful
 * line of the block, or undefined.
 */
function extractJavadoc(lines: string[], declLineIdx: number): string | undefined {
  let endIdx = declLineIdx - 1;
  // Skip annotation lines and blanks
  while (endIdx >= 0) {
    const t = lines[endIdx].trim();
    if (t === '' || t.startsWith('@')) { endIdx--; continue; }
    break;
  }
  if (endIdx < 0 || !lines[endIdx].trim().endsWith('*/')) return undefined;

  let startIdx = endIdx;
  while (startIdx >= 0 && !lines[startIdx].trim().startsWith('/**')) startIdx--;
  if (startIdx < 0) return undefined;

  for (let j = startIdx + 1; j <= endIdx; j++) {
    const t = lines[j].replace(/^\s*\*\s?/, '').trim();
    if (t && !t.startsWith('@') && !t.startsWith('/')) return t;
  }
  return undefined;
}

// ============================================================================
// GENERIC FALLBACK EXTRACTOR
// ============================================================================

function extractGeneric(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    // Generic: lines that look like declarations (function/class/def keywords)
    const match = line.match(/^\s*(?:public|private|protected|export|static|async)?\s*(?:function|class|def|func|fn|sub|procedure)\s+(\w+)/);
    if (match) {
      entries.push({ kind: 'function', name: match[1], signature: line.trim().slice(0, 120) });
    }
  }

  return entries;
}

// ============================================================================
// TERRAFORM EXTRACTOR (spec-07)
// ============================================================================

function extractTerraformSignatures(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const re = /^\s*(resource|data|module|variable|output|provider)\s+("[^"]+"(?:\s+"[^"]+")?|\w+)/gm;
  for (const m of content.matchAll(re)) {
    if (entries.length >= MAX_SIGS_PER_FILE) break;
    const block = m[1];
    const labels = m[2].replace(/"/g, '');
    entries.push({
      kind: block === 'module' || block === 'provider' ? 'class' : 'const',
      name: labels.split(/\s+/).join('.'),
      signature: `${block} ${m[2]}`,
    });
  }
  return entries;
}

// ============================================================================
// BICEP EXTRACTOR (Azure IaC — add-bicep-iac-graph)
// ============================================================================

function extractBicepSignatures(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  // Top-level declarations only (depth 0): keyword, symbolic name, optional 'type' literal.
  const re = /^(resource|module|param|var|output)\s+([A-Za-z_]\w*)\s*('[^']*')?/gm;
  for (const m of content.matchAll(re)) {
    if (entries.length >= MAX_SIGS_PER_FILE) break;
    const keyword = m[1];
    const name = m[2];
    const typeLit = m[3] ? ` ${m[3]}` : '';
    entries.push({
      kind: keyword === 'resource' || keyword === 'module' ? 'class' : 'const',
      name,
      signature: `${keyword} ${name}${typeLit}`,
    });
  }
  return entries;
}

// ============================================================================
// ADDITIONAL GENERAL-PURPOSE LANGUAGES (spec-08) — best-effort Stage-1 regexes
// ============================================================================
//
// Lightweight declaration regexes so these languages are searchable via BM25
// even when their tree-sitter grammar fails to load (graceful degradation). The
// call graph is the authoritative source when the grammar IS available.

interface SigPattern { re: RegExp; kind: ExtractedSignature['kind']; }

const EXTRA_LANG_PATTERNS: Record<string, SigPattern[]> = {
  'C#': [
    { re: /^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\b(?:class|interface|struct|record|enum)\s+(\w+)/gm, kind: 'class' },
    { re: /^\s*(?:public|private|protected|internal|static|async|virtual|override|\s)+[\w<>[\],?]+\s+(\w+)\s*\(/gm, kind: 'method' },
  ],
  Kotlin: [
    { re: /^\s*(?:public|private|internal|open|abstract|sealed|data|\s)*\b(?:class|object|interface)\s+(\w+)/gm, kind: 'class' },
    { re: /^\s*(?:public|private|internal|open|override|suspend|\s)*\bfun\s+(?:[\w.<>]+\.)?(\w+)\s*\(/gm, kind: 'function' },
  ],
  PHP: [
    { re: /^\s*(?:abstract|final|\s)*\b(?:class|trait|interface|enum)\s+(\w+)/gm, kind: 'class' },
    { re: /^\s*(?:public|private|protected|static|abstract|final|\s)*\bfunction\s+(\w+)\s*\(/gm, kind: 'function' },
  ],
  C: [
    { re: /^[A-Za-z_][\w\s*]*\b(\w+)\s*\([^;{]*\)\s*\{/gm, kind: 'function' },
  ],
  Scala: [
    { re: /^\s*(?:case\s+)?\b(?:object|class|trait)\s+(\w+)/gm, kind: 'class' },
    { re: /^\s*(?:override|implicit|private|protected|\s)*\bdef\s+(\w+)/gm, kind: 'function' },
  ],
  Dart: [
    { re: /^\s*(?:abstract\s+)?\b(?:class|mixin|extension|enum)\s+(\w+)/gm, kind: 'class' },
    { re: /^\s*(?:[\w<>,?]+\s+)?(\w+)\s*\([^;{]*\)\s*(?:async\s*)?\{/gm, kind: 'function' },
  ],
  Lua: [
    { re: /^\s*(?:local\s+)?function\s+([\w.:]+)/gm, kind: 'function' },
  ],
  Elixir: [
    { re: /^\s*defmodule\s+([\w.]+)/gm, kind: 'class' },
    { re: /^\s*def(?:p|macro|macrop)?\s+(\w+)/gm, kind: 'function' },
  ],
  Bash: [
    { re: /^\s*(?:function\s+(\w+)|(\w+)\s*\(\s*\))/gm, kind: 'function' },
  ],
};

function extractExtraLangSignatures(language: string, content: string): ExtractedSignature[] {
  const patterns = EXTRA_LANG_PATTERNS[language];
  if (!patterns) return [];
  const entries: ExtractedSignature[] = [];
  const seen = new Set<string>();
  for (const { re, kind } of patterns) {
    for (const m of content.matchAll(re)) {
      if (entries.length >= MAX_SIGS_PER_FILE) break;
      const name = m[1] ?? m[2];
      if (!name || seen.has(`${kind}:${name}`)) continue;
      seen.add(`${kind}:${name}`);
      entries.push({ kind, name, signature: m[0].trim().replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return entries;
}

// ============================================================================
// MAIN EXTRACTOR
// ============================================================================

/**
 * Languages with a DEDICATED signature extractor (vs. the best-effort `extractGeneric`
 * fallback every other language receives). Authoritative source for the `signatures`
 * capability flag in the declarative language-support registry (change:
 * add-declarative-language-support-registry). MUST list exactly the non-`default` cases
 * of the {@link extractSignatures} switch below; a behavioral test asserts a fixture in
 * each member yields ≥1 signature entry.
 */
export const SIGNATURE_LANGUAGES: ReadonlySet<string> = new Set<string>([
  'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'C++', 'Swift', 'Java',
  'Terraform', 'Bicep', 'C#', 'Kotlin', 'PHP', 'C', 'Scala', 'Dart', 'Lua', 'Elixir', 'Bash',
]);

export function extractSignatures(filePath: string, content: string): FileSignatureMap {
  const language = detectLanguage(filePath);
  let entries: ExtractedSignature[];

  switch (language) {
    case 'Python':
      entries = extractPython(content);
      break;
    case 'TypeScript':
    case 'JavaScript':
      entries = extractTypeScript(content);
      break;
    case 'Go':
      entries = extractGo(content);
      break;
    case 'Rust':
      entries = extractRust(content);
      break;
    case 'Ruby':
      entries = extractRuby(content);
      break;
    case 'C++':
      entries = extractCpp(content);
      break;
    case 'Swift':
      entries = extractSwift(content);
      break;
    case 'Java':
      entries = extractJava(content);
      break;
    case 'Terraform':
      entries = extractTerraformSignatures(content);
      break;
    case 'Bicep':
      entries = extractBicepSignatures(content);
      break;
    case 'C#':
    case 'Kotlin':
    case 'PHP':
    case 'C':
    case 'Scala':
    case 'Dart':
    case 'Lua':
    case 'Elixir':
    case 'Bash':
      entries = extractExtraLangSignatures(language, content);
      break;
    default:
      entries = extractGeneric(content);
      break;
  }

  return { path: filePath, language, entries };
}

// ============================================================================
// FORMATTER
// ============================================================================

/**
 * Format signature maps as compact text blocks for Stage 1 LLM prompt.
 * Returns an array of chunk strings — 1 element if total fits within maxChars,
 * N elements if chunking is needed. Files are never split across chunks.
 */
export function formatSignatureMaps(
  maps: FileSignatureMap[],
  maxChars = STAGE1_MAX_CHARS
): string[] {
  // Filter out files with no signatures
  const meaningful = maps.filter(m => m.entries.length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const map of meaningful) {
    const block = formatSingleFile(map);
    // If adding this block would exceed the limit, flush current chunk
    if (current.length > 0 && current.length + block.length > maxChars) {
      chunks.push(current.trim());
      current = '';
    }
    current += block + '\n';
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : ['(no signatures extracted)'];
}

function formatSingleFile(map: FileSignatureMap): string {
  const lines: string[] = [`=== ${map.path} [${map.language}] ===`];

  for (const entry of map.entries) {
    if (entry.decorator) {
      lines.push(entry.decorator);
    }
    lines.push(entry.signature);
    if (entry.docstring) {
      const indent = entry.signature.startsWith('  ') ? '    ' : '  ';
      lines.push(`${indent}"""${entry.docstring}"""`);
    }
  }

  return lines.join('\n') + '\n';
}
