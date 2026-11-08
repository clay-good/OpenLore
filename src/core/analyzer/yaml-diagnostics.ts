/**
 * Diagnostic routing for the `yaml` library.
 *
 * `yaml` writes its own diagnostics straight to the process's warning channel
 * (`process.emitWarning`) whenever its `logLevel` option allows it — the default
 * is `'warn'`. On a Helm chart that surfaced as, four times per `openlore
 * analyze` on kustomize:
 *
 *     (node:NNN) Warning: Keys with collection values will be stringified due to
 *     JS Object restrictions: "{ .Name }". Set mapAsMap: true to use object keys.
 *
 * That is not a user-actionable fact about the user's repository: it is a
 * consequence of OUR tolerant Go-template masking turning `{{ .Name }}` into a
 * YAML flow map, and of OUR choice to call `toJS()` without `mapAsMap`. The
 * information still belongs somewhere, so instead of discarding it:
 *
 *   - every OpenLore `yaml` parse passes {@link YAML_QUIET}, so the library
 *     never writes to the terminal itself; and
 *   - {@link reportStringifiedCollectionKeys} re-derives the same fact
 *     deterministically from the parsed document and reports it on OpenLore's
 *     own logger at debug level, where `--verbose` shows it with the file path
 *     the library's warning never carried.
 *
 * Nothing we read is lost by the stringification: the readers only consume
 * string-keyed fields (`kind`, `metadata.name`, …), and a collection-valued key
 * is never one of them. The debug line says which key it was, so a reader who
 * needs it can go look.
 */

import { isCollection, isPair, visit, type Document, type Node } from 'yaml';
import { logger } from '../../utils/logger.js';
import { sanitizeForTerminal } from '../../utils/misc.js';

/**
 * Parse options that keep the `yaml` library off the terminal.
 *
 * Spread into every `parse` / `parseDocument` / `parseAllDocuments` call:
 * `parseDocument(src, { ...YAML_QUIET, lineCounter })`.
 */
export const YAML_QUIET = { logLevel: 'silent' } as const;

/** How many distinct stringified keys one file reports before the rest are counted. */
const KEYS_REPORTED = 5;

type MaybeDocument = { contents?: unknown } | null | undefined;

/**
 * Report, on OpenLore's own logger at debug level, every map key in `docs` whose
 * value side is itself a collection — the keys `yaml` would have warned about
 * when the document is converted with `toJS()`.
 *
 * Deterministic and read-only: it inspects the already-parsed document and
 * never re-parses or mutates it.
 */
export function reportStringifiedCollectionKeys(
  docs: MaybeDocument | readonly MaybeDocument[],
  filePath: string,
): void {
  if (!logger.isDebugEnabled()) return;
  const list = Array.isArray(docs) ? docs : [docs];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const doc of list) {
    if (!doc?.contents) continue;
    try {
      visit(doc as Document, {
        Pair(_key, pair) {
          if (!isPair(pair) || !isCollection(pair.key as Node)) return;
          const rendered = String((pair.key as { toString(): string }).toString())
            .replace(/\s+/g, ' ')
            .trim();
          if (seen.has(rendered)) return;
          seen.add(rendered);
          keys.push(rendered);
        },
      });
    } catch {
      // A document shape `visit` cannot walk is not worth a diagnostic of its own.
      continue;
    }
  }
  if (keys.length === 0) return;
  const shown = keys.slice(0, KEYS_REPORTED).map(k => `"${sanitizeForTerminal(k)}"`).join(', ');
  const omitted = keys.length - Math.min(keys.length, KEYS_REPORTED);
  logger.debug(
    `[yaml] ${sanitizeForTerminal(filePath)}: ${keys.length} collection-valued map key(s) ` +
    `stringified when converted to JS: ${shown}${omitted > 0 ? ` … and ${omitted} more` : ''}. ` +
    `No field OpenLore reads is affected.`,
  );
}
