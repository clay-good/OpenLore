import {
  TOOL_DEFINITIONS,
  selectActiveTools,
  toolAnnotations,
} from '../cli/commands/mcp.js';
import {
  buildToolListPayload,
  measureStandingContextTokens,
  serializeToolListPayload,
  STANDING_CONTEXT_TOKENIZER,
} from '../core/services/mcp-standing-cost.js';
import {
  CAPABILITY_FAMILIES,
  capabilityFamily,
  type CapabilityFamily,
} from '../core/services/mcp-handlers/tool-contract.js';

// change: add-benchmark-harness-protocol

export interface PresetSurfaceMeasurement {
  preset: string;
  toolCount: number;
  bytes: number;
  estimatedTokens: number;
  tokenizer: typeof STANDING_CONTEXT_TOKENIZER;
  families: CapabilityFamily[];
  toolIds: string[];
}

export function measurePresetSurface(preset: string): PresetSurfaceMeasurement {
  const tools = selectActiveTools(TOOL_DEFINITIONS, { preset });
  const payload = buildToolListPayload(tools, toolAnnotations);
  const families = new Set<CapabilityFamily>();
  for (const tool of tools) {
    const family = capabilityFamily(tool.name);
    if (family) families.add(family);
  }
  return {
    preset,
    toolCount: tools.length,
    bytes: Buffer.byteLength(serializeToolListPayload(payload), 'utf8'),
    estimatedTokens: measureStandingContextTokens(payload),
    tokenizer: STANDING_CONTEXT_TOKENIZER,
    families: CAPABILITY_FAMILIES.filter((family) => families.has(family)),
    toolIds: tools.map((tool) => tool.name),
  };
}

export function comparePresetSurfaces(presetA: string, presetB: string): {
  presetA: PresetSurfaceMeasurement;
  presetB: PresetSurfaceMeasurement;
  delta: { bytes: number; estimatedTokens: number; toolCount: number };
} {
  const a = measurePresetSurface(presetA);
  const b = measurePresetSurface(presetB);
  return {
    presetA: a,
    presetB: b,
    delta: {
      bytes: b.bytes - a.bytes,
      estimatedTokens: b.estimatedTokens - a.estimatedTokens,
      toolCount: b.toolCount - a.toolCount,
    },
  };
}
