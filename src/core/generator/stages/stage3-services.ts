/**
 * Stage 3: Service Analysis
 *
 * Extracts services/modules from business logic files.
 */

import logger from '../../../utils/logger.js';
import { STAGE3_MAX_TOKENS } from '../../../constants.js';
import { PROMPTS } from '../prompts.js';
import type { ExtractedEntity, ExtractedService, StageResult, PipelineContext, ProjectSurveyResult } from '../../../types/pipeline.js';
import { STAGE3_SERVICE_SCHEMA } from '../schemas.js';
import { protectPrompt } from '../../../utils/prompt-boundary.js';
import { partitionEvidenceFiles } from '../domain-evidence.js';

/**
 * Reconcile an LLM-returned function name with the names the signatures actually
 * expose, across the qualified/bare boundary.
 *
 * `Class.method` and `method` name the same function; which form appears depends
 * on the language and on how the model echoed it back. Dropping the mismatched
 * form loses the anchor for the whole operation, so both directions are resolved
 * — but only when the answer is UNIQUE. A bare name matching several qualified
 * candidates stays unresolved rather than being attributed to an arbitrary class.
 *
 * Exported for tests: this is the join that decides whether a requirement gets an
 * implementation anchor at all.
 */
export function resolveAvailableFunction(name: string, available: ReadonlySet<string>): string | undefined {
  if (available.has(name)) return name;

  // `Class.method` returned, only `method` extracted from the signature line.
  const bare = name.slice(name.lastIndexOf('.') + 1);
  if (bare !== name && available.has(bare)) return bare;

  // `method` returned, the signature carries the qualified `Class.method`.
  const qualified = [...available].filter(candidate => candidate.endsWith(`.${name}`));
  return qualified.length === 1 ? qualified[0] : undefined;
}

export async function runStage3(
  pipeline: PipelineContext,
  survey: ProjectSurveyResult,
  entities: ExtractedEntity[],
  serviceFiles: Array<{ path: string; content: string }>,
  onFile?: (i: number, total: number, file: string) => void,
  domainForFile: (path: string) => string = () => 'undomained',
): Promise<StageResult<ExtractedService[]>> {
  const startTime = Date.now();
  const entityNames = entities.map(e => e.name);
  const systemPrompt = PROMPTS.stage3_services;
  const servicesByIdentity = new Map<string, ExtractedService>();

  const domains = new Map<string, Array<{ path: string; content: string }>>();
  for (const file of serviceFiles) {
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
    const graphSection = files.map(candidate => `=== ${candidate.path} ===\n${pipeline.graphPromptFor(candidate.path, candidate.content) ?? candidate.content}`).join('\n\n');

    const servicesFromFile: ExtractedService[] = [];
    {
      const signaturesSection = files.map(candidate => pipeline.signaturesFor(candidate.path)).filter(Boolean).join('\n');
      // `\w` excludes `.`, so a bare-identifier pattern registers only `method` for
      // a `Class.method(...)` signature. The qualified form is exactly what an OO
      // codebase's graph uses (and what the LLM tends to echo back), so both forms
      // are captured and reconciled below rather than silently dropped.
      const availableFunctions = new Set(
        signaturesSection.split('\n').flatMap(line =>
          [...line.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)].map(match => match[1])),
      );
      const signaturesNote = signaturesSection
        ? `\n\nFunctions available in this file:\n${signaturesSection}\n\nFor each operation you extract, set functionName to exactly match one of the above.`
        : '';
      const userPrompt = `Project category: ${survey.projectCategory}\nKnown entities: ${entityNames.join(', ')}\nAvailable domains: ${(survey.suggestedDomains ?? []).join(', ')}\n\nDomain: ${domain}\n${graphSection}${signaturesNote}`;
      try {
        const result = await pipeline.llm.completeJSON<ExtractedService[]>({
          ...protectPrompt(systemPrompt, userPrompt),
          temperature: 0.3,
          maxTokens: STAGE3_MAX_TOKENS,
        }, STAGE3_SERVICE_SCHEMA);
        // Normalize: LLM may return a single object instead of an array
        const services = Array.isArray(result) ? result : [result];
        for (const service of services) {
          service.domain = domain;
          for (const operation of service.operations ?? []) {
            if (operation.functionName) {
              operation.functionName = resolveAvailableFunction(operation.functionName, availableFunctions);
            }
          }
          servicesFromFile.push(service);
        }
      } catch (error) {
        logger.warning(`Stage 3: failed to analyze domain ${domain}: ${(error as Error).message}`);
      }
    }

    for (const service of servicesFromFile) {
      const operationNames = new Set((service.operations ?? []).map(operation => operation.functionName).filter(Boolean));
      service.locationFile = files.find(candidate => {
        const signatures = pipeline.signaturesFor(candidate.path) ?? '';
        return [...operationNames].some(name => signatures.includes(name!));
      })?.path ?? files[0].path;
    }

    // For god-function files analyzed via graph, generate hierarchical sub-specs
    // from the reconciled service's actual source file rather than the first
    // arbitrary file in the domain partition.
    if (servicesFromFile.length > 0) {
      for (const service of servicesFromFile) {
        const subSpecs = await pipeline.generateSubSpecs(service.locationFile!, service.name, service.purpose);
        if (subSpecs.length > 0) {
          service.subSpecs = subSpecs;
        }
      }
    }
    for (const service of servicesFromFile) {
      const identity = `${service.domain}::${service.name}`;
      const previous = servicesByIdentity.get(identity);
      if (!previous) {
        servicesByIdentity.set(identity, service);
        continue;
      }
      const operations = new Map((previous.operations ?? []).map(operation => [operation.functionName ?? operation.name, operation]));
      for (const operation of service.operations ?? []) operations.set(operation.functionName ?? operation.name, operation);
      servicesByIdentity.set(identity, { ...previous, ...service, operations: [...operations.values()] });
    }
  }

  const stageResult: StageResult<ExtractedService[]> = {
    stage: 'services',
    success: true,
    data: [...servicesByIdentity.values()],
    tokens: pipeline.llm.getTokenUsage().totalTokens,
    duration: Date.now() - startTime,
  };

  if (pipeline.options.saveIntermediate) {
    await pipeline.saveResult('stage3-services', stageResult);
  }

  return stageResult;
}
