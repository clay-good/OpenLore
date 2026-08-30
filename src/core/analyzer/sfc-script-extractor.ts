/**
 * Script-container extraction for Vue, Svelte, and Astro single-file components.
 *
 * The returned source has exactly the same length and newline positions as the
 * container. Only supported `<script>` bodies survive, so the existing JS/TS
 * extractor can report positions against the original file.
 *
 * change: add-sfc-script-extraction
 */

import { MAX_SCRIPT_CONTAINER_CHARS } from '../../constants.js';
import {
  SCRIPT_CONTAINER_EXTENSIONS,
  SCRIPT_CONTAINER_FORMATS,
  type ScriptContainerFormat,
} from './language-detection.js';

export { SCRIPT_CONTAINER_FORMATS, type ScriptContainerFormat };

export const SCRIPT_CONTAINER_LIMITATIONS = [
  'template expressions',
  'framework macros',
  'Svelte reactive statements',
] as const;

const CLOSE_SCRIPT_RE = /<\/script\s*>/gi;
const ASTRO_FENCE_RE = /^---[ \t]*(?:\r?\n|$)/gm;

export interface ScriptContainerLane {
  language: 'JavaScript' | 'TypeScript';
  content: string;
}

export interface ScriptContainerExtraction {
  format: ScriptContainerFormat;
  /** All supported lanes overlaid at original offsets, for non-parser structural passes. */
  content: string | null;
  lanes: ScriptContainerLane[];
  scriptBlockCount: number;
  extractedScriptBlockCount: number;
  sizeCapped: boolean;
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
  return SCRIPT_CONTAINER_EXTENSIONS[ext] ?? null;
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, 'i').exec(attrs);
  return match?.[1]?.toLowerCase();
}

function blankPreservingNewlines(source: string): string {
  return source.replace(/[^\n]/g, ' ');
}

function blankRanges(source: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(source.slice(cursor, range.start));
    parts.push(blankPreservingNewlines(source.slice(range.start, range.end)));
    cursor = range.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

function markupTagEnd(source: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '<') return -2;
    else if (ch === '>') return i;
  }
  return -1;
}

function isMarkupTagStart(source: string, start: number): boolean {
  let cursor = start + 1;
  if (source[cursor] === '/') cursor++;
  if (source[cursor] === '!' || source[cursor] === '?') return true;
  if (!/[A-Za-z]/.test(source[cursor] ?? '')) return false;
  while (/[A-Za-z0-9:_.-]/.test(source[cursor] ?? '')) cursor++;
  const boundary = source[cursor];
  return boundary === '>' || boundary === '/' || boundary !== undefined && /\s/.test(boundary);
}

function afterAstroFrontmatter(source: string): number {
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.slice(start, start + 3) !== '---') return 0;
  const afterOpening = start + 3;
  if (source[afterOpening] !== '\n' && source.slice(afterOpening, afterOpening + 2) !== '\r\n') return 0;
  ASTRO_FENCE_RE.lastIndex = source.indexOf('\n', afterOpening) + 1;
  const closing = ASTRO_FENCE_RE.exec(source);
  return closing ? closing.index + closing[0].length : source.length;
}

function isScriptOpeningTag(source: string, start: number): boolean {
  if (source.slice(start + 1, start + 7).toLowerCase() !== 'script') return false;
  const boundary = source[start + 7];
  return boundary === '>' || boundary === '/' || boundary !== undefined && /\s/.test(boundary);
}

function reactiveStatementEnd(source: string, start: number, bodyEnd: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let quote: "'" | '"' | '`' | null = null;
  let blockComment = false;
  let lineComment = false;
  let sawToken = false;

  for (let i = start; i < bodyEnd; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      else continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; sawToken = true; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (!/\s/.test(ch)) sawToken = true;

    if (paren === 0 && bracket === 0 && brace === 0) {
      if (ch === ';') return i + 1;
      if (ch === '\n' && sawToken) return i;
    }
  }
  return bodyEnd;
}

