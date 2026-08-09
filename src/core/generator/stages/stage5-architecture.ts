/**
 * Stage 5: Architecture Synthesis
 *
 * Synthesizes architecture overview from previous analysis results.
 */

import { STAGE5_MAX_TOKENS, STAGE5_HUB_FUNCTIONS_LIMIT, STAGE5_ENTRY_POINTS_LIMIT, STAGE5_VIOLATIONS_LIMIT, STAGE5_REFACTOR_PRIORITIES_LIMIT, STAGE5_CYCLES_LIMIT } from '../../../constants.js';
import { PROMPTS } from '../prompts.js';
import type {
  ArchitectureSynthesis,
  ExtractedEntity,
  ExtractedEndpoint,
  ExtractedService,
  PipelineContext,
  ProjectSurveyResult,
  StageResult,
} from '../../../types/pipeline.js';
import type { DependencyGraphResult } from '../../analyzer/dependency-graph.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import type { RefactorReport } from '../../analyzer/refactor-analyzer.js';
import { protectPrompt } from '../../../utils/prompt-boundary.js';

export async function runStage5(
  pipeline: PipelineContext,
  survey: ProjectSurveyResult,
  entities: ExtractedEntity[],
  services: ExtractedService[],
  endpoints: ExtractedEndpoint[],
  depGraph?: DependencyGraphResult,
  callGraph?: SerializedCallGraph,
  refactorReport?: RefactorReport
): Promise<StageResult<ArchitectureSynthesis>> {
  const startTime = Date.now();

  const userPrompt = `Synthesize the architecture from this analysis:

Project context: ${survey.domainSummary}
Architecture pattern: ${survey.architecturePattern}
Domains: ${survey.suggestedDomains.join(', ')}

Entities (${entities.length}):
${entities.map(e => `- ${e.name}: ${e.description}`).join('\n')}

Services (${services.length}):
${services.map(s => `- ${s.name}: ${s.purpose}`).join('\n')}

Endpoints (${endpoints.length}):
${endpoints.map(e => `- ${e.method} ${e.path}: ${e.purpose}`).join('\n')}

${depGraph ? `Dependency Graph:
- Nodes: ${depGraph.statistics.nodeCount}
- Edges: ${depGraph.statistics.edgeCount}
- Clusters: ${depGraph.statistics.clusterCount}
- Cycles: ${depGraph.statistics.cycleCount}` : ''}${callGraph && callGraph.stats.totalNodes > 0 ? `

Call Graph (static analysis — ${callGraph.stats.totalNodes} functions, ${callGraph.stats.totalEdges} internal calls):
${callGraph.hubFunctions.length > 0 ? `Hub functions (called by many others — likely integration points):
${callGraph.hubFunctions.slice(0, STAGE5_HUB_FUNCTIONS_LIMIT).map(n => `- ${n.name} (${n.filePath}, fanIn=${n.fanIn}, fanOut=${n.fanOut}${n.className ? `, class=${n.className}` : ''})`).join('\n')}` : ''}
${callGraph.entryPoints.length > 0 ? `\nEntry points (no internal callers — likely public API or CLI handlers):
${callGraph.entryPoints.slice(0, STAGE5_ENTRY_POINTS_LIMIT).map(n => `- ${n.name} (${n.filePath}${n.isAsync ? ', async' : ''})`).join('\n')}` : ''}
${callGraph.layerViolations.length > 0 ? `\nLayer violations detected:
${callGraph.layerViolations.slice(0, STAGE5_VIOLATIONS_LIMIT).map(v => `- ${v.reason}`).join('\n')}` : ''}` : ''}${refactorReport && refactorReport.stats.withIssues > 0 ? `

Structural Issues (${refactorReport.stats.totalFunctions} functions, ${refactorReport.stats.withIssues} with issues):
${[
  refactorReport.stats.unreachable > 0 ? `- ${refactorReport.stats.unreachable} unreachable (dead code candidates)` : '',
  refactorReport.stats.highFanOut > 0 ? `- ${refactorReport.stats.highFanOut} god functions (fanOut ≥ 8)` : '',
  refactorReport.stats.cyclesDetected > 0 ? `- ${refactorReport.stats.cyclesDetected} dependency cycles (${refactorReport.stats.cycleParticipants} participants)` : '',
  refactorReport.stats.srpViolations > 0 ? `- ${refactorReport.stats.srpViolations} SRP violations (multi-requirement functions)` : '',
].filter(Boolean).join('\n')}
${refactorReport.priorities.length > 0 ? `Top hotspots:
${refactorReport.priorities.slice(0, STAGE5_REFACTOR_PRIORITIES_LIMIT).map(e => `- ${e.function} (${e.file}): ${e.issues.join(', ')}`).join('\n')}` : ''}${refactorReport.cycles.length > 0 ? `
Dependency cycles:
${refactorReport.cycles.slice(0, STAGE5_CYCLES_LIMIT).map(c => `- [${c.size} functions] ${c.participants.slice(0, 4).map(p => p.function).join(' → ')}${c.size > 4 ? ` +${c.size - 4} more` : ''}`).join('\n')}` : ''}` : ''}`;

  try {
    const result = await pipeline.llm.completeJSON<ArchitectureSynthesis>({
      ...protectPrompt(PROMPTS.stage5_architecture, userPrompt),
      temperature: 0.3,
      maxTokens: STAGE5_MAX_TOKENS,
    });

    const stageResult: StageResult<ArchitectureSynthesis> = {
      stage: 'architecture',
      success: true,
      data: result,
      tokens: pipeline.llm.getTokenUsage().totalTokens,
      duration: Date.now() - startTime,
    };

    if (pipeline.options.saveIntermediate) {
      await pipeline.saveResult('stage5-architecture', stageResult);
    }

    return stageResult;
  } catch (error) {
    return {
      stage: 'architecture',
      success: false,
      error: (error as Error).message,
      tokens: 0,
      duration: Date.now() - startTime,
    };
  }
}
