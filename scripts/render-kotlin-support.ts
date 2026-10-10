/**
 * Regenerate the Kotlin section of docs/language-support.md from the reference ledger
 * (change: add-kotlin-reference-corpus-conformance). Run: `npx tsx scripts/render-kotlin-support.ts`.
 * The conformance test fails when the checked-in section differs from the ledger.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { KOTLIN_DOC_MARKERS, renderKotlinSupportSection } from '../src/core/analyzer/kotlin-reference/ledger.js';

import { KOTLIN_SYNTAX_DOC_MARKERS, renderKotlinSyntaxSection } from '../src/core/analyzer/kotlin-syntax-corpus.js';

const path = new URL('../docs/language-support.md', import.meta.url);

function replaceSection(doc: string, markers: { start: string; end: string }, rendered: string): string {
  const start = doc.indexOf(markers.start);
  const end = doc.indexOf(markers.end);
  if (start < 0 || end < start) throw new Error(`Section markers not found in docs/language-support.md: ${markers.start}`);
  return doc.slice(0, start) + rendered + doc.slice(end + markers.end.length);
}

let doc = readFileSync(path, 'utf-8');
doc = replaceSection(doc, KOTLIN_DOC_MARKERS, renderKotlinSupportSection());
doc = replaceSection(doc, KOTLIN_SYNTAX_DOC_MARKERS, renderKotlinSyntaxSection());
writeFileSync(path, doc);