function svelteReactiveRanges(source: string, bodyStart: number, bodyEnd: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let lineStart = bodyStart;
  while (lineStart < bodyEnd) {
    let lineEnd = lineStart;
    while (lineEnd < bodyEnd && source[lineEnd] !== '\n') lineEnd++;
    const match = /^\s*\$:/.exec(source.slice(lineStart, lineEnd));
    if (match) {
      const end = reactiveStatementEnd(source, lineStart + match[0].length, bodyEnd);
      ranges.push({ start: lineStart, end });
      lineStart = end;
      while (lineStart < bodyEnd && source[lineStart] !== '\n') lineStart++;
      lineStart++;
      continue;
    }
    lineStart = lineEnd + 1;
  }
  return ranges;
}

function laneContent(
  source: string,
  spans: Array<{ start: number; end: number }>,
  reactiveRanges: Array<{ start: number; end: number }>,
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(blankPreservingNewlines(source.slice(cursor, span.start)));
    parts.push(source.slice(span.start, span.end));
    cursor = span.end;
  }
  parts.push(blankPreservingNewlines(source.slice(cursor)));
  return blankRanges(parts.join(''), reactiveRanges);
}

/** Extract supported script islands, or `null` for a non-container path. */
export function extractScriptContainer(
  filePath: string,
  source: string,
): ScriptContainerExtraction | null {
  const format = scriptContainerFormat(filePath);
  if (!format) return null;

  // Decide the allocation budget before transforming or copying container text.
  const withinSizeCap = source.length <= MAX_SCRIPT_CONTAINER_CHARS;
  let scriptBlockCount = 0;
  let extractedScriptBlockCount = 0;
  const spansByLanguage = new Map<'JavaScript' | 'TypeScript', Array<{ start: number; end: number }>>();
  const reactiveRanges: Array<{ start: number; end: number }> = [];
  let hasSupportedBlock = false;

  let cursor = format === 'Astro' ? afterAstroFrontmatter(source) : 0;
  while (cursor < source.length) {
    const tagStart = source.indexOf('<', cursor);
    if (tagStart === -1) break;
    if (source.startsWith('<!--', tagStart)) {
      const commentEnd = source.indexOf('-->', tagStart + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }
    if (!isMarkupTagStart(source, tagStart)) {
      cursor = tagStart + 1;
      continue;
    }
    const openEnd = markupTagEnd(source, tagStart);
    if (openEnd === -2) {
      cursor = tagStart + 1;
      continue;
    }
    if (openEnd === -1) break;
    if (!isScriptOpeningTag(source, tagStart)) {
      cursor = openEnd + 1;
      continue;
    }

    const attrs = source.slice(tagStart + 7, openEnd);
    const bodyStart = openEnd + 1;
    CLOSE_SCRIPT_RE.lastIndex = bodyStart;
    const close = CLOSE_SCRIPT_RE.exec(source);
    if (!close) break;
    const closeIndex = close.index;
    scriptBlockCount++;

    const lang = attribute(attrs, 'lang');
    const external = /(?:^|\s)src\s*=/i.test(attrs);
    const supported = !external && (lang === undefined || lang === 'js' || lang === 'javascript' || lang === 'ts' || lang === 'typescript');
    if (supported) {
      hasSupportedBlock = true;
    }
    if (supported && withinSizeCap) {
      extractedScriptBlockCount++;
      if (closeIndex > bodyStart && /\S/.test(source.slice(bodyStart, closeIndex))) {
        const language = lang === 'ts' || lang === 'typescript' ? 'TypeScript' : 'JavaScript';
        const spans = spansByLanguage.get(language) ?? [];
        spans.push({ start: bodyStart, end: closeIndex });
        spansByLanguage.set(language, spans);
        if (format === 'Svelte') reactiveRanges.push(...svelteReactiveRanges(source, bodyStart, closeIndex));
      }
    }

    // Jump over the raw script body. Markup-looking strings inside it are script text,
    // not container comments or nested script blocks.
    cursor = closeIndex + close[0].length;
  }

  const allSpans = [...spansByLanguage.values()].flat().sort((a, b) => a.start - b.start);
  return {
    format,
    content: withinSizeCap
      ? laneContent(source, allSpans, format === 'Svelte' ? reactiveRanges : [])
      : null,
    lanes: [...spansByLanguage.entries()].map(([language, spans]) => ({
      language,
      content: laneContent(source, spans, format === 'Svelte' ? reactiveRanges : []),
    })),
    scriptBlockCount,
    extractedScriptBlockCount,
    sizeCapped: hasSupportedBlock && !withinSizeCap,
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
