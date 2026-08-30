/**
 * Script-container extraction for Vue, Svelte, and Astro single-file components.
 *
 * The returned source has exactly the same length and newline positions as the
 * container. Only supported `<script>` bodies survive, so the existing JS/TS
 * extractor can report positions against the original file.
 *
 * change: add-sfc-script-extraction
 */

export const SCRIPT_CONTAINER_FORMATS = ['Vue', 'Svelte', 'Astro'] as const;
export type ScriptContainerFormat = (typeof SCRIPT_CONTAINER_FORMATS)[number];

export const SCRIPT_CONTAINER_LIMITATIONS = [
  'template expressions',
  'framework macros',
  'Svelte reactive statements',
] as const;

const FORMAT_BY_EXTENSION: Readonly<Record<string, ScriptContainerFormat>> = {
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
};

const OPEN_SCRIPT_RE = /<script\b([^<>]*)>/gi;
const CLOSE_TAG = '</script';

export interface ScriptContainerExtraction {
  format: ScriptContainerFormat;
  language: 'JavaScript' | 'TypeScript';
  content: string | null;
  scriptBlockCount: number;
  extractedScriptBlockCount: number;
}

export interface ScriptContainerFileRecord {
  filePath: string;
  format: ScriptContainerFormat;
  scriptBlockCount: number;
  extractedScriptBlockCount: number;
}

export interface ScriptContainerBoundary {
  format: ScriptContainerFormat;
  extension: string;
  fileCount: number;
  scriptBlockCount: number;
  extractedScriptBlockCount: number;
  limitations: string[];
  files: ScriptContainerFileRecord[];
}

export function scriptContainerFormat(filePath: string): ScriptContainerFormat | null {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  return FORMAT_BY_EXTENSION[ext] ?? null;
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, 'i').exec(attrs);
  return match?.[1]?.toLowerCase();
}

function blankSvelteReactiveStatements(chars: string[], bodyStart: number, bodyEnd: number): void {
  let lineStart = bodyStart;
  while (lineStart < bodyEnd) {
    let lineEnd = lineStart;
    while (lineEnd < bodyEnd && chars[lineEnd] !== '\n') lineEnd++;
    const line = chars.slice(lineStart, lineEnd).join('');
    if (/^\s*\$:/.test(line)) {
      for (let i = lineStart; i < lineEnd; i++) chars[i] = ' ';
    }
    lineStart = lineEnd + 1;
  }
}

/** Extract supported script islands, or `null` for a non-container path. */
export function extractScriptContainer(
  filePath: string,
  source: string,
): ScriptContainerExtraction | null {
  const format = scriptContainerFormat(filePath);
  if (!format) return null;

  const out = source.replace(/[^\n]/g, ' ').split('');
  const lower = source.toLowerCase();
  let scriptBlockCount = 0;
  let extractedScriptBlockCount = 0;
  let typed = false;

  OPEN_SCRIPT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_SCRIPT_RE.exec(source)) !== null) {
    const attrs = match[1];
    const bodyStart = match.index + match[0].length;
    const closeIndex = lower.indexOf(CLOSE_TAG, bodyStart);
    if (closeIndex === -1) break;
    scriptBlockCount++;

    const lang = attribute(attrs, 'lang');
    const external = /(?:^|\s)src\s*=/i.test(attrs);
    const supported = !external && (lang === undefined || lang === 'js' || lang === 'javascript' || lang === 'ts' || lang === 'typescript');
    if (supported && closeIndex > bodyStart) {
      for (let i = bodyStart; i < closeIndex; i++) out[i] = source[i];
      if (format === 'Svelte') blankSvelteReactiveStatements(out, bodyStart, closeIndex);
      extractedScriptBlockCount++;
      if (lang === 'ts' || lang === 'typescript') typed = true;
    }

    OPEN_SCRIPT_RE.lastIndex = closeIndex + CLOSE_TAG.length;
  }

  return {
    format,
    language: typed ? 'TypeScript' : 'JavaScript',
    content: extractedScriptBlockCount > 0 ? out.join('') : null,
    scriptBlockCount,
    extractedScriptBlockCount,
  };
}

export function summarizeScriptContainers(
  files: ScriptContainerFileRecord[],
): ScriptContainerBoundary[] {
  return SCRIPT_CONTAINER_FORMATS.flatMap(format => {
    const matching = files
      .filter(file => file.format === format)
      .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
    if (matching.length === 0) return [];
    return [{
      format,
      extension: `.${format.toLowerCase()}`,
      fileCount: matching.length,
      scriptBlockCount: matching.reduce((sum, file) => sum + file.scriptBlockCount, 0),
      extractedScriptBlockCount: matching.reduce(
        (sum, file) => sum + file.extractedScriptBlockCount,
        0,
      ),
      limitations: [...SCRIPT_CONTAINER_LIMITATIONS],
      files: matching,
    }];
  });
}

export function describeScriptContainerBoundaries(
  boundaries: readonly ScriptContainerBoundary[] | undefined,
): string | undefined {
  if (!boundaries?.length) return undefined;
  const files = boundaries.reduce((sum, boundary) => sum + boundary.fileCount, 0);
  const blocks = boundaries.reduce((sum, boundary) => sum + boundary.scriptBlockCount, 0);
  const extracted = boundaries.reduce(
    (sum, boundary) => sum + boundary.extractedScriptBlockCount,
    0,
  );
  const unextracted = blocks - extracted;
  const formats = boundaries.map(boundary => boundary.extension).join('/');
  const extraction = unextracted > 0
    ? `${unextracted} script block${unextracted === 1 ? '' : 's'} not extracted`
    : `${extracted} script block${extracted === 1 ? '' : 's'} extracted`;
  return `${files} ${formats} file${files === 1 ? '' : 's'} contain ${blocks} script block${blocks === 1 ? '' : 's'} (${extraction}); `
    + `unanalyzed container semantics: ${SCRIPT_CONTAINER_LIMITATIONS.join(', ')}`;
}
