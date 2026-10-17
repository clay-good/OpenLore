/** Shared, dependency-light config reads for the CLI, MCP and Pi hosts. */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function globalOpenLoreConfigPath(): string {
  // An explicit path also lets supervising hosts isolate user configuration.
  return process.env.OPENLORE_GLOBAL_CONFIG
    ? resolve(process.env.OPENLORE_GLOBAL_CONFIG)
    : join(homedir(), '.openlore', 'config.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ConfigFileReadError extends Error {
  constructor(public readonly configPath: string, detail: string, cause?: unknown) {
    super(detail.includes('malformed JSON') ? `Invalid JSON in ${configPath}: ${detail}` : `${configPath}: ${detail}`, { cause });
    this.name = 'ConfigFileReadError';
  }
}

export async function readConfigObject(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigFileReadError(path, 'the existing config could not be read', error);
  }
  return parseConfigObject(path, text);
}

function parseConfigObject(path: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigFileReadError(path, 'the existing config is malformed JSON', error);
  }
  if (!isObject(value)) throw new ConfigFileReadError(path, 'the existing config root is not a JSON object');
  return value;
}

export function readConfigObjectSync(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigFileReadError(path, 'the existing config could not be read', error);
  }
  return parseConfigObject(path, text);
}

/** Merge object fields; a project array, scalar or null replaces the user value. */
export function mergeConfigLayers(
  defaults: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(project)) {
    // Never turn config data into object prototype mutations.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    // A project can turn off inherited embeddings without retaining an invalid
    // nullable embedding object at the typed config boundary.
    if (key === 'embedding' && value === null) {
      delete merged.embedding;
      continue;
    }
    merged[key] = isObject(value) && isObject(defaults[key])
      ? mergeConfigLayers(defaults[key], value)
      : value;
  }
  // Models/endpoints/TLS overrides are provider-coupled, not generic defaults.
  if (isObject(defaults.generation) && isObject(project.generation) && isObject(merged.generation)
    && Object.hasOwn(project.generation, 'provider')
    && project.generation.provider !== defaults.generation.provider) {
    for (const key of ['model', 'openaiCompatBaseUrl', 'skipSslVerify']) {
      if (!Object.hasOwn(project.generation, key)) delete merged.generation[key];
    }
  }
  // A model with no provider beside it belongs to the built-in provider (`openlore init`
  // writes the built-in model this way). It must not pair with an inherited provider.
  if (isObject(defaults.generation) && isObject(project.generation) && isObject(merged.generation)
    && typeof defaults.generation.provider === 'string'
    && !Object.hasOwn(project.generation, 'provider')
    && Object.hasOwn(project.generation, 'model')) {
    if (Object.hasOwn(defaults.generation, 'model')) merged.generation.model = defaults.generation.model;
    else delete merged.generation.model;
  }
  // A layer that chooses its own endpoint does not inherit the lower layer's credential
  // or TLS opt-out for it: a repository must not pick where the user's key is sent.
  for (const [key, value] of Object.entries(project)) {
    const block = merged[key];
    const lower = defaults[key];
    if (!isObject(value) || !isObject(lower) || !isObject(block)) continue;
    if (!ENDPOINT_KEYS.some((field) => Object.hasOwn(value, field) && value[field] !== lower[field])) continue;
    for (const field of ENDPOINT_BOUND_KEYS) {
      if (!Object.hasOwn(value, field)) delete block[field];
    }
  }
  return merged;
}

const ENDPOINT_KEYS = ['baseUrl', 'apiBase', 'openaiCompatBaseUrl'];
const ENDPOINT_BOUND_KEYS = ['apiKey', 'skipSslVerify', 'sslVerify'];

/**
 * True when `value` at dotted `field` is the one the user-wide config sets. Such a value
 * is user-authored, so repository trust checks do not apply to it. Fail-closed.
 */
export function isUserConfiguredValue(field: string, value: unknown): boolean {
  if (value === undefined) return false;
  try {
    let node: unknown = readConfigObjectSync(globalOpenLoreConfigPath());
    for (const part of field.split('.')) node = isObject(node) && Object.hasOwn(node, part) ? node[part] : undefined;
    return node === value;
  } catch {
    return false;
  }
}

export async function readLayeredConfig(
  projectPath: string,
  builtInDefaults?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const userPath = globalOpenLoreConfigPath();
  if (resolve(projectPath) === resolve(userPath)) {
    const user = await readConfigObject(projectPath);
    return user && builtInDefaults ? mergeConfigLayers(builtInDefaults, user) : user;
  }
  const user = await readConfigObject(userPath);
  const project = await readConfigObject(projectPath);
  if (!user) return project ? mergeConfigLayers({}, project) : null;
  const defaults = mergeConfigLayers(builtInDefaults ?? {}, user);
  if (!project) return defaults;
  return mergeConfigLayers(defaults, project);
}

/** Background auto-init has synchronous suppression checks; share the same merge. */
export function readLayeredConfigSync(projectPath: string): Record<string, unknown> | null {
  const userPath = globalOpenLoreConfigPath();
  if (resolve(projectPath) === resolve(userPath)) return readConfigObjectSync(projectPath);
  const user = readConfigObjectSync(userPath);
  const project = readConfigObjectSync(projectPath);
  if (!user) return project ? mergeConfigLayers({}, project) : null;
  const defaults = mergeConfigLayers({}, user);
  return project ? mergeConfigLayers(defaults, project) : defaults;
}
