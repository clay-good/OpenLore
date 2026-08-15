/**
 * `openlore mapping refresh` — rebuild the deterministic spec link index.
 *
 * Derives requirement→code links from the anchors written in the existing specs
 * plus the committed analysis, and persists them as `mapping.json`. No LLM, no
 * embeddings, no name similarity: the artifact is a rebuildable cache of an
 * observation (change `harden-spec-workflow-lifecycle`, decision 671084e7).
 *
 * Exit status is 0 for any honest index — including one full of unmapped
 * requirements, which is a finding, not a failure. It exits nonzero only when an
 * INPUT is unusable (no analysis, no specs) or when `--strict-ambiguity` was
 * explicitly requested and ambiguous anchors exist.
 */

import { Command } from 'commander';

import { writeStdout } from '../output.js';
import { OPENSPEC_DIR } from '../../constants.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { resolveSpecLinkIndex } from '../../core/generator/spec-link-service.js';
import type { SpecLinkIndex } from '../../core/generator/spec-link-index.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';

/** Ambiguous requirements listed in human output before the remainder is summarized. */
const MAX_LISTED_AMBIGUITIES = 10;

export function renderRefresh(
  index: SpecLinkIndex,
  artifactPath: string,
  source: 'cache' | 'derived',
  cacheReason?: string,
): string {
  const { stats } = index;
  const lines = [
    `Spec link index (${source === 'cache' ? 'already current' : 'rebuilt'})`,
    `  requirements:  ${stats.totalRequirements}`,
    `  linked:        ${stats.linked}`,
    `  ambiguous:     ${stats.ambiguous}`,
    `  unmapped:      ${stats.unmapped}`,
    `  stale:         ${stats.stale}`,
    `  covered:       ${stats.coveredFunctions}/${stats.totalExportedFunctions} exported symbols`,
  ];

  if (cacheReason === 'incompatible-provenance') {
    lines.push('', '  Legacy mapping cache was incompatible and was rebuilt from current specs and analysis.');
  }

  const ambiguous = index.links.filter(link => link.state === 'ambiguous');
  if (ambiguous.length > 0) {
    lines.push('', '  Ambiguous anchors (no candidate was selected):');
    for (const link of ambiguous.slice(0, MAX_LISTED_AMBIGUITIES)) {
      for (const anchor of link.anchors.filter(a => a.state === 'ambiguous')) {
        const shown = anchor.candidates.map(c => `${c.file}:${c.line}`).join(', ');
        const more = anchor.candidateTotal > anchor.candidates.length
          ? ` (+${anchor.candidateTotal - anchor.candidates.length} more)` : '';
        lines.push(`    [${safe(link.domain)}] ${safe(link.requirement)} → \`${safe(anchor.raw)}\`: ${safe(shown)}${more}`);
      }
    }
    if (ambiguous.length > MAX_LISTED_AMBIGUITIES) {
      lines.push(`    … and ${ambiguous.length - MAX_LISTED_AMBIGUITIES} more ambiguous requirements`);
      lines.push('    Disambiguate by writing `symbol::path/to/file.ts` in the requirement anchor,');
      lines.push('    or read the full set from the JSON output: `openlore mapping refresh --json`.');
    }
  }

  const unmapped = index.links.filter(link => link.state === 'unmapped');
  if (unmapped.length > 0) {
    lines.push('', '  Requirements without an exact implementation anchor:');
    for (const link of unmapped.slice(0, MAX_LISTED_AMBIGUITIES)) {
      lines.push(`    [${safe(link.domain)}] ${safe(link.requirement)}`);
    }
    if (unmapped.length > MAX_LISTED_AMBIGUITIES) {
      lines.push(`    … and ${unmapped.length - MAX_LISTED_AMBIGUITIES} more unmapped requirements`);
    }
    lines.push('    Legacy `> Source files:` headers provide domain footprint only. Add a per-requirement');
    lines.push('    - **Implementation**: `symbol::path/to/file.ts` anchor, then refresh again.');
  }

  const stale = index.links.filter(link => link.state === 'stale');
  if (stale.length > 0) {
    lines.push('', '  Stale implementation anchors:');
    for (const link of stale.slice(0, MAX_LISTED_AMBIGUITIES)) {
      const raw = link.anchors.filter(anchor => anchor.state === 'stale').map(anchor => `\`${safe(anchor.raw)}\``).join(', ');
      lines.push(`    [${safe(link.domain)}] ${safe(link.requirement)} → ${raw}`);
    }
    if (stale.length > MAX_LISTED_AMBIGUITIES) {
      lines.push(`    … and ${stale.length - MAX_LISTED_AMBIGUITIES} more stale requirements`);
    }
    lines.push('    Replace each stale anchor with the current exact `symbol::path`, or remove it if the');
    lines.push('    requirement no longer has an implementation. No candidate is selected automatically.');
  }

  lines.push('', `  Written to: ${artifactPath}`);
  return lines.join('\n');
}

const refreshCommand = new Command('refresh')
  .description('Rebuild the deterministic spec link index from existing specs and the current analysis (no LLM)')
  .argument('[directory]', 'Project directory', '.')
  .option('--json', 'Output the full link index as JSON')
  .option('--strict-ambiguity', 'Exit nonzero when any requirement anchor is ambiguous', false)
  .action(async (directory: string, opts: { json?: boolean; strictAmbiguity?: boolean }) => {
    const rootPath = directory === '.' ? process.cwd() : directory;
    const config = await readOpenLoreConfig(rootPath).catch(() => null);

    const resolution = await resolveSpecLinkIndex({
      rootPath,
      openspecPath: config?.openspecPath ?? OPENSPEC_DIR,
      persist: true,
    });

    if (resolution.state === 'unavailable') {
      if (opts.json) {
        await writeStdout(JSON.stringify(resolution, null, 2) + '\n');
      } else {
        console.error(`mapping refresh failed: ${resolution.message}`);
        console.error(`  → ${resolution.remediation}`);
      }
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      await writeStdout(JSON.stringify(resolution.index, null, 2) + '\n');
    } else {
      console.log(renderRefresh(resolution.index, resolution.artifactPath, resolution.source, resolution.cacheReason));
    }

    // An honest index still exits 0; ambiguity is only fatal when asked for.
    if (opts.strictAmbiguity && resolution.index.stats.ambiguous > 0) {
      if (!opts.json) {
        console.error(`\n${resolution.index.stats.ambiguous} ambiguous requirement anchor(s) — failing due to --strict-ambiguity.`);
      }
      process.exitCode = 1;
    }
  });

export const mappingCommand = new Command('mapping')
  .description('Inspect and rebuild the deterministic spec-to-code link index')
  .addCommand(refreshCommand);
