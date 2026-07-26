/**
 * Digest generator — converts OpenSpec markdown files into a plain-English
 * summary for human review.  Source spec files are never modified.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR } from '../../constants.js';
import { isConfinedPath } from '../../utils/path-confinement.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DigestScenario {
  name: string;
  summary: string;
}

export interface DigestRequirement {
  name: string;
  scenarios: DigestScenario[];
}

export interface DigestDomain {
  name: string;
  description: string;
  requirements: DigestRequirement[];
}

export interface DigestResult {
  domains: DigestDomain[];
  totalRequirements: number;
  totalScenarios: number;
}

// ============================================================================
// PARSING HELPERS
// ============================================================================

/** Extract bullet text from lines like "- **GIVEN** foo" or "- **given** foo" */
function extractBullets(lines: string[], keyword: string): string[] {
  const re = new RegExp(`^-\\s+\\*\\*${keyword}\\*\\*\\s*`, 'i');
  return lines
    .filter(l => re.test(l.trim()))
    .map(l => l.trim().replace(re, '').trim());
}

/**
 * Collapse GIVEN / WHEN / THEN into a single readable sentence.
 * Strategy: "{when} → {then}". When there are multiple THEN clauses,
 * join them with "; ".
 */
function collapseSentence(given: string[], when: string[], then: string[]): string {
  const whenStr = when.join('; ') || given.join('; ') || '—';
  const thenStr = then.join('; ') || '—';
  return `${capitalize(whenStr)} → ${thenStr}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extract the first plain-text sentence from a spec section (used for domain
 * description — the prose between the `## Purpose` heading and the next heading).
 */
function extractDescription(lines: string[]): string {
  let inPurpose = false;
  const sentences: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+Purpose/i.test(trimmed)) { inPurpose = true; continue; }
    if (inPurpose) {
      if (/^#{1,6}\s/.test(trimmed)) break; // next heading
      if (trimmed && !trimmed.startsWith('>') && !trimmed.startsWith('|')) {
        sentences.push(trimmed);
        if (sentences.length >= 2) break;
      }
    }
  }

  // Fallback: use the first non-heading, non-empty line
  if (sentences.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('>') && !trimmed.startsWith('|') && !trimmed.startsWith('_')) {
        sentences.push(trimmed);
        break;
      }
    }
  }

  return sentences.join(' ');
}

// ============================================================================
// DOMAIN PARSER
// ============================================================================

function parseDomain(domainName: string, content: string): DigestDomain {
  const lines = content.split('\n');
  const description = extractDescription(lines);
  const requirements: DigestRequirement[] = [];

  let currentReq: DigestRequirement | null = null;
  let bodyLines: string[] = [];
  let inScenario = false;
  let currentScenarioName = '';

  const flushScenario = () => {
    if (!inScenario || !currentReq) return;
    const given = extractBullets(bodyLines, 'given');
    const when = extractBullets(bodyLines, 'when');
    const then = extractBullets(bodyLines, 'then');
    if (given.length > 0 || when.length > 0 || then.length > 0) {
      currentReq.scenarios.push({
        name: currentScenarioName,
        summary: collapseSentence(given, when, then),
      });
    }
    bodyLines = [];
    inScenario = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // ### Requirement: Name
    if (/^###\s+Requirement:\s*/i.test(trimmed)) {
      flushScenario();
      const reqName = trimmed.replace(/^###\s+Requirement:\s*/i, '').trim();
      currentReq = { name: reqName, scenarios: [] };
      requirements.push(currentReq);
      continue;
    }

    // #### Scenario: Name
    if (/^####\s+Scenario:\s*/i.test(trimmed)) {
      flushScenario();
      currentScenarioName = trimmed.replace(/^####\s+Scenario:\s*/i, '').trim();
      inScenario = true;
      continue;
    }

    if (inScenario) {
      bodyLines.push(line);
    }
  }

  flushScenario();

  return { name: domainName, description, requirements };
}

// ============================================================================
// MAIN
// ============================================================================

export async function generateDigest(opts: {
  rootPath: string;
  domains?: string[];
  openspecDir?: string;
}): Promise<DigestResult> {
  const absRoot = resolve(opts.rootPath);
  const specsDir = join(absRoot, opts.openspecDir ?? OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);

  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    throw new Error(`No specs directory found at ${specsDir}. Run "openlore generate" first.`);
  }

  const domainFilter = opts.domains && opts.domains.length > 0
    ? new Set(opts.domains.map(d => d.toLowerCase()))
    : null;

  const domains: DigestDomain[] = [];

  for (const entry of entries.sort()) {
    if (domainFilter && !domainFilter.has(entry.toLowerCase())) continue;
    const specFile = join(specsDir, entry, 'spec.md');
    // A repo can COMMIT `openspec/specs/<domain>/spec.md -> ~/.ssh/id_rsa`, and this
    // command PRINTS what it reads — so an unconfined read here is a direct
    // exfiltration primitive, not just a boundary violation. The analyzer's spec
    // indexer and the MCP `get_spec` handler already drop escaping entries; digest
    // was the one reader that still followed them.
    if (!isConfinedPath(absRoot, specFile)) continue;
    let content: string;
    try {
      content = await readFile(specFile, 'utf-8');
    } catch {
      continue; // skip entries without a spec.md
    }
    domains.push(parseDomain(entry, content));
  }

  const totalRequirements = domains.reduce((n, d) => n + d.requirements.length, 0);
  const totalScenarios = domains.reduce(
    (n, d) => n + d.requirements.reduce((m, r) => m + r.scenarios.length, 0),
    0
  );

  return { domains, totalRequirements, totalScenarios };
}

// ============================================================================
// RENDERER
// ============================================================================

export function renderDigestMarkdown(result: DigestResult): string {
  const lines: string[] = [];

  lines.push('# Spec Digest');
  lines.push('');
  lines.push(`_${result.domains.length} domain${result.domains.length !== 1 ? 's' : ''} · ${result.totalRequirements} requirement${result.totalRequirements !== 1 ? 's' : ''} · ${result.totalScenarios} scenario${result.totalScenarios !== 1 ? 's' : ''}_`);
  lines.push('');
  lines.push('> Auto-generated by `openlore digest`. Source specs are unchanged.');
  lines.push('');

  for (const domain of result.domains) {
    lines.push(`## ${capitalize(domain.name)}`);
    if (domain.description) {
      lines.push('');
      lines.push(domain.description);
    }
    lines.push('');

    for (const req of domain.requirements) {
      if (req.scenarios.length === 0) continue;
      lines.push(`**${req.name}**`);
      lines.push('');
      for (const scenario of req.scenarios) {
        lines.push(`- **${scenario.name}**: ${scenario.summary}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
