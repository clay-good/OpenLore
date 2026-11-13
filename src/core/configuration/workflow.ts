import { redactSecrets } from '../services/secret-redaction.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  confinedAtomicWriteFile,
  readFileConfinedWithStat,
  recoverConfinedAtomicWriteFile,
} from '../../utils/path-confinement.js';
import { isGuardedWriteFailure, withGuardedConfigWrite } from '../runtime/guarded-config-write.js';
import {
  CONFIG_SCHEMA_VERSION,
  isFatalConfigFinding,
  validateOpenLoreConfig,
} from '../services/config-schema.js';
import { DEFAULT_MAX_FILES, CONFIGURATION_CANARY_TIMEOUT_MS } from '../../constants.js';
import { observeConfiguration } from './observe.js';
import { inspectConfiguration, readConfiguration } from './inspect.js';
import {
  canonicalConfiguration,
  configurationDigest,
  FilePolicyResolver,
  validPolicyPattern,
  validateFilePolicies,
} from './policy.js';
import type {
  ConfigurationCandidate,
  ConfigurationOptions,
  ConfigurationPatch,
  ConfigurationPlan,
  ConfigurationReceipt,
  FilePolicyRule,
} from './types.js';

const equal = (a: unknown, b: unknown) => canonicalConfiguration(a) === canonicalConfiguration(b);
const object = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
function validateCandidate(value: ConfigurationCandidate): void {
  if (
    !value ||
    Buffer.byteLength(JSON.stringify(value)) > 128 * 1024 ||
    Object.keys(value).some((k) => !['rules', 'reviewMode', 'analysis'].includes(k))
  )
    throw new Error('Unsupported configuration candidate');
  const errors = validateFilePolicies({ rules: value.rules });
  if (value.reviewMode !== undefined && !['manual', 'notify'].includes(value.reviewMode))
    errors.push('Invalid review mode');
  if (value.analysis !== undefined) {
    if (
      Object.keys(object(value.analysis)).some(
        (k) => !['includePatterns', 'excludePatterns'].includes(k)
      )
    )
      errors.push('Unsupported analysis change');
    for (const patterns of Object.values(object(value.analysis)))
      if (
        !Array.isArray(patterns) ||
        patterns.length > 100 ||
        patterns.some((p) => !validPolicyPattern(p))
      )
        errors.push('Invalid bounded analysis patterns');
  }
  if (errors.length) throw new Error(errors.join('; '));
}
function planId(plan: Omit<ConfigurationPlan, 'id'> | ConfigurationPlan): string {
  const body = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'id'));
  return configurationDigest(body);
}
function receipt(
  plan: ConfigurationPlan,
  outcome: ConfigurationReceipt['outcome'],
  reason?: string
): ConfigurationReceipt {
  return {
    version: 1,
    planId: plan.id,
    outcome,
    configPublished: false,
    disclosures: [],
    ...(reason ? { reason } : {}),
  };
}
function selected(value: unknown, template: unknown): unknown {
  if (!template || typeof template !== 'object' || Array.isArray(template)) return value;
  const source = object(value);
  return Object.fromEntries(
    Object.keys(object(template))
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]])
  );
}
function patchMatches(
  patch: ConfigurationPatch,
  raw: Record<string, unknown>,
  side: 'before' | 'after' = 'after'
): boolean {
  const expected = patch[side];
  return equal(
    patch.field === 'analysis' || patch.field === 'configurationAssistant'
      ? selected(raw[patch.field], patch.after)
      : raw[patch.field],
    expected
  );
}
function publishPatch(
  raw: Record<string, unknown>,
  patch: ConfigurationPatch,
  inverse = false
): void {
  const value = inverse ? patch.before : patch.after;
  if (patch.field === 'analysis' || patch.field === 'configurationAssistant') {
    const next = { ...object(raw[patch.field]) };
    for (const key of Object.keys(object(patch.after))) {
      if (Object.hasOwn(object(value), key)) next[key] = object(value)[key];
      else delete next[key];
    }
    if (Object.keys(next).length) raw[patch.field] = next;
    else delete raw[patch.field];
  } else if (value === undefined) delete raw[patch.field];
  else raw[patch.field] = value;
}
function hasAuthority(
  options: ConfigurationOptions,
  plan: ConfigurationPlan,
  permission: 'write-config' | 'replace-choices' | 'runtime' | 'probe'
): boolean {
  return (
    options.authority?.root === plan.root &&
    options.authority.planId === plan.id &&
    options.authority.permissions.includes(permission)
  );
}
export async function previewConfiguration(
  candidate: ConfigurationCandidate,
  options: ConfigurationOptions = {}
): Promise<ConfigurationPlan> {
  return preview(candidate, options, new Date().toISOString());
}
async function preview(
  candidate: ConfigurationCandidate,
  options: ConfigurationOptions,
  createdAt: string
): Promise<ConfigurationPlan> {
  validateCandidate(candidate);
  const config = await readConfiguration(options);
  const inspection = await inspectConfiguration(options);
  const patches: ConfigurationPatch[] = [];
  // Bootstrap only canonical local fields; inherited credentials and providers are never copied.
  if (!config.identity)
    for (const [field, after] of Object.entries({
      version: CONFIG_SCHEMA_VERSION,
      projectType: 'unknown',
      openspecPath: 'openspec',
      analysis: { maxFiles: DEFAULT_MAX_FILES, includePatterns: [], excludePatterns: [] },
      generation: { domains: 'auto' },
      createdAt,
      lastRun: null,
    })) {
      patches.push({ field: field as ConfigurationPatch['field'], before: undefined, after });
    }
  const raw = { ...config.raw, ...Object.fromEntries(patches.map((p) => [p.field, p.after])) };
  const fields: Record<string, unknown> = {
    filePolicies: { ...object(raw.filePolicies), rules: candidate.rules },
  };
  if (candidate.reviewMode !== undefined)
    fields.configurationAssistant = { reviewMode: candidate.reviewMode };
  if (candidate.analysis) fields.analysis = { ...candidate.analysis };
  for (const [field, after] of Object.entries(fields))
    if (!equal(raw[field], after)) {
      const existing = patches.find((p) => p.field === field);
      if (existing)
        existing.after =
          field === 'analysis' ? { ...object(existing.after), ...object(after) } : after;
      else
        patches.push({
          field: field as ConfigurationPatch['field'],
          before:
            field === 'analysis' || field === 'configurationAssistant'
              ? selected(raw[field], after)
              : raw[field],
          after,
        });
    }
  const conflicts: string[] = [];
  const existing =
    (config.effective.filePolicies as { rules?: FilePolicyRule[] } | undefined)?.rules ?? [];
  for (const rule of existing)
    if (!candidate.rules.some((r) => equal(r, rule)))
      conflicts.push('Replace existing rule ' + rule.id);
  if (
    candidate.analysis &&
    !equal(
      candidate.analysis,
      Object.fromEntries(
        Object.keys(candidate.analysis).map((k) => [k, object(config.effective.analysis)[k]])
      )
    )
  )
    conflicts.push('Replace explicit analysis selection');
  const resolver = new FilePolicyResolver(
    { rules: candidate.rules },
    options.protectedExcludePatterns
  );
  const body: Omit<ConfigurationPlan, 'id'> = {
    version: 1,
    root: config.root,
    configPath: config.configPath,
    configRevision: config.revision,
    evidenceRevision: inspection.evidenceRevision,
    policyRevision: resolver.revision,
    createdAt,
    inspection: {
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
      ...(options.continuation ? { continuation: options.continuation } : {}),
    },
    candidate: JSON.parse(JSON.stringify(candidate)) as ConfigurationCandidate,
    patches,
    conflicts,
    examples: Object.fromEntries(
      ['index', 'watch', 'embed'].map((lane) => [
        lane,
        inspection.samples
          .filter((p) => !resolver.admitted(p, lane as 'index' | 'watch' | 'embed', true))
          .slice(0, 10),
      ])
    ),
    disclosures: inspection.disclosures,
    requiredPermissions: [
      'write-config',
      ...(conflicts.length ? ['replace-choices' as const] : []),
    ],
    effects: [
      'Publish the displayed local configuration patch.',
      'Runtime and index changes require separate host capabilities and observed verification.',
    ],
  };
  if (config.malformed || config.globalUnreadable || config.policyErrors.length)
    body.disclosures.push({
      code: 'mutation-blocked',
      detail: 'Repair unreadable or invalid existing configuration before applying a plan.',
    });
  const screened = redactSecrets(body);
  if (!equal(screened, body))
    screened.disclosures.push({
      code: 'mutation-blocked',
      detail:
        'Private values were redacted from a controlled field; repair that field outside the assistant before applying.',
    });
  if (Buffer.byteLength(JSON.stringify(screened)) > 512 * 1024)
    throw new Error('Plan exceeds the review budget; reduce the candidate before previewing');
  return { ...screened, id: planId(screened) };
}

