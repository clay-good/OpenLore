/**
 * Stage 4: API Extraction
 *
 * Extracts API endpoints from route/controller files.
 */

import logger from '../../../utils/logger.js';
import { STAGE4_MAX_TOKENS } from '../../../constants.js';
import { PROMPTS } from '../prompts.js';
import type { ExtractedEndpoint, StageResult, PipelineContext } from '../../../types/pipeline.js';
import { STAGE4_ENDPOINT_SCHEMA } from '../schemas.js';
import { protectPrompt } from '../../../utils/prompt-boundary.js';
import { partitionEvidenceFiles } from '../domain-evidence.js';

export async function runStage4(
  pipeline: PipelineContext,
  apiFiles: Array<{ path: string; content: string }>,
  onFile?: (i: number, total: number, file: string) => void,
  domainForFile: (path: string) => string = () => 'undomained',
): Promise<StageResult<ExtractedEndpoint[]>> {
  const startTime = Date.now();
  const allEndpoints: ExtractedEndpoint[] = [];
  const seenPaths = new Set<string>();

  const domains = new Map<string, Array<{ path: string; content: string }>>();
  for (const file of apiFiles) {
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
    const evidence = files.map(file => `=== ${file.path} ===\n${pipeline.graphPromptFor(file.path, file.content) ?? file.content}`).join('\n\n');
    const routeHint = files.map(file => pipeline.routesFor(file.path)).filter(Boolean).join('\n');
    const knownRoutes = new Set(
      routeHint.split('\n').flatMap(line => {
        const match = /^-\s+([A-Z]+)\s+(\S+)/.exec(line);
        return match ? [`${match[1]}:${match[2]}`] : [];
      }),
    );

    {
      const routeNote = routeHint
        ? `\n\nKnown routes detected in this file (use these method/path values directly):\n${routeHint}`
        : '';
      const userPrompt = `Domain: ${domain}\n${evidence}${routeNote}`;
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
          if (knownRoutes.has(key) && !seenPaths.has(key)) {
            seenPaths.add(key);
            allEndpoints.push(endpoint);
          }
        }
      } catch (error) {
        logger.warning(`Stage 4: failed to analyze domain ${domain}: ${(error as Error).message}`);
      }
    }
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
