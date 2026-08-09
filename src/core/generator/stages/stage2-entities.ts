/**
 * Stage 2: Entity Extraction
 *
 * Extracts core data models/entities from schema files.
 */

import logger from '../../../utils/logger.js';
import { STAGE2_MAX_TOKENS } from '../../../constants.js';
import { PROMPTS } from '../prompts.js';
import type { ExtractedEntity, StageResult, PipelineContext, ProjectSurveyResult } from '../../../types/pipeline.js';
import { STAGE2_ENTITY_SCHEMA } from '../schemas.js';
import { protectPrompt } from '../../../utils/prompt-boundary.js';
import { partitionEvidenceFiles } from '../domain-evidence.js';

export async function runStage2(
  pipeline: PipelineContext,
  survey: ProjectSurveyResult,
  schemaFiles: Array<{ path: string; content: string }>,
  onFile?: (i: number, total: number, file: string) => void,
  domainForFile: (path: string) => string = () => 'undomained',
): Promise<StageResult<ExtractedEntity[]>> {
  const startTime = Date.now();
  const systemPrompt = PROMPTS.stage2_entities;
  const entitiesByName = new Map<string, ExtractedEntity>();

  const domains = new Map<string, Array<{ path: string; content: string }>>();
  for (const file of schemaFiles) {
    const domain = domainForFile(file.path);
    domains.set(domain, [...(domains.get(domain) ?? []), file]);
  }

  const work = [...domains.entries()].flatMap(([domain, files]) =>
    partitionEvidenceFiles(files, pipeline.options.chunkMaxChars).map((partition, index, all) => ({
      domain, files: partition, label: all.length > 1 ? `${domain} (${index + 1}/${all.length})` : domain,
    })),
  );
  for (const [idx, { domain, files, label }] of work.entries()) {
    onFile?.(idx + 1, work.length, label);
    const evidence = files.map(file => {
      const graphSection = pipeline.graphPromptFor(file.path, file.content);
      return `=== ${file.path} ===\n${graphSection ?? file.content}`;
    }).join('\n\n');
    const schemaHint = files.map(file => pipeline.schemasFor(file.path)).filter(Boolean).join('\n');
    const authoritativeSchemas = parseSchemaInventory(files, pipeline);

    const schemaNote = schemaHint
      ? `\n\nKnown schema tables detected in this domain (use these field names and types directly):\n${schemaHint}`
      : '';
    const userPrompt = `Project category: ${survey.projectCategory}\nFrameworks: ${survey.frameworks.join(', ')}\nDomain: ${domain}\n\n${evidence}${schemaNote}`;
      try {
        const result = await pipeline.llm.completeJSON<ExtractedEntity[]>({
          ...protectPrompt(systemPrompt, userPrompt),
          temperature: 0.3,
          maxTokens: STAGE2_MAX_TOKENS,
        }, STAGE2_ENTITY_SCHEMA);
        // Normalize: LLM may return a single object instead of an array
        const entities = Array.isArray(result) ? result : [result];
        for (const entity of entities) {
          const authoritative = authoritativeSchemas.get(entity.name);
          // When a deterministic inventory is present it defines identity,
          // location, and fields/types; the LLM supplies only semantic text.
          if (authoritativeSchemas.size > 0 && !authoritative) continue;
          const reconciled: ExtractedEntity = {
            ...entity,
            ...(authoritative ?? { location: files[0].path }),
          };
          const previous = entitiesByName.get(reconciled.name);
          entitiesByName.set(reconciled.name, previous
            ? { ...previous, ...reconciled, properties: reconciled.properties }
            : reconciled);
        }
      } catch (error) {
        logger.warning(`Stage 2: failed to analyze domain ${domain}: ${(error as Error).message}`);
      }
  }

  const stageResult: StageResult<ExtractedEntity[]> = {
    stage: 'entities',
    success: true,
    data: [...entitiesByName.values()],
    tokens: pipeline.llm.getTokenUsage().totalTokens,
    duration: Date.now() - startTime,
  };

  if (pipeline.options.saveIntermediate) {
    await pipeline.saveResult('stage2-entities', stageResult);
  }

  return stageResult;
}

function parseSchemaInventory(
  files: Array<{ path: string; content: string }>,
  pipeline: PipelineContext,
): Map<string, Pick<ExtractedEntity, 'location' | 'properties'>> {
  const inventory = new Map<string, Pick<ExtractedEntity, 'location' | 'properties'>>();
  for (const file of files) {
    for (const line of (pipeline.schemasFor(file.path) ?? '').split('\n')) {
      const match = /^-\s+(.+?)\s+\[[^\]]+\]:\s*(.*)$/.exec(line);
      if (!match) continue;
      const properties = [...match[2].matchAll(/([^,(]+)\s+\(([^,)]+)(,\s*required)?\)/g)]
        .map(field => ({ name: field[1].trim(), type: field[2].trim(), required: Boolean(field[3]) }));
      inventory.set(match[1].trim(), { location: file.path, properties });
    }
  }
  return inventory;
}