interface Operation {
  plan: ConfigurationPlan;
  phase:
    | 'prepared'
    | 'published'
    | 'activation-started'
    | 'complete'
    | 'reversion-started'
    | 'reverted';
  result: ConfigurationReceipt;
}
function statePath(plan: ConfigurationPlan): { dir: string; file: string } {
  const dir = process.env.OPENLORE_SETTINGS_RUNTIME_DIR
    ? resolve(process.env.OPENLORE_SETTINGS_RUNTIME_DIR)
    : join(homedir(), '.openlore', 'runtime', 'settings-writes');
  return {
    dir,
    file: join(
      dir,
      'configuration-' +
        configurationDigest({ root: plan.root, target: plan.configPath }).slice(0, 24) +
        '.json'
    ),
  };
}
async function readOperation(plan: ConfigurationPlan): Promise<{
  operation: Operation | null;
  operations: Operation[];
  identity: Awaited<ReturnType<typeof readFileConfinedWithStat>> | null;
}> {
  const { dir, file } = statePath(plan);
  try {
    const identity = await readFileConfinedWithStat(dir, file, 1024 * 1024, true);
    const stored = JSON.parse(identity.content) as {
      operations?: Operation[];
    } & Partial<Operation>;
    const operations = stored.operations ?? (stored.plan ? [stored as Operation] : []);
    if (
      !Array.isArray(operations) ||
      operations.length > 16 ||
      operations.some(
        (operation) =>
          operation.plan?.root !== plan.root ||
          operation.plan.configPath !== plan.configPath ||
          operation.plan.id !== planId(operation.plan) ||
          ![
            'prepared',
            'published',
            'activation-started',
            'complete',
            'reversion-started',
            'reverted',
          ].includes(operation.phase)
      )
    )
      throw new Error('Invalid operation journal');
    return {
      operation: operations.find((operation) => operation.plan.id === plan.id) ?? null,
      operations,
      identity,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { operation: null, operations: [], identity: null };
    throw error;
  }
}
async function recoverOperation(plan: ConfigurationPlan): Promise<void> {
  const { dir, file } = statePath(plan);
  await recoverConfinedAtomicWriteFile(dir, file, file + '.publication');
}
async function saveOperation(operation: Operation): Promise<void> {
  const { dir, file } = statePath(operation.plan);
  const read = await readOperation(operation.plan);
  const operations = [
    ...read.operations.filter((previous) => previous.plan.id !== operation.plan.id),
    operation,
  ].slice(-16);
  let text = JSON.stringify({ version: 1, operations });
  while (Buffer.byteLength(text) > 1024 * 1024 && operations.length > 1) {
    operations.shift();
    text = JSON.stringify({ version: 1, operations });
  }
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error('Operation exceeds private journal budget');
  await confinedAtomicWriteFile(dir, file, text, {
    mode: 0o600,
    expectedIdentity: read.identity?.stat ?? null,
    expectedContent: read.identity?.content,
    recoveryJournalPath: file + '.publication',
  });
}
export async function applyConfiguration(
  plan: ConfigurationPlan,
  options: ConfigurationOptions = {}
): Promise<ConfigurationReceipt> {
  if (
    Buffer.byteLength(JSON.stringify(plan)) > 512 * 1024 ||
    plan.version !== 1 ||
    plan.id !== planId(plan)
  )
    return receipt(plan, 'blocked', 'Invalid plan identity');
  const config = await readConfiguration(options);
  if (
    config.root !== plan.root ||
    config.configPath !== plan.configPath ||
    !hasAuthority(options, plan, 'write-config')
  )
    return receipt(plan, 'blocked', 'Host authorization required for this exact plan and target');
  const result = await withGuardedConfigWrite(plan.root, plan.configPath, async (journal) => {
    options.signal?.throwIfAborted();
    await recoverOperation(plan);
    const previous = (await readOperation(plan)).operation;
    if (previous?.plan.id === plan.id && previous.phase !== 'prepared')
      return {
        ...previous.result,
        retained: true,
        disclosures: [
          ...previous.result.disclosures,
          {
            code: 'retained-operation',
            detail:
              'This is a retained operation receipt. Verify separately to assess current repository/runtime state.',
          },
        ],
      };
    const current = await readConfiguration(options);
    const alreadyPublished =
      previous?.plan.id === plan.id && plan.patches.every((p) => patchMatches(p, current.raw));
    if (!alreadyPublished) {
      const fresh = await preview(
        plan.candidate,
        {
          ...options,
          scope: plan.inspection?.scope,
          budget: plan.inspection?.budget,
          continuation: plan.inspection?.continuation,
        },
        plan.createdAt
      );
      if (fresh.id !== plan.id)
        return receipt(
          plan,
          'stale-plan',
          'Configuration or repository evidence changed; preview again'
        );
      if (
        fresh.disclosures.some((d) =>
          [
            'mutation-blocked',
            'survey-limit',
            'depth-limit',
            'evidence-unreadable',
            'directory-unreadable',
          ].includes(d.code)
        )
      )
        return receipt(plan, 'blocked', 'Complete the scoped review before mutation');
      if (plan.conflicts.length && !hasAuthority(options, plan, 'replace-choices'))
        return receipt(plan, 'needs-input', 'Existing choices require explicit host authorization');
      const next = { ...current.raw };
      for (const patch of plan.patches) publishPatch(next, patch);
      if (validateOpenLoreConfig(next).some(isFatalConfigFinding))
        return receipt(plan, 'blocked', 'Proposed configuration fails schema validation');
      await saveOperation({
        plan,
        phase: 'prepared',
        result: receipt(plan, 'failed', 'Publication has not completed'),
      });
      await confinedAtomicWriteFile(
        plan.root,
        plan.configPath,
        JSON.stringify(next, null, 2) + '\n',
        {
          preserveMode: true,
          expectedIdentity: current.identity,
          expectedContent: current.text,
          recoveryJournalPath: journal,
        }
      );
    }
    let applied: ConfigurationReceipt = {
      ...receipt(plan, 'applied-pending-verification'),
      configPublished: true,
      policyRevision: plan.policyRevision,
      rollbackId: plan.id,
    };
    await saveOperation({ plan, phase: 'published', result: applied });
    if (!options.signal?.aborted && options.activate && hasAuthority(options, plan, 'runtime')) {
      // Durable marker precedes the external effect. An uncertain effect is never replayed on retry.
      await saveOperation({
        plan,
        phase: 'activation-started',
        result: {
          ...applied,
          disclosures: [
            {
              code: 'runtime-outcome-unknown',
              detail: 'Activation may be in progress; observe before retrying.',
            },
          ],
        },
      });
      try {
        await options.activate(plan, options.signal);
      } catch {
        applied.disclosures.push({
          code: 'runtime-activation-failed',
          detail:
            'Configuration is published; runtime activation failed. Verify or recover through the host.',
        });
        await saveOperation({ plan, phase: 'complete', result: applied });
        return applied;
      }
    }
    try {
      applied = await verifyConfiguration(plan, options);
    } catch {
      applied.disclosures.push({
        code: 'verification-unavailable',
        detail: 'Configuration is published; verification was cancelled or unavailable.',
      });
    }
    await saveOperation({ plan, phase: 'complete', result: applied });
    return applied;
  });
  return isGuardedWriteFailure(result) ? receipt(plan, 'blocked', result.reason) : result;
}
export async function verifyConfiguration(
  plan: ConfigurationPlan,
  options: ConfigurationOptions = {}
): Promise<ConfigurationReceipt> {
  const config = await readConfiguration(options);
  if (
    plan.id !== planId(plan) ||
    config.root !== plan.root ||
    config.configPath !== plan.configPath
  )
    return receipt(plan, 'blocked', 'Invalid plan or target');
  if (!plan.patches.every((p) => patchMatches(p, config.raw)))
    return receipt(plan, 'stale-plan', 'Published fields no longer match the plan');
  const result: ConfigurationReceipt = {
    ...receipt(plan, 'applied-pending-verification'),
    configPublished: true,
    policyRevision: plan.policyRevision,
    rollbackId: plan.id,
    observedAt: new Date().toISOString(),
    verification: {
      configuration: 'verified',
      index: 'pending',
      watch: 'pending',
      embed: 'pending',
      tools: 'pending',
      canary: 'not-assessed',
    },
  };
  {
    try {
      result.observations = await (options.observe
        ? options.observe(plan.root, options.signal)
        : observeConfiguration(options));
      for (const [lane, key] of [
        ['index', 'indexPolicyRevision'],
        ['watch', 'watchPolicyRevision'],
        ['embed', 'embeddingPolicyRevision'],
      ] as const) {
        const value = result.observations[key];
        result.verification![lane] =
          value === undefined
            ? 'pending'
            : value === config.resolver.revisionFor(lane)
              ? lane === 'index' && result.observations.indexGenerationCurrent !== true
                ? 'pending'
                : 'verified'
              : 'failed';
      }
      result.verification!.tools =
        result.observations.toolsCompatible === undefined
          ? 'pending'
          : result.observations.toolsCompatible
            ? 'verified'
            : 'failed';
    } catch {
      result.disclosures.push({
        code: 'runtime-observation-unavailable',
        detail: 'Host observations could not be obtained.',
      });
    }
  }
  if (!options.signal?.aborted && options.canary && hasAuthority(options, plan, 'probe')) {
    try {
      const deadline = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, deadline.signal])
        : deadline.signal;
      const requested = options.canaryTimeoutMs ?? CONFIGURATION_CANARY_TIMEOUT_MS;
      const timeout = Math.max(
        1,
        Math.min(
          CONFIGURATION_CANARY_TIMEOUT_MS,
          Number.isFinite(requested) ? requested : CONFIGURATION_CANARY_TIMEOUT_MS
        )
      );
      let onAbort: () => void = () => {};
      const expired = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const timer = setTimeout(
        () => deadline.abort(new Error('Configuration canary deadline exceeded')),
        timeout
      );
      let observed: { delivered: boolean; cleaned: boolean };
      try {
        observed = await Promise.race([options.canary(plan, signal), expired]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }

      result.observations = {
        ...result.observations,
        sourceEventDelivered: observed.delivered,
        canaryCleaned: observed.cleaned,
      };
      result.verification!.canary = observed.delivered && observed.cleaned ? 'verified' : 'failed';
      if (!observed.delivered || !observed.cleaned)
        result.disclosures.push({
          code: 'canary-incomplete',
          detail: !observed.cleaned
            ? 'Probe cleanup was not verified; the host must clean the temporary source and derived entries.'
            : 'The watcher did not deliver the probe event.',
        });
    } catch {
      result.verification!.canary = 'failed';
      result.disclosures.push({
        code: 'canary-failed',
        detail: 'Probe delivery or cleanup could not be verified; host cleanup is required.',
      });
    }
  }
  const states = Object.values(result.verification!);
  result.outcome = states.includes('failed')
    ? 'partially-verified'
    : states.every((s) => s === 'verified' || s === 'not-assessed')
      ? 'verified'
      : 'applied-pending-verification';
  if (states.includes('pending'))
    result.disclosures.push({
      code: 'verification-pending',
      detail: 'Publication is confirmed; runtime behavior has not all been observed.',
    });
  return result;
}
function inverseRules(patch: ConfigurationPatch, current: unknown): unknown {
  const before = object(patch.before),
    after = object(patch.after),
    now = object(current);
  const oldRules = (before.rules ?? []) as FilePolicyRule[],
    newRules = (after.rules ?? []) as FilePolicyRule[],
    currentRules = now.rules as FilePolicyRule[];
  if (!Array.isArray(currentRules)) throw new Error('Overlapping policy edit');
  const touched = new Set(
    [...oldRules, ...newRules]
      .filter(
        (r) =>
          !equal(
            oldRules.find((x) => x.id === r.id),
            newRules.find((x) => x.id === r.id)
          )
      )
      .map((r) => r.id)
  );
  for (const id of touched)
    if (
      !equal(
        currentRules.find((r) => r.id === id),
        newRules.find((r) => r.id === id)
      )
    )
      throw new Error('Overlapping policy edit');
  const known = new Set(newRules.map((r) => r.id));
  if (
    !equal(
      currentRules.filter((r) => known.has(r.id)).map((r) => r.id),
      newRules.filter((r) => currentRules.some((c) => c.id === r.id)).map((r) => r.id)
    )
  )
    throw new Error('Overlapping policy order edit');
  const restored = currentRules.filter((r) => !touched.has(r.id));
  for (const [index, rule] of oldRules.entries()) {
    if (!touched.has(rule.id)) continue;
    const next = oldRules.slice(index + 1).find((r) => restored.some((c) => c.id === r.id));
    const previous = oldRules
      .slice(0, index)
      .reverse()
      .find((r) => restored.some((c) => c.id === r.id));
    const at = next
      ? restored.findIndex((r) => r.id === next.id)
      : previous
        ? restored.findIndex((r) => r.id === previous.id) + 1
        : 0;
    restored.splice(at, 0, rule);
  }
  return { ...now, rules: restored };
}
export async function revertConfiguration(
  plan: ConfigurationPlan,
  options: ConfigurationOptions = {}
): Promise<ConfigurationReceipt> {
  const config = await readConfiguration(options);
  if (
    plan.id !== planId(plan) ||
    config.root !== plan.root ||
    config.configPath !== plan.configPath ||
    !hasAuthority(options, plan, 'write-config')
  )
    return receipt(plan, 'blocked', 'Host authorization required for the original plan');
  const result = await withGuardedConfigWrite(plan.root, plan.configPath, async (journal) => {
    await recoverOperation(plan);
    const saved = (await readOperation(plan)).operation;
    if (saved?.plan.id !== plan.id)
      return receipt(plan, 'blocked', 'No retained operation exists for this plan');
    if (saved.phase === 'reverted') return saved.result;
    const current = await readConfiguration(options),
      next = { ...current.raw };
    if (saved.phase === 'reversion-started' && current.identity === null) {
      const recovered = {
        ...receipt(plan, 'reverted'),
        configPublished: true,
        disclosures: [
          {
            code: 'runtime-reversion-pending',
            detail:
              'Initial configuration absence is confirmed; runtime must be verified separately.',
          },
        ],
      };
      await saveOperation({ plan, phase: 'reverted', result: recovered });
      return recovered;
    }
    try {
      for (const patch of plan.patches) {
        if (patch.field === 'filePolicies' && !equal(next[patch.field], patch.after))
          next[patch.field] = inverseRules(patch, next[patch.field]);
        else {
          if (!patchMatches(patch, next)) throw new Error('Overlapping later edit');
          publishPatch(next, patch, true);
        }
      }
    } catch {
      return receipt(plan, 'blocked', 'Rollback overlaps a later edit; no changes were written');
    }
    const initial = plan.patches.some((p) => p.field === 'version' && p.before === undefined);
    const remove = initial && Object.keys(next).length === 0;
    const retainedBootstrap = initial && !remove;
    if (retainedBootstrap)
      for (const patch of plan.patches) {
        if (
          [
            'version',
            'projectType',
            'openspecPath',
            'analysis',
            'generation',
            'createdAt',
            'lastRun',
          ].includes(patch.field)
        )
          next[patch.field] = { ...current.raw }[patch.field];
      }
    await saveOperation({
      plan,
      phase: 'reversion-started',
      result: {
        ...receipt(
          plan,
          'partially-verified',
          'Rollback may be in progress; inspect its journal before retrying'
        ),
        configPublished: true,
      },
    });
    await confinedAtomicWriteFile(
      plan.root,
      plan.configPath,
      JSON.stringify(next, null, 2) + '\n',
      {
        preserveMode: true,
        removeIfUnchanged: remove,
        expectedIdentity: current.identity,
        expectedContent: current.text,
        recoveryJournalPath: journal,
      }
    );
    const reverted = {
      ...receipt(plan, retainedBootstrap ? 'partially-verified' : 'reverted'),
      configPublished: true,
      disclosures: [
        ...(retainedBootstrap
          ? [
              {
                code: 'bootstrap-retained',
                detail:
                  'Valid bootstrap settings are retained to preserve later user work; assistant policies were reverted.',
              },
            ]
          : []),
        {
          code: 'runtime-reversion-pending',
          detail:
            'Configuration patch was reverted; runtime and derived artifacts require host verification.',
        },
      ],
    };
    await saveOperation({ plan, phase: 'reverted', result: reverted });
    return reverted;
  });
  return isGuardedWriteFailure(result) ? receipt(plan, 'blocked', result.reason) : result;
}
/** Normalize a host-granted root without importing structural services. */
export async function configurationRoot(path: string): Promise<string> {
  return realpath(path);
}
