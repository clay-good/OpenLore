/**
 * Stage 6: ADR Enrichment
 *
 * Expands architectural decisions into full ADRs.
 */

import { STAGE6_MAX_TOKENS } from '../../../constants.js';
import { PROMPTS } from '../prompts.js';
import type { ArchitectureSynthesis, EnrichedADR, PipelineContext, StageResult } from '../../../types/pipeline.js';
import { STAGE6_ADR_SCHEMA } from '../schemas.js';
import { protectPrompt } from '../../../utils/prompt-boundary.js';

export async function runStage6(
  pipeline: PipelineContext,
  architecture: ArchitectureSynthesis
): Promise<StageResult<EnrichedADR[]>> {
  const startTime = Date.now();

  const userPrompt = `Architecture context:
- System purpose: ${architecture.systemPurpose}
- Architecture style: ${architecture.architectureStyle}
- Layers: ${architecture.layerMap.map(l => `${l.name} (${l.purpose})`).join(', ')}
- Data flow: ${architecture.dataFlow}
- Security model: ${architecture.securityModel}
- External integrations: ${architecture.integrations.join(', ') || 'None'}

Expand these ${architecture.keyDecisions.length} architectural decisions into full ADRs:

${architecture.keyDecisions.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;

  try {
    const result = await pipeline.llm.completeJSON<EnrichedADR[]>({
      ...protectPrompt(PROMPTS.stage6_adr, userPrompt),
      temperature: 0.3,
      maxTokens: STAGE6_MAX_TOKENS,
    }, STAGE6_ADR_SCHEMA);

    // Normalize: completeJSON may return a single object if the LLM ignores the
    // array instruction (observed with GPT-5.2-chat — see issue #26). Wrap it
    // so downstream consumers always receive an array.
    const adrs = Array.isArray(result) ? result : [result];

    const stageResult: StageResult<EnrichedADR[]> = {
      stage: 'adr',
      success: true,
      data: adrs,
      tokens: pipeline.llm.getTokenUsage().totalTokens,
      duration: Date.now() - startTime,
    };

    if (pipeline.options.saveIntermediate) {
      await pipeline.saveResult('stage6-adr-enrichment', stageResult);
    }

    return stageResult;
  } catch (error) {
    return {
      stage: 'adr',
      success: false,
      error: (error as Error).message,
      tokens: 0,
      duration: Date.now() - startTime,
    };
  }
}
