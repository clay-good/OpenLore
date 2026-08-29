import { analyzeAgentTranscript, parseAgentOutput } from './transcript-metrics.js';

// change: add-benchmark-harness-protocol

export type BenchmarkRepoTier = 'small-familiar' | 'large-unfamiliar';

export interface PresetBenchmarkTask {
  id: string;
  class: 'shared' | 'governance';
  prompt: string;
  expectedTools: string[];
  distractors: string[];
}

export interface PresetBenchmarkCorpus {
  schemaVersion: 1;
  id: string;
  environment: {
    image: string;
    digest: string;
  };
  agentConfig: {
    models: string[];
    runs: number;
  };
  repoTiers: BenchmarkRepoTier[];
  tasks: PresetBenchmarkTask[];
}

export interface CorpusValidationIssue {
  code: 'invalid-corpus' | 'stale-tool-id' | 'missing-distractor';
  message: string;
  taskId?: string;
  preset?: string;
  toolId?: string;
}

export interface TrajectoryScore {
  selectedTool: string | null;
  selectionCorrect: boolean;
  steps: number;
  tokenCost: number;
  costUsd: number;
  reread: ReturnType<typeof analyzeAgentTranscript>;
}

export interface SelectionScore {
  selectedTool: string | null;
  selectionCorrect: boolean;
  tokenCost: number;
}

const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validatePresetBenchmarkCorpus(
  corpus: PresetBenchmarkCorpus,
  knownToolIds: ReadonlySet<string>,
  surfaces: Readonly<Record<string, ReadonlySet<string>>>,
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  const invalid = (message: string): void => {
    issues.push({ code: 'invalid-corpus', message });
  };

  if (corpus.schemaVersion !== 1) invalid(`Unsupported corpus schemaVersion: ${String(corpus.schemaVersion)}.`);
  if (!corpus.id?.trim()) invalid('Corpus id must not be empty.');
  if (!corpus.environment?.image?.trim()) invalid('Corpus environment image must not be empty.');
  if (!IMAGE_DIGEST.test(corpus.environment?.digest ?? '')) {
    invalid('Corpus environment digest must be an immutable sha256 digest.');
  }
  if (corpus.agentConfig.models.length < 2) invalid('Corpus must declare at least two models.');
  if (new Set(corpus.agentConfig.models).size < 2) invalid('Corpus must declare at least two distinct models.');
  if (!Number.isSafeInteger(corpus.agentConfig.runs) || corpus.agentConfig.runs < 1) {
    invalid('Corpus agentConfig.runs must be a positive integer.');
  }
  for (const tier of ['small-familiar', 'large-unfamiliar'] as const) {
    if (!corpus.repoTiers.includes(tier)) invalid(`Corpus must include repo tier "${tier}".`);
  }

  const seenTaskIds = new Set<string>();
  for (const task of corpus.tasks) {
    if (!task.id.trim()) invalid('Task id must not be empty.');
    if (seenTaskIds.has(task.id)) invalid(`Duplicate task id: "${task.id}".`);
    seenTaskIds.add(task.id);
    if (task.expectedTools.length === 0) invalid(`Task "${task.id}" must declare an expected tool.`);
    if (task.distractors.length === 0) invalid(`Task "${task.id}" must declare at least one distractor.`);

    for (const toolId of [...task.expectedTools, ...task.distractors]) {
      if (!knownToolIds.has(toolId)) {
        issues.push({
          code: 'stale-tool-id',
          taskId: task.id,
          toolId,
          message: `Task "${task.id}" references unknown tool id "${toolId}".`,
        });
      }
    }

    for (const [preset, tools] of Object.entries(surfaces)) {
      for (const distractor of task.distractors) {
        if (knownToolIds.has(distractor) && !tools.has(distractor)) {
          issues.push({
            code: 'missing-distractor',
            taskId: task.id,
            preset,
            toolId: distractor,
            message: `Task "${task.id}" requires distractor "${distractor}", but preset "${preset}" does not expose it.`,
          });
        }
      }
    }
  }

  return issues;
}

function normalizeToolName(name: string): string {
  const marker = '__openlore__';
  const markerIndex = name.indexOf(marker);
  return markerIndex >= 0 ? name.slice(markerIndex + marker.length) : name;
}

function parseSelectionChoice(text: string): string | null {
  const object = text.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*\}/);
  if (object) return object[1].trim();
  const bare = text.trim().match(/^[`"']?([a-z_]+)[`"']?$/);
  return bare?.[1] ?? null;
}

/** Deterministically score one logged first-tool selection response. */
export function scoreSelectionResponse(task: PresetBenchmarkTask, rawResponse: string): SelectionScore {
  try {
    const parsed = JSON.parse(rawResponse) as {
      result?: string;
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
    };
    const usage = parsed.usage ?? {};
    const selectedTool = parseSelectionChoice(parsed.result ?? '');
    return {
      selectedTool,
      selectionCorrect: selectedTool !== null && task.expectedTools.includes(selectedTool),
      tokenCost:
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.output_tokens ?? 0),
    };
  } catch {
    const selectedTool = parseSelectionChoice(rawResponse);
    return {
      selectedTool,
      selectionCorrect: selectedTool !== null && task.expectedTools.includes(selectedTool),
      tokenCost: 0,
    };
  }
}

/** Deterministically score one logged agent trajectory. No model is called here. */
export function scorePresetTrajectory(task: PresetBenchmarkTask, rawTranscript: string): TrajectoryScore {
  const { transcript, result } = parseAgentOutput(rawTranscript);
  const selectedTool = transcript.toolUses[0]?.name
    ? normalizeToolName(transcript.toolUses[0].name)
    : null;
  return {
    selectedTool,
    selectionCorrect: selectedTool !== null && task.expectedTools.includes(selectedTool),
    steps: transcript.toolUses.length,
    tokenCost: result
      ? result.freshInputTokens + result.cacheReadTokens + result.outputTokens
      : 0,
    costUsd: result?.costUsd ?? 0,
    reread: analyzeAgentTranscript(transcript),
  };
}
