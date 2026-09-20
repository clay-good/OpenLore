/**
 * `locate_symbol_span` MCP handler (change: add-symbol-span-locator).
 *
 * The read-only, staleness-checked edit LOCATION an agent can trust. OpenLore
 * already resolves a task to a precise symbol (`suggest_insertion_points` names
 * the function; tree-sitter gives byte-exact spans; `find_clones`-style
 * `name::path` addressing disambiguates). But when the agent goes to APPLY an
 * edit, it re-locates that span by string-matching a fresh read — the one step
 * where the substrate's knowledge is thrown away and replaced by guesswork
 * (wrong-overload hits, duplicated snippets, whitespace drift), with no signal
 * that the index it is trusting is even current.
 *
 * This tool closes that gap without giving OpenLore a write face: it returns the
 * indexed symbol's span (byte + line) plus a freshness VERDICT, and the host
 * applies the edit with its own tool. It adds precision and a freshness
 * guarantee, not write authority.
 *
 * Freshness (fail-safe toward distrust, matching `FreshnessFailsSafeTowardDistrust`):
 *   - `fresh`  — the substrate can vouch that the recorded offsets still point at
 *                the indexed symbol: either the file's content hash still matches
 *                the hash the index recorded (authoritative), or — when the full
 *                analyze recorded no per-file hash — the file has not been written
 *                since the index artifact was produced.
 *   - `stale`  — the file changed since analysis (content hash differs, or it was
 *                written after the index). The offsets are NOT trustworthy; the
 *                tool returns a re-analyze hint instead of a location.
 *   - `ambiguous` / `not-found` — a bare name matching several / no symbols → the
 *                `name::path` candidate list, never a fuzzy guess.
 *
 * Computed live from the cached call graph + a re-read of the one file the symbol
 * spans (no new persisted artifact). Read-only: the handler never writes, moves,
 * or deletes any file.
 */

import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
} from '../../../constants.js';
import { validateDirectory, readCachedContext, safeJoin } from './utils.js';
import { readFileConfined } from '../../../utils/path-confinement.js';
import { hashSpan } from '../../decisions/anchor.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';
import { buildWorkingTreeOverlay } from '../../analyzer/working-tree-overlay.js';
import { resolveFileFreshness } from './freshness.js';

export interface LocateSymbolSpanInput {
  directory: string;
  /** The symbol to locate: its name, or `name::path` to disambiguate. */
  symbol?: string;
}

/** Serialized call-graph node fields this handler reads. */
interface SerNode {
  name: string;
  filePath: string;
  startIndex: number;
  endIndex: number;
  startLine?: number;
  endLine?: number;
  language?: string;
  isExternal?: boolean;
}

const HTML_RE = /\.html?$/i;

const SPAN_NOTE =
  'startByte/endByte are tree-sitter offsets — UTF-16 code-unit indices into the file read as a ' +
  'JS string (spanEncoding), NOT UTF-8 byte offsets: slice the file with String.slice, not Buffer.slice. ' +
  'startLine/endLine are 1-based inclusive. contentHash is hashSpan over the current span — an integrity ' +
  'token the host can re-check after reading. OpenLore returns the location only; the host applies the edit.';

/**
 * Locate a symbol's edit span with a freshness verdict. Read-only, deterministic,
 * offline. Returns `unknown` (additive-by-cast), conclusion-shaped — a single
 * verdict + location or a candidate list, never a graph.
 */
