/**
 * Distractor-aware first-tool selection benchmark for arbitrary preset pairs.
 * The model selects; deterministic code scores the logged response.
 *
 * change: add-benchmark-harness-protocol
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TOOL_DEFINITIONS, selectActiveTools } from '../src/cli/commands/mcp.js';
import {
  validatePresetBenchmarkCorpus,
  type PresetBenchmarkCorpus,
  type PresetBenchmarkTask,
} from '../src/bench/preset-protocol.js';

interface ToolDef { name: string; description?: string }
interface Cell { correct: number; total: number; unparsed: number; tokenCost: number }

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function toolMenu(preset: string): { names: Set<string>; menu: string } {
  const tools = selectActiveTools(TOOL_DEFINITIONS as ToolDef[], { preset });
  return {
    names: new Set(tools.map((tool) => tool.name)),
    menu: tools
      .map((tool) => `- ${tool.name}: ${(tool.description ?? '').replace(/\s+/g, ' ').trim()}`)
      .join('\n'),
  };
}

function buildPrompt(menu: string, task: PresetBenchmarkTask): string {
  return [
    'You are an AI coding agent. Exactly these tools are available to you:',
    '',
    menu,
    '',
    `Task: ${task.prompt}`,
    '',
    'Which SINGLE tool would you call FIRST to make progress?',
    'Respond only with compact JSON: {"tool":"<exact tool name from the list>"}',
  ].join('\n');
}

function parseChoice(text: string): string | null {
  const object = text.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*\}/);
  if (object) return object[1].trim();
  const bare = text.trim().match(/^[`"']?([a-z_]+)[`"']?$/);
  return bare?.[1] ?? null;
}

function askClaude(prompt: string, model: string): { chosen: string | null; tokenCost: number } {
  let raw: string;
  try {
    raw = execFileSync('claude', ['-p', prompt, '--output-format', 'json', '--model', model], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 90_000,
    });
  } catch {
    return { chosen: null, tokenCost: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as {
      result?: string;
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
    };
    const usage = parsed.usage ?? {};
    return {
      chosen: parseChoice(parsed.result ?? ''),
      tokenCost:
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.output_tokens ?? 0),
    };
  } catch {
    return { chosen: parseChoice(raw), tokenCost: 0 };
  }
}

function pct(cell: Cell): string {
  return cell.total === 0 ? 'n/a' : `${Math.round((cell.correct / cell.total) * 100)}%`;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const json = process.argv.includes('--json');
  const presetA = arg('--preset-a', 'navigation');
  const presetB = arg('--preset-b', 'substrate');
  const model = arg('--model', 'sonnet');
  const corpusPath = resolve(arg('--corpus', 'bench/corpora/default-surface.json'));
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as PresetBenchmarkCorpus;
  const menus = { [presetA]: toolMenu(presetA), [presetB]: toolMenu(presetB) };
  const issues = validatePresetBenchmarkCorpus(
    corpus,
    new Set(TOOL_DEFINITIONS.map((tool) => tool.name)),
    Object.fromEntries(Object.entries(menus).map(([preset, menu]) => [preset, menu.names])),
  );
  if (issues.length > 0) {
    throw new Error(`Corpus validation failed before agent calls:\n${issues.map((issue) => `- ${issue.message}`).join('\n')}`);
  }

  const presets = [presetA, presetB];
  const score = Object.fromEntries(presets.map((preset) => [
    preset,
    { correct: 0, total: 0, unparsed: 0, tokenCost: 0 } satisfies Cell,
  ])) as Record<string, Cell>;
  const rows: Array<Record<string, unknown>> = [];

  for (const task of corpus.tasks) {
    const row: Record<string, unknown> = {
      id: task.id,
      class: task.class,
      expectedTools: task.expectedTools,
      distractors: task.distractors,
    };
    for (const preset of presets) {
      if (dryRun) {
        row[preset] = {
          dryRun: true,
          expectedInSurface: task.expectedTools.some((tool) => menus[preset].names.has(tool)),
          distractorsPresent: task.distractors.every((tool) => menus[preset].names.has(tool)),
        };
        continue;
      }
      const result = askClaude(buildPrompt(menus[preset].menu, task), model);
      const cell = score[preset];
      cell.total += 1;
      cell.tokenCost += result.tokenCost;
      if (result.chosen === null) cell.unparsed += 1;
      const correct = result.chosen !== null && task.expectedTools.includes(result.chosen);
      if (correct) cell.correct += 1;
      row[preset] = { chosen: result.chosen, correct, tokenCost: result.tokenCost };
    }
    rows.push(row);
  }

  const summary = {
    corpus: corpus.id,
    model,
    presets,
    score,
    accuracy: Object.fromEntries(presets.map((preset) => [preset, pct(score[preset])])),
    dryRun,
  };
  const payload = { rows, summary };
  if (!dryRun) {
    const directory = join(process.cwd(), '.openlore', 'bench');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `preset-selection-${model}.json`), JSON.stringify(payload, null, 2));
  }
  process.stdout.write(json || dryRun
    ? `${JSON.stringify(payload, null, 2)}\n`
    : `Selection accuracy (${model}): ${presets.map((preset) => `${preset}=${pct(score[preset])}`).join(', ')}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
