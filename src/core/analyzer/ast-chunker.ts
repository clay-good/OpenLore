/**
 * AST-based chunking using tree-sitter.
 *
 * Breaks content at real declaration boundaries (function, class, interface…)
 * rather than at accidental blank lines.  Falls back to blank-line chunking
 * when the language is unsupported or parsing fails.
 *
 * Each chunk after the first is prefixed with the file's import/header block
 * so the LLM always has module-level context.
 */

import type Parser from 'tree-sitter';
import { detectLanguage } from './language-detection.js';
import { parseWithBudget, type BudgetableParser } from './parse-budget.js';

// ── Lazy parser singletons (one per language, created on first use) ─────────

let _tsParser: Parser | undefined;
let _pyParser: Parser | undefined;
let _goParser: Parser | undefined;
let _rustParser: Parser | undefined;
let _rubyParser: Parser | undefined;
let _javaParser: Parser | undefined;

// null = tried and unavailable; undefined = not yet tried
let _NativeParser: (typeof Parser) | null | undefined;

async function loadNativeParser(): Promise<typeof Parser | null> {
  if (_NativeParser === undefined) {
    try {
      _NativeParser = ((await import('tree-sitter')).default) as typeof Parser;
    } catch {
      _NativeParser = null;
    }
  }
  return _NativeParser;
}

async function getParserForLanguage(lang: string): Promise<Parser | null> {
  try {
    const NP = await loadNativeParser();
    if (!NP) return null;
    switch (lang.toLowerCase()) {
      case 'typescript':
      case 'javascript': {
        if (!_tsParser) {
          const m = await import('tree-sitter-typescript');
          _tsParser = new NP();
          _tsParser.setLanguage(
            ((m.default ?? m) as { typescript: object }).typescript as Parser.Language
          );
        }
        return _tsParser!;
      }
      case 'python': {
        if (!_pyParser) {
          const m = await import('tree-sitter-python');
          _pyParser = new NP();
          _pyParser.setLanguage((m.default ?? m) as Parser.Language);
        }
        return _pyParser!;
      }
      case 'go': {
        if (!_goParser) {
          const m = await import('tree-sitter-go');
          _goParser = new NP();
          _goParser.setLanguage((m.default ?? m) as Parser.Language);
        }
        return _goParser!;
      }
      case 'rust': {
        if (!_rustParser) {
          const m = await import('tree-sitter-rust');
          _rustParser = new NP();
          _rustParser.setLanguage((m.default ?? m) as Parser.Language);
        }
        return _rustParser!;
      }
      case 'ruby': {
        if (!_rubyParser) {
          const m = await import('tree-sitter-ruby');
          _rubyParser = new NP();
          _rubyParser.setLanguage((m.default ?? m) as Parser.Language);
        }
        return _rubyParser!;
      }
      case 'java': {
        if (!_javaParser) {
          const m = await import('tree-sitter-java');
          _javaParser = new NP();
          _javaParser.setLanguage((m.default ?? m) as Parser.Language);
        }
        return _javaParser!;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Import-block detection ──────────────────────────────────────────────────

function isImportNode(type: string): boolean {
  return (
    type.startsWith('import') ||
    type === 'use_declaration' ||   // Rust
    type === 'package_clause' ||    // Go
    type === 'require_clause'       // Ruby
  );
}

/**
 * Return the source text up to (and including) the last contiguous import
 * node at the top of the file.  Empty string when no imports are detected.
 */
function extractHeader(topNodes: Parser.SyntaxNode[], source: string): string {
  let lastImportEnd = 0;
  for (const n of topNodes) {
    if (isImportNode(n.type)) {
      lastImportEnd = n.endIndex;
    } else if (lastImportEnd > 0) {
      // Stop at the first non-import node after seeing at least one import
      break;
    }
  }
  return lastImportEnd > 0 ? source.slice(0, lastImportEnd).trim() : '';
}

// ── Blank-line fallback ─────────────────────────────────────────────────────

/**
 * Original blank-line chunking, kept as fallback for unsupported languages.
 */
export function blankLineChunk(content: string, maxChars: number, overlapLines = 10): string[] {
  if (content.length <= maxChars) return [content];

  const lines = content.split('\n');
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentSize = 0;

  for (const line of lines) {
    currentLines.push(line);
    currentSize += line.length + 1;
    if (currentSize >= maxChars && line.trim() === '') {
      const chunk = currentLines.join('\n').trim();
      if (chunk) chunks.push(chunk);
      const overlap = currentLines.slice(-overlapLines);
      currentLines = [...overlap];
      currentSize = overlap.reduce((s, l) => s + l.length + 1, 0);
    }
  }

  const remaining = currentLines.join('\n').trim();
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── AST chunker ─────────────────────────────────────────────────────────────

/**
 * Chunk `content` at real AST declaration boundaries using tree-sitter.
 *
 * Falls back to blank-line chunking if the language is unsupported or parsing
 * fails.  Each chunk after the first is prefixed with the file's imports block
 * so the LLM always has module-level context (e.g. class declaration visible
 * when processing a method that was split into a later chunk).
 */
export async function astChunkContent(
  content: string,
  filePath: string,
  maxChars: number,
  overlapLines = 10,
): Promise<string[]> {
  if (content.length <= maxChars) return [content];

  const language = detectLanguage(filePath);
  const parser = await getParserForLanguage(language);
  if (!parser) return blankLineChunk(content, maxChars, overlapLines);

  let tree: Parser.Tree;
  try {
    // Bounded like every other parse (change: fix-analyze-native-abort-and-file-cost-budget). This
    // one only runs on content ALREADY over the chunk size, so it is exactly where a pathological
    // file shows up; on the budget it falls through to the blank-line chunker below, which needs
    // no grammar. Degraded chunking, never a stalled run.
    tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);
  } catch {
    return blankLineChunk(content, maxChars, overlapLines);
  }

  // Top-level children that carry real content (skip whitespace / standalone comments)
  const topNodes = tree.rootNode.children.filter(
    n => n.type !== 'comment' && n.text.trim().length > 0
  );
  if (topNodes.length === 0) return blankLineChunk(content, maxChars, overlapLines);

  // Header = import/package block, prepended to every non-first chunk
  const header = extractHeader(topNodes, content);

  const chunks: string[] = [];
  let groupStart = -1;
  let groupEnd = -1;

  const emitGroup = (start: number, end: number): void => {
    const text = content.slice(start, end).trim();
    if (!text) return;
    if (chunks.length > 0 && header) {
      chunks.push(`${header}\n\n${text}`);
    } else {
      chunks.push(text);
    }
  };

  for (const node of topNodes) {
    if (groupStart === -1) {
      groupStart = node.startIndex;
      groupEnd = node.endIndex;
      continue;
    }

    const nodeSpan = node.endIndex - groupStart;
    // Account for header prefix added to non-first chunks
    const effectiveSize = chunks.length > 0 && header ? header.length + 2 + nodeSpan : nodeSpan;

    if (effectiveSize > maxChars) {
      emitGroup(groupStart, groupEnd);
      groupStart = node.startIndex;
      groupEnd = node.endIndex;
    } else {
      groupEnd = node.endIndex;
    }
  }

  if (groupStart !== -1) emitGroup(groupStart, groupEnd);

  return chunks.length > 0 ? chunks : blankLineChunk(content, maxChars, overlapLines);
}