export async function handleLocateSymbolSpan(input: LocateSymbolSpanInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);

  const sym = typeof input.symbol === 'string' ? input.symbol.trim() : '';
  if (sym.length === 0) {
    return { error: 'Provide `symbol` — a function name, or name::path to disambiguate.' };
  }

  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const allNodes = (cg.nodes ?? []) as unknown as SerNode[];
  // Resolution pool: internal symbols only — external/synthesized nodes carry no
  // source span to locate. The cached graph is an untrusted repository artifact,
  // so drop any internal node whose path escapes the root lexically or through a
  // symlink before it can participate in resolution or appear in output.
  const confinedPaths = new Map<SerNode, string>();
  const pool = allNodes.filter(n => {
    if (n.isExternal) return false;
    try {
      confinedPaths.set(n, safeJoin(absDir, n.filePath));
      return true;
    } catch {
      return false;
    }
  });

  const sep = sym.indexOf('::');
  const namePart = sep >= 0 ? sym.slice(0, sep) : sym;
  const pathPart = sep >= 0 ? sym.slice(sep + 2) : undefined;

  let candidates = pool.filter(n => n.name === namePart);
  if (pathPart) {
    candidates = candidates.filter(n => n.filePath === pathPart || n.filePath.endsWith(pathPart));
  }

  if (candidates.length === 0) {
    // A symbol WRITTEN since the index was built is not in the pool at all, so resolution
    // fails before any freshness check runs. When the caller named the file, that file can
    // simply be read: bounded (one file), and the honest answer to "where is this symbol"
    // when the symbol plainly exists on disk.
    if (pathPart) {
      const overlay = await buildWorkingTreeOverlay(absDir, [pathPart]);
      const fresh = overlay.nodes.find(n => n.name === namePart);
      if (fresh) {
        const source = await readFileConfined(absDir, pathPart).catch(() => null);
        if (source !== null) {
          const text = source.slice(fresh.startIndex, fresh.endIndex);
          const line = source.slice(0, fresh.startIndex).split('\n').length;
          const newlines = (text.match(/\n/g) ?? []).length;
          return {
            verdict: 'fresh' as const,
            symbol: fresh.id,
            file: pathPart,
            language: fresh.language,
            startLine: line,
            endLine: Math.max(line, line + newlines - (text.endsWith('\n') ? 1 : 0)),
            startByte: fresh.startIndex,
            endByte: fresh.endIndex,
            spanEncoding: 'utf16' as const,
            contentHash: hashSpan(text),
            source: 'working-tree-overlay' as const,
            note: SPAN_NOTE,
            indexBehind: {
              note: 'This symbol is not in the index yet; the span was read from the working tree. It has no recorded callers until the index catches up.',
            },
          };
        }
      }
    }
    const nameLower = namePart.toLowerCase();
    const near = [...new Set(pool.map(n => n.name))]
      .filter(nm => nm.toLowerCase().includes(nameLower))
      .slice(0, 10);
    return {
      verdict: 'not-found' as const,
      query: sym,
      candidates: near,
      hint: near.length
        ? 'Did you mean one of these? Pass name::path to disambiguate.'
        : 'If the code is new, run analyze_codebase.',
    };
  }
  if (candidates.length > 1) {
    return {
      verdict: 'ambiguous' as const,
      query: sym,
      candidates: candidates.slice(0, 10).map(n => `${n.name}::${relative(absDir, confinedPaths.get(n)!)}`),
      hint: `"${sym}" matches ${candidates.length} symbols. Pass name::path to disambiguate.`,
    };
  }

  const node = candidates[0];
  const abs = confinedPaths.get(node)!;
  const confinedFile = relative(absDir, abs);
  const symbolId = `${node.name}::${confinedFile}`;

  // Locatability guards — a symbol that resolves but has no trustworthy raw-source
  // span. Disclosed as an explicit reason, never a fabricated offset.
  if (node.startIndex >= node.endIndex) {
    return {
      error: `"${symbolId}" has no source span (external or synthesized symbol) — nothing to locate.`,
    };
  }
  if (HTML_RE.test(confinedFile)) {
    return {
      error:
        `"${symbolId}" is an HTML inline-script symbol: its indexed offsets are against transformed ` +
        '(blanked) HTML, so they do not align with a raw re-read. It cannot be located for a byte-exact edit.',
    };
  }

  // Re-read the one file the symbol spans. Unreadable/deleted since analysis → the
  // offsets are meaningless; fail safe to `stale`.
  let content: string;
  try {
    content = await readFileConfined(absDir, confinedFile);
  } catch {
    return {
      verdict: 'stale' as const,
      symbol: symbolId,
      file: confinedFile,
      hint: `${confinedFile} could not be read (moved or deleted since analysis). Re-run analyze_codebase.`,
    };
  }

  const currentFileHash = createHash('sha256').update(content).digest('hex');
  const baselineFileHash = ctx.edgeStore?.getFileHash(node.filePath) ?? null;

  // mtime fallback inputs (used only when no per-file baseline hash was recorded).
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT);
  let artifactMtimeMs = 0;
  let sourceMtimeMs = Number.MAX_SAFE_INTEGER; // unknown source mtime → distrust
  try {
    artifactMtimeMs = (await stat(artifactPath)).mtimeMs;
    sourceMtimeMs = (await stat(abs)).mtimeMs;
  } catch {
    // A missing artifact/source stat leaves the fail-safe defaults (source newer
    // than artifact → `stale`).
  }

  const verdict = resolveFileFreshness({ baselineFileHash, currentFileHash, sourceMtimeMs, artifactMtimeMs });

  if (verdict === 'stale') {
    // The index's offsets are worthless here — but the bytes on disk are right in front
    // of us. Re-extract this one file and locate the symbol in the CURRENT source, which
    // is the difference between an unusable answer and a usable one (spec `mcp-handlers`
    // ExactPositionsPreferTheOverlay).
    const overlay = await buildWorkingTreeOverlay(absDir, [confinedFile]);
    const overlaid: FunctionNode | undefined = overlay.nodes.find(n => n.id === symbolId)
      ?? overlay.nodes.find(n => n.name === node.name && n.filePath === confinedFile);
    if (overlaid) {
      const overlaidText = content.slice(overlaid.startIndex, overlaid.endIndex);
      const overlaidStartLine = content.slice(0, overlaid.startIndex).split('\n').length;
      const overlaidNewlines = (overlaidText.match(/\n/g) ?? []).length;
      return {
        verdict: 'fresh' as const,
        symbol: overlaid.id,
        file: confinedFile,
        language: overlaid.language,
        startLine: overlaidStartLine,
        endLine: Math.max(overlaidStartLine, overlaidStartLine + overlaidNewlines - (overlaidText.endsWith('\n') ? 1 : 0)),
        startByte: overlaid.startIndex,
        endByte: overlaid.endIndex,
        spanEncoding: 'utf16' as const,
        contentHash: hashSpan(overlaidText),
        // Provenance, not decoration: these offsets came from the working tree, and the
        // symbol's callers are still the index's.
        source: 'working-tree-overlay' as const,
        note: SPAN_NOTE,
        indexBehind: {
          note: 'The index is behind this file; the span above was read from the working tree. Callers and impact for this symbol still come from the index and may predate the edit.',
        },
      };
    }
    return {
      verdict,
      symbol: symbolId,
      file: confinedFile,
      hint: 'The index is behind the working tree — the recorded offsets are not trustworthy. Re-run analyze_codebase (or let the watcher catch up) before editing at these offsets.',
    };
  }

  // fresh: the file matches what the index saw, so the recorded offsets align. Derive
  // the line span from the current content + offsets the SAME way the freshness engine
  // does (anchor-adapter `nodeSpanInfo`), so the cited lines match the hashed span.
  const spanText = content.slice(node.startIndex, node.endIndex);
  const startLine = content.slice(0, node.startIndex).split('\n').length;
  const newlines = (spanText.match(/\n/g) ?? []).length;
  const endLine = Math.max(startLine, startLine + newlines - (spanText.endsWith('\n') ? 1 : 0));

  return {
    verdict,
    symbol: symbolId,
    file: confinedFile,
    language: node.language,
    startLine,
    endLine,
    startByte: node.startIndex,
    endByte: node.endIndex,
    spanEncoding: 'utf16' as const,
    contentHash: hashSpan(spanText),
    note: SPAN_NOTE,
  };
}
