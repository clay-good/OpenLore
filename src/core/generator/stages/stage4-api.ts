/**
 * Stage 4: API Extraction
 *
 * Extracts API endpoints from route/controller files.
 */

import logger from '../../../utils/logger.js';
import { STAGE4_MAX_TOKENS } from '../../../constants.js';
import { PROMPTS } from '../prompts.js';
import type { ExtractedEndpoint, StageResult, PipelineContext } from '../../../types/pipeline.js';
import { astChunkContent } from '../../analyzer/ast-chunker.js';
import { STAGE4_ENDPOINT_SCHEMA } from '../schemas.js';
import { protectPrompt } from '../../../utils/prompt-boundary.js';

export async function runStage4(
  pipeline: PipelineContext,
  apiFiles: Array<{ path: string; content: string }>,
  onFile?: (i: number, total: number, file: string) => void
): Promise<StageResult<ExtractedEndpoint[]>> {
  const startTime = Date.now();
  const allEndpoints: ExtractedEndpoint[] = [];
  const seenPaths = new Set<string>();

  for (const [idx, file] of apiFiles.entries()) {
    onFile?.(idx + 1, apiFiles.length, file.path);
    const chunks = await astChunkContent(file.content, file.path, pipeline.options.chunkMaxChars);
    const isLargeFile = chunks.length > 1;
    const graphSection = pipeline.graphPromptFor(file.path, file.content);

    if (isLargeFile && !graphSection) {
      logger.warning(`Stage 4: ${file.path} too large (${chunks.length} parts) — endpoint spec may be incomplete`);
    }

    const endpointsFromFile: ExtractedEndpoint[] = [];
    const fileChunks = graphSection ? [graphSection] : chunks;
    for (let i = 0; i < fileChunks.length; i++) {
      const chunkNote = !graphSection && isLargeFile ? ` (part ${i + 1}/${fileChunks.length})` : '';
      const routeHint = pipeline.routesFor(file.path);
      const routeNote = routeHint
        ? `\n\nKnown routes detected in this file (use these method/path values directly):\n${routeHint}`
        : '';
      const userPrompt = `File: ${file.path}${chunkNote}\n${fileChunks[i]}${routeNote}`;
      try {
        const result = await pipeline.llm.completeJSON<ExtractedEndpoint[]>({
          ...protectPrompt(PROMPTS.stage4_api, userPrompt),
          temperature: 0.3,
          maxTokens: STAGE4_MAX_TOKENS,
        }, STAGE4_ENDPOINT_SCHEMA);
        // Normalize: LLM may return a single object instead of an array
        const endpoints = Array.isArray(result) ? result : [result];
        for (const endpoint of endpoints) {
          const key = `${endpoint.method}:${endpoint.path}`;
          if (!seenPaths.has(key)) {
            seenPaths.add(key);
            endpointsFromFile.push(endpoint);
          }
        }
      } catch (error) {
        logger.warning(`Stage 4: failed to analyze ${file.path}${chunkNote}: ${(error as Error).message}`);
      }
    }
    if (isLargeFile && !graphSection) {
      for (const endpoint of endpointsFromFile) {
        endpoint.purpose = `${endpoint.purpose} *(analyzed in ${chunks.length} chunks)*`;
      }
    }
    allEndpoints.push(...endpointsFromFile);
  }

  const stageResult: StageResult<ExtractedEndpoint[]> = {
    stage: 'api',
    success: true,
    data: allEndpoints,
    tokens: pipeline.llm.getTokenUsage().totalTokens,
    duration: Date.now() - startTime,
  };

  if (pipeline.options.saveIntermediate) {
    await pipeline.saveResult('stage4-api', stageResult);
  }

  return stageResult;
}
