/**
 * Opt-in telemetry writer for openlore.
 *
 * Gate: OPENLORE_TELEMETRY=1 (disabled by default).
 * Writes append-only JSONL to .openlore/telemetry/<domain>.jsonl.
 * Local only: events are never transmitted; error/module paths are relativized.
 * Never throws — telemetry must not crash the hot path.
 *
 * Rotation: when a domain file exceeds ROTATE_THRESHOLD_BYTES, it is renamed
 * to <domain>.1.jsonl and older rotated files shifted (keeps MAX_ROTATED_FILES).
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { redactSecrets } from './secret-redaction.js';

const TELEMETRY_SUBDIR = 'telemetry';
const ROTATE_THRESHOLD_BYTES = 50 * 1024 * 1024;  // 50 MB
/** Number of rotated archive files kept per domain (`<domain>.1.jsonl` … `<domain>.N.jsonl`).
 *  Exported so readers that must span rotation (e.g. the panic accuracy gate) stay in lockstep. */
export const MAX_ROTATED_FILES = 5;
const _createdDirs = new Set<string>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathPrefixPattern(value: string): string {
  return value.split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]');
}

/** Shared implementation exported only so separator parity is testable on every OS. */
export function _relativizeTelemetryPathsWithPrefixes(
  value: string,
  root: string,
  home: string,
  caseInsensitive = process.platform === 'win32',
): string {
  const flags = caseInsensitive ? 'gi' : 'g';
  const rootPattern = pathPrefixPattern(root);
  let result = value
    .replace(new RegExp(`${rootPattern}[\\\\/]`, flags), '')
    .replace(new RegExp(`${rootPattern}(?=$|[\\s:'"),\\]])`, flags), '.');
  if (home && home !== root) {
    const homePattern = pathPrefixPattern(home);
    result = result
      .replace(new RegExp(`${homePattern}[\\\\/]`, flags), '~/')
      .replace(new RegExp(`${homePattern}(?=$|[\\s:'"),\\]])`, flags), '~');
  }
  return result;
}

/**
 * Remove local absolute-path disclosure from telemetry fields that carry free
 * text. Paths under the project become project-relative; paths elsewhere under
 * the user's home become `~`-relative. Other text is unchanged.
 */
export function relativizeTelemetryPaths(directory: string, value: string): string {
  const root = resolve(directory);
  const home = homedir();
  return _relativizeTelemetryPathsWithPrefixes(value, root, home);
}

// ── Emitting identity (change: scope-telemetry-by-agent-and-session) ─────────
// A repository is a shared surface: two agents (a coding agent and one it spawns)
// write the SAME telemetry files. Without identity stamped at WRITE time, a
// reader cannot separate them afterwards — one agent's calls land in the other's
// statistics, and an interval metric pairs one actor's stale warning with
// another's later orientation, hours apart. So identity is resolved once per
// process and merged into every event here, rather than added at each call site.

export interface TelemetryIdentity {
  /** Emitting agent (MCP `clientInfo.name`, or `cli:<command>` for CLI runs). */
  agent: string;
  /** Emitting agent's version, `unknown` when the source did not state one. */
  agent_version: string;
  /** Stable for this process, distinct across processes. */
  session_id: string;
}

/** Identity source registered by the host, resolved lazily and at most once. */
type IdentitySource = () => { agent?: string; agentVersion?: string };

let _identity: TelemetryIdentity | null = null;
let _identitySource: IdentitySource | null = null;
let _sessionId: string | null = null;

/** Mint the per-process session id. Never throws — falls back to pid+time. */
function sessionId(): string {
  if (_sessionId) return _sessionId;
  try {
    // Keep the full UUID. A short 32-bit prefix is unnecessarily collision-prone
    // for telemetry accumulated across many processes and repositories.
    _sessionId = `${process.pid.toString(36)}-${randomUUID()}`;
  } catch {
    _sessionId = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
  }
  return _sessionId;
}

