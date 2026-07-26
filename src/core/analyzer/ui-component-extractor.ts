/**
 * UI Component Extractor
 *
 * Detects React, Vue, Svelte, and Angular UI components from source files
 * using regex-based analysis (no tree-sitter required).
 *
 * Detection strategy per framework:
 *   - React: function/const export with PascalCase name in JSX/TSX files
 *   - Vue: Single File Components (.vue) with <template> blocks
 *   - Svelte: .svelte files (each file = one component)
 *   - Angular: @Component decorator
 */

import { readFile } from 'node:fs/promises';
import { basename, extname, relative } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

export interface ComponentProp {
  name: string;
  type: string;
  required: boolean;
}

export interface UIComponent {
  /** PascalCase component name */
  name: string;
  /** Path relative to project root */
  file: string;
  /** UI framework */
  framework: 'react' | 'vue' | 'svelte' | 'angular';
  /** Whether this is the default export */
  isDefault: boolean;
  /** 1-based line number of the declaration */
  line: number;
  /** Extracted props (up to MAX_PROPS) */
  props: ComponentProp[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_PROPS = 10;

// React: export (default) function PascalName or export const PascalName = ...
const REACT_FUNCTION_COMPONENT = /^export\s+(default\s+)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*[(<]/m;
const REACT_ARROW_COMPONENT = /^export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:React\.memo\(|React\.forwardRef\(|\(|async\s*\()/m;
const REACT_FORWARD_REF = /^export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:forwardRef|memo)\s*[(<]/m;
// const REACT_DEFAULT_EXPORT_ANON = /^export\s+default\s+(?:function|class)\s*\(/m; // reserved for future use

// TypeScript interface/type props extraction: interface XxxProps { ... }
// Bounded body: an unbounded `[^}]+` is quadratic on repeated `interface Props {`.
const TS_PROPS_INTERFACE = /interface\s+\w*Props\s*\{([^}]{0,20000})\}/gs;
const TS_PROP_LINE = /^\s+(\w+)(\?)?:\s*([^;,\n]+)/m;

// Vue SFC
const VUE_TEMPLATE_BLOCK = /<template[\s>]/;
const VUE_SCRIPT_SETUP_PROPS = /defineProps\s*[<(]/;
const VUE_OPTIONS_PROPS = /\bprops\s*:\s*\{([^}]+)\}/s;
// const VUE_PROP_NAME = /^\s+(\w+)\s*:/m; // reserved for future use

// Angular
const ANGULAR_COMPONENT_DECORATOR = /@Component\s*\(/;
const ANGULAR_CLASS_NAME = /class\s+([A-Z][A-Za-z0-9_]*)\s*(?:implements|extends|\{)/;

// ============================================================================
// HELPERS
// ============================================================================

function extractReactProps(source: string): ComponentProp[] {
  const props: ComponentProp[] = [];
  const ifaceRegex = new RegExp(TS_PROPS_INTERFACE.source, TS_PROPS_INTERFACE.flags);
  let ifaceMatch: RegExpExecArray | null;

  while ((ifaceMatch = ifaceRegex.exec(source)) !== null) {
    const body = ifaceMatch[1];
    const lines = body.split('\n');
    for (const line of lines) {
      const m = TS_PROP_LINE.exec(line);
      if (m) {
        props.push({
          name: m[1],
          type: m[3].trim().replace(/[;,]$/, ''),
          required: m[2] !== '?',
        });
        if (props.length >= MAX_PROPS) break;
      }
    }
    if (props.length >= MAX_PROPS) break;
  }

  return props;
}

function extractVueProps(source: string): ComponentProp[] {
  const props: ComponentProp[] = [];

  // Composition API: defineProps<{ name: string; ... }>()
  const setupMatch = VUE_SCRIPT_SETUP_PROPS.exec(source);
  if (setupMatch) {
    const genericMatch = source.slice(setupMatch.index).match(/defineProps\s*<\s*\{([^}]+)\}>/s);
    if (genericMatch) {
      const lines = genericMatch[1].split('\n');
      for (const line of lines) {
        const m = TS_PROP_LINE.exec(line);
        if (m) {
          props.push({ name: m[1], type: m[3].trim().replace(/[;,]$/, ''), required: m[2] !== '?' });
          if (props.length >= MAX_PROPS) break;
        }
      }
    }
    return props;
  }

  // Options API: props: { name: { type: String, required: true }, ... }
  const optMatch = VUE_OPTIONS_PROPS.exec(source);
  if (optMatch) {
    const body = optMatch[1];
    const propNameRegex = /^\s+(\w+)\s*:/gm;
    let m: RegExpExecArray | null;
    while ((m = propNameRegex.exec(body)) !== null) {
      props.push({ name: m[1], type: 'unknown', required: false });
      if (props.length >= MAX_PROPS) break;
    }
  }

  return props;
}

function lineOfIndex(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

// ============================================================================
// PER-FILE EXTRACTOR
// ============================================================================

async function extractFromFile(filePath: string, rootDir: string): Promise<UIComponent[]> {
  const ext = extname(filePath).toLowerCase();
  const rel = relative(rootDir, filePath);
  let source: string;

  try {
    source = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  // ── Svelte ────────────────────────────────────────────────────────────────
  if (ext === '.svelte') {
    const name = basename(filePath, '.svelte');
    if (!/^[A-Z]/.test(name)) return []; // skip non-component svelte files
    const props: ComponentProp[] = [];
    // Svelte 4: export let propName: Type = default
    const exportLetRe = /export\s+let\s+(\w+)\s*(?::\s*([^=;\n]+))?/g;
    let m: RegExpExecArray | null;
    while ((m = exportLetRe.exec(source)) !== null && props.length < MAX_PROPS) {
      props.push({ name: m[1], type: (m[2] ?? 'unknown').trim(), required: false });
    }
    // Svelte 5: $props() rune — just note it
    return [{
      name,
      file: rel,
      framework: 'svelte',
      isDefault: true,
      line: 1,
      props,
    }];
  }

  // ── Vue SFC ───────────────────────────────────────────────────────────────
  if (ext === '.vue') {
    if (!VUE_TEMPLATE_BLOCK.test(source)) return [];
    const name = basename(filePath, '.vue');
    if (!/^[A-Z]/.test(name)) return [];
    return [{
      name,
      file: rel,
      framework: 'vue',
      isDefault: true,
      line: 1,
      props: extractVueProps(source),
    }];
  }

  // ── Angular ───────────────────────────────────────────────────────────────
  if ((ext === '.ts' || ext === '.tsx') && ANGULAR_COMPONENT_DECORATOR.test(source)) {
    const classMatch = ANGULAR_CLASS_NAME.exec(source);
    if (classMatch) {
      const idx = ANGULAR_COMPONENT_DECORATOR.exec(source)!.index;
      return [{
        name: classMatch[1],
        file: rel,
        framework: 'angular',
        isDefault: false,
        line: lineOfIndex(source, idx),
        props: [],
      }];
    }
    return [];
  }

  // ── React (JSX/TSX/JS/JSX) ────────────────────────────────────────────────
  if (ext === '.tsx' || ext === '.jsx' || ext === '.js' || ext === '.ts') {
    const components: UIComponent[] = [];
    const props = extractReactProps(source);

    // function components
    const fnRe = new RegExp(REACT_FUNCTION_COMPONENT.source, 'gm');
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(source)) !== null) {
      const isDefault = !!m[1];
      const name = m[2];
      if (!name) continue;
      components.push({
        name,
        file: rel,
        framework: 'react',
        isDefault,
        line: lineOfIndex(source, m.index),
        props,
      });
    }

    // Arrow / const components
    const arrowRe = new RegExp(REACT_ARROW_COMPONENT.source, 'gm');
    while ((m = arrowRe.exec(source)) !== null) {
      const name = m[1];
      if (!name || components.some(c => c.name === name)) continue;
      components.push({
        name,
        file: rel,
        framework: 'react',
        isDefault: false,
        line: lineOfIndex(source, m.index),
        props,
      });
    }

    // forwardRef/memo wrappers
    const fwdRe = new RegExp(REACT_FORWARD_REF.source, 'gm');
    while ((m = fwdRe.exec(source)) !== null) {
      const name = m[1];
      if (!name || components.some(c => c.name === name)) continue;
      components.push({
        name,
        file: rel,
        framework: 'react',
        isDefault: false,
        line: lineOfIndex(source, m.index),
        props,
      });
    }

    return components;
  }

  return [];
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Extract UI components from a list of absolute file paths.
 *
 * @param filePaths - Absolute paths to source files
 * @param rootDir   - Project root used to compute relative paths in output
 */
export async function extractUIComponents(
  filePaths: string[],
  rootDir: string
): Promise<UIComponent[]> {
  const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.ts', '.js']);

  const candidates = filePaths.filter(f => UI_EXTENSIONS.has(extname(f).toLowerCase()));

  const results = await Promise.all(
    candidates.map(f => extractFromFile(f, rootDir))
  );

  return results.flat();
}

/**
 * Summarise components by framework for display / artifact embedding.
 */
export function summarizeUIComponents(
  components: UIComponent[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of components) {
    counts[c.framework] = (counts[c.framework] ?? 0) + 1;
  }
  return counts;
}
