/**
 * Stage 2: Entity Extraction
 *
 * Extracts core data models/entities from schema files.
 */

import logger from '../../../utils/logger.js';
import { STAGE2_MAX_TOKENS } from '../../../constants.js';
import { PROMPTS } from '../prompts.js';
import type { ExtractedEntity, StageResult, PipelineContext, ProjectSurveyResult } from '../../../types/pipeline.js';
import { astChunkContent } from '../../analyzer/ast-chunker.js';
import { STAGE2_ENTITY_SCHEMA } from '../schemas.js';
import { protectPrompt } from '../../../utils/prompt-boundary.js';

export async function runStage2(
  pipeline: PipelineContext,
  survey: ProjectSurveyResult,
  schemaFiles: Array<{ path: string; content: string }>,
  onFile?: (i: number, total: number, file: string) => void
): Promise<StageResult<ExtractedEntity[]>> {
  const startTime = Date.now();
  const systemPrompt = PROMPTS.stage2_entities;
  const allEntities: ExtractedEntity[] = [];
  const seenNames = new Set<string>();

  for (const [idx, file] of schemaFiles.entries()) {
    onFile?.(idx + 1, schemaFiles.length, file.path);
    const chunks = await astChunkContent(file.content, file.path, pipeline.options.chunkMaxChars);
    const isLargeFile = chunks.length > 1;
    const graphSection = pipeline.graphPromptFor(file.path, file.content);

    if (isLargeFile && !graphSection) {
      logger.warning(`Stage 2: ${file.path} too large (${chunks.length} parts) — entity spec may be incomplete`);
    }

    const entitiesFromFile: ExtractedEntity[] = [];

    // Use graph-based prompt for large files when call graph is available
    const fileChunks = graphSection ? [graphSection] : chunks;
    for (let i = 0; i < fileChunks.length; i++) {
      const chunkNote = !graphSection && isLargeFile ? ` (part ${i + 1}/${fileChunks.length})` : '';
      const schemaHint = pipeline.schemasFor(file.path);
      const schemaNote = schemaHint
        ? `\n\nKnown schema tables detected in this file (use these field names and types directly):\n${schemaHint}`
        : '';
      const userPrompt = `Project category: ${survey.projectCategory}\nFrameworks: ${survey.frameworks.join(', ')}\n\nFile: ${file.path}${chunkNote}\n${fileChunks[i]}${schemaNote}`;
      try {
        const result = await pipeline.llm.completeJSON<ExtractedEntity[]>({
          ...protectPrompt(systemPrompt, userPrompt),
          temperature: 0.3,
          maxTokens: STAGE2_MAX_TOKENS,
        }, STAGE2_ENTITY_SCHEMA);
        // Normalize: LLM may return a single object instead of an array
        const entities = Array.isArray(result) ? result : [result];
        for (const entity of entities) {
          if (!seenNames.has(entity.name)) {
            seenNames.add(entity.name);
            entity.location = file.path; // always use the actual file, not the LLM's guess
            entitiesFromFile.push(entity);
          }
        }
      } catch (error) {
        logger.warning(`Stage 2: failed to analyze ${file.path}${chunkNote}: ${(error as Error).message}`);
      }
    }
    if (isLargeFile && !graphSection) {
      for (const entity of entitiesFromFile) {
        entity.description = `${entity.description} *(analyzed in ${chunks.length} chunks)*`;
      }
    }
    allEntities.push(...entitiesFromFile);
  }

  const stageResult: StageResult<ExtractedEntity[]> = {
    stage: 'entities',
    success: true,
    data: allEntities,
    tokens: pipeline.llm.getTokenUsage().totalTokens,
    duration: Date.now() - startTime,
  };

  if (pipeline.options.saveIntermediate) {
    await pipeline.saveResult('stage2-entities', stageResult);
  }

  return stageResult;
}
