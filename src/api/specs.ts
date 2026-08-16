/**
 * openlore API: spec requirements extractor
 *
 * Reads `.openlore/analysis/mapping.json` and extracts the exact requirement
 * blocks from the spec files referenced by each mapping entry.
 *
 * The function returns a mapping from the mapping.requirement key to a
 * structured object:
 *
 * {
 *   title: string,       // requirement heading as found in the file
 *   body: string,        // markdown body of the requirement (everything after the heading)
 *   specFile?: string,   // spec file path exactly as referenced in mapping.json
 *   domain?: string,     // domain from mapping
 *   service?: string     // service from mapping
 * }
 *
 * Behavior:
 * - For each mapping entry we read the referenced spec file (exact path).
 * - We attempt a deterministic (case-insensitive) equality match of the
 *   requirement heading (the text right after "### Requirement:").
 * - If found, we return the extracted body. If not found or the file cannot
 *   be read, an empty body string is returned (the caller can interpret this
 *   as "not available").
 *
 * This API intentionally avoids fuzzy heuristics — it uses the exact specFile
 * path coming from mapping.json and only performs case-insensitive title
 * equality checks.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_MAPPING } from '../constants.js';
import { fileExists } from '../utils/command-helpers.js';
import { safeJoin } from '../utils/path-confinement.js';
import type { BaseOptions } from './types.js';

export type SpecRequirement = {
  title: string;
  body: string;
  specFile?: string;
  domain?: string;
  service?: string;
};

/**
 * Read spec requirements referenced in mapping.json.
 *
 * @param options.rootPath project root (default: process.cwd())
 * @returns an object keyed by mapping.requirement with SpecRequirement values
 */
export async function openloreGetSpecRequirements(options: BaseOptions = {}): Promise<{
  generatedAt?: string;
  requirements: Record<string, SpecRequirement>;
}> {
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const result: Record<string, SpecRequirement> = Object.create(null);
  let generatedAt: string | undefined = undefined;
  let mappingPath: string;
  try {
    mappingPath = safeJoin(rootPath, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_MAPPING));
  } catch {
    return { generatedAt, requirements: result };
  }

  if (!(await fileExists(mappingPath))) {
    // No mapping available; return empty map
    return { generatedAt, requirements: result };
  }

  try {
    const mappingContent = await readFile(mappingPath, 'utf-8');
    const mappingJson = JSON.parse(mappingContent);
    generatedAt = mappingJson?.generatedAt;

    const mappings = mappingJson?.mappings || [];
    for (const m of mappings) {
      // Use the mapping.requirement as the canonical key
      const reqKey: unknown = m.requirement;
      if (typeof reqKey !== 'string' || !reqKey) continue;
      // If we've already loaded this requirement, skip (first-wins)
      if (Object.prototype.hasOwnProperty.call(result, reqKey)) continue;

      const specFileRel: unknown = m.specFile;
      if (typeof specFileRel !== 'string' || !specFileRel) {
        // No spec file recorded — create placeholder
        result[reqKey] = {
          title: reqKey,
          body: '',
          domain: m.domain,
          service: m.service,
        };
        continue;
      }

      let specFileAbs: string;
      try {
        specFileAbs = safeJoin(rootPath, specFileRel);
      } catch {
        result[reqKey] = {
          title: reqKey,
          body: '',
          specFile: specFileRel,
          domain: m.domain,
          service: m.service,
        };
        continue;
      }
      if (!(await fileExists(specFileAbs))) {
        result[reqKey] = {
          title: reqKey,
          body: '',
          specFile: specFileRel,
          domain: m.domain,
          service: m.service,
        };
        continue;
      }

      try {
        const content = await readFile(specFileAbs, 'utf-8');

        // Split into "### Requirement:" sections and search for exact (case-insensitive) title match
        const sections = content.split(/^###\s+Requirement:\s*/m);
        let found = false;
        for (let i = 1; i < sections.length; i++) {
          const lines = sections[i].split('\n');
          const rawTitle = lines[0].trim();
          if (!rawTitle) continue;
          if (rawTitle.toLowerCase() === reqKey.toLowerCase()) {
            const body = lines.slice(1).join('\n').trim();
            result[reqKey] = {
              title: rawTitle,
              body,
              specFile: specFileRel,
              domain: m.domain,
              service: m.service,
            };
            found = true;
            break;
          }
        }

        if (!found) {
          // Requirement heading not found in the referenced file — return placeholder
          result[reqKey] = {
            title: reqKey,
            body: '',
            specFile: specFileRel,
            domain: m.domain,
            service: m.service,
          };
        }
      } catch {
        // On read/parse error, store a placeholder so the caller knows we attempted to load it
        result[reqKey] = {
          title: reqKey,
          body: '',
          specFile: specFileRel,
          domain: m.domain,
          service: m.service,
        };
      }
    }
  } catch {
    // If mapping.json cannot be read/parsed, return empty set
    return { generatedAt, requirements: result };
  }

  return { generatedAt, requirements: result };
}

export default openloreGetSpecRequirements;