/**
 * Register the emitting agent directly (MCP servers know it at initialize time).
 * Re-registering replaces the name but KEEPS the session id: one process is one
 * session, even if the client identifies itself late.
 */
export function setTelemetryIdentity(agent: string, agentVersion?: string): void {
  _identity = {
    agent: agent || 'unknown',
    agent_version: agentVersion || 'unknown',
    session_id: sessionId(),
  };
  _identitySource = null;
}

/**
 * Register a lazy identity source for hosts that only know the agent later (the
 * CLI derives it from the invoked command). Resolved at most once, on first emit.
 */
export function setTelemetryIdentitySource(source: IdentitySource): void {
  if (_identity) return;  // an explicit identity always wins
  _identitySource = source;
}

/**
 * The identity stamped on every event. Never throws: a source that throws, or one
 * that yields nothing, degrades to `unknown` — an unattributed event is honest,
 * a missing event is not.
 */
export function getTelemetryIdentity(): TelemetryIdentity {
  if (_identity) return _identity;
  let agent = 'unknown';
  let agentVersion = 'unknown';
  if (_identitySource) {
    try {
      const resolved = _identitySource();
      agent = resolved?.agent || 'unknown';
      agentVersion = resolved?.agentVersion || 'unknown';
    } catch {
      // Identity resolution must never cost an event.
    }
    _identitySource = null;
  }
  _identity = { agent, agent_version: agentVersion, session_id: sessionId() };
  return _identity;
}

/** Test seam: forget the resolved identity so a case can register its own. */
export function resetTelemetryIdentityForTests(): void {
  _identity = null;
  _identitySource = null;
  _sessionId = null;
}

function rotateTelemetryFile(filePath: string): void {
  // Shift existing rotated files: .5.jsonl deleted, .4 → .5, …, .1 → .2
  const base = filePath.replace(/\.jsonl$/, '');
  try { unlinkSync(`${base}.${MAX_ROTATED_FILES}.jsonl`); } catch { /* not present */ }
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    try { renameSync(`${base}.${i}.jsonl`, `${base}.${i + 1}.jsonl`); } catch { /* not present */ }
  }
  try { renameSync(filePath, `${base}.1.jsonl`); } catch { /* rename failed — continue writing */ }
}

/**
 * Emit a telemetry event to .openlore/telemetry/<domain>.jsonl.
 *
 * @param directory  - project root (must be absolute)
 * @param domain     - log file name without extension (e.g. 'mcp', 'cache', 'epistemic-lease')
 * @param payload    - arbitrary fields merged with the timestamp
 */
export function emit(
  directory: string,
  domain: string,
  payload: Record<string, unknown>,
): void {
  if (process.env['OPENLORE_TELEMETRY'] !== '1') return;
  if (!directory) return;
  try {
    const dir = join(directory, OPENLORE_DIR, TELEMETRY_SUBDIR);
    if (!_createdDirs.has(dir)) { mkdirSync(dir, { recursive: true }); _createdDirs.add(dir); }
    const filePath = join(dir, `${domain}.jsonl`);
    // Rotate before writing if file exceeds threshold
    try {
      const { size } = statSync(filePath);
      if (size >= ROTATE_THRESHOLD_BYTES) rotateTelemetryFile(filePath);
    } catch { /* file doesn't exist yet */ }
    // Defense in depth: a telemetry payload must never carry a credential to disk
    // (mcp-security: Secret Confinement Across All Output Paths). The identity is
    // redacted with the payload — the agent name comes from an external client.
    // Payload fields win over identity, so a call site that already states its
    // own `agent` (the orient events) keeps that attribution.
    const pathSafePayload = { ...payload };
    for (const field of ['error', 'module'] as const) {
      const value = pathSafePayload[field];
      if (typeof value === 'string') {
        pathSafePayload[field] = relativizeTelemetryPaths(directory, value);
      }
    }
    const safe = redactSecrets({ ...getTelemetryIdentity(), ...pathSafePayload });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safe }) + '\n';
    appendFileSync(filePath, line, 'utf-8');
  } catch {
    // never crash the hot path
  }
}
