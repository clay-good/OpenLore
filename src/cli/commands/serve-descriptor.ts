/**
 * serve-descriptor — the ONE validator for the untrusted daemon-discovery
 * artifact `.openlore/serve.json`.
 *
 * The descriptor is a repo-local, attacker-writable file that OpenLore reads at
 * three sites — the `serve` CLI, the serve-client the stdio MCP server delegates
 * through, and the Pi extension. Each reader then FETCHES the host/port the file
 * names for a liveness probe and, on a healthy answer, POSTs the project
 * directory and full tool arguments to it. A poisoned descriptor is therefore an
 * SSRF / egress vector, a leak of the directory + tool args, and a result-
 * poisoning channel into the agent's context (mcp-security: Untrusted Artifact
 * Deserialization). One threat model must not have three postures.
 *
 * This module is the one lock, extracted verbatim from `serve.ts`'s existing
 * reader: loopback-only host, integer port 1–65535, integer pid > 0, token
 * absent-or-string. No check is invented here beyond the ones `serve` already
 * applied. A descriptor that fails any check is treated exactly as ABSENT — the
 * reader returns null and the caller takes its existing no-daemon path (spawn a
 * fresh daemon or fall back to in-process dispatch). No field of an invalid
 * descriptor ever becomes a fetch target or request header.
 *
 * Dependency-light by contract (mcp-security ServeDescriptorValidatedAtEveryReader
 * + the MCP↔Pi parity doctrine): it imports only node builtins and the loopback
 * predicate it shares with the HTTP guard, so the Pi host can import it without
 * pulling in the analyzer.
 */

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isLoopbackHost } from './local-http-guard.js';

/**
 * The validated daemon-discovery descriptor. `startedAt` / `version` are
 * advisory metadata (normalized to '' when absent or ill-typed); the other four
 * fields are security-critical and are only present on a descriptor that passed
 * {@link validateServeDescriptor}.
 */
export interface ServeDescriptor {
  port: number;
  pid: number;
  host: string;
  token?: string;
  startedAt: string;
  version: string;
  state?: 'ready' | 'draining';
}

export interface ServeHealth {
  ok: true;
  presetDispatchEnforced: true;
  root: string;
  pid: number;
  preset: string;
  tools: string[];
  tokenProtected: boolean;
  tokenAuthenticated: boolean;
  draining: boolean;
}

/** Build the loopback HTTP origin, including the brackets required by IPv6 URLs. */
export function serveHttpBaseUrl(host: string, port: number): string {
  const normalized = host.replace(/^\[|\]$/g, '');
  return `http://${normalized.includes(':') ? `[${normalized}]` : normalized}:${port}`;
}

/** Resolve aliases to the stable filesystem identity used in health proofs. */
export function canonicalServeRoot(root: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(root));
  } catch {
    canonical = resolve(root);
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Validate the semantic compatibility and identity fields returned by `/health`. */
export function validateServeHealth(
  parsed: unknown,
  expectedRoot: string,
  descriptor?: Pick<ServeDescriptor, 'pid' | 'token'>,
): ServeHealth | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const h = parsed as Record<string, unknown>;
  if (
    h.ok !== true
    || h.presetDispatchEnforced !== true
    || typeof h.root !== 'string'
    || canonicalServeRoot(h.root) !== canonicalServeRoot(expectedRoot)
    || typeof h.pid !== 'number'
    || !Number.isInteger(h.pid)
    || h.pid <= 0
    || typeof h.preset !== 'string'
    || !Array.isArray(h.tools)
    || !h.tools.every((tool) => typeof tool === 'string')
    || typeof h.tokenProtected !== 'boolean'
    || h.tokenAuthenticated !== true
    || typeof h.draining !== 'boolean'
    || (descriptor !== undefined && h.pid !== descriptor.pid)
    || (descriptor !== undefined && h.tokenProtected !== Boolean(descriptor.token))
  ) return null;
  return {
    ok: true,
    presetDispatchEnforced: true,
    root: canonicalServeRoot(h.root),
    pid: h.pid,
    preset: h.preset,
    tools: h.tools as string[],
    tokenProtected: h.tokenProtected,
    tokenAuthenticated: true,
    draining: h.draining,
  };
}

/**
 * Validate an already-parsed value as a {@link ServeDescriptor}. Returns the
 * normalized descriptor, or null if ANY security-critical field is
 * missing / ill-typed / out of range, or the host is not a loopback form.
 */
export function validateServeDescriptor(parsed: unknown): ServeDescriptor | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;
  const portOk =
    typeof d.port === 'number' && Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535;
  const pidOk = typeof d.pid === 'number' && Number.isInteger(d.pid) && d.pid > 0;
  // Confine host to loopback: a recorded non-loopback host must never become an
  // outbound fetch target during liveness probing (egress / SSRF).
  const hostOk = typeof d.host === 'string' && isLoopbackHost(d.host);
  const tokenOk = d.token === undefined || typeof d.token === 'string';
  const stateOk = d.state === undefined || d.state === 'ready' || d.state === 'draining';
  if (!portOk || !pidOk || !hostOk || !tokenOk || !stateOk) return null;
  const state = d.state === 'ready' || d.state === 'draining' ? d.state : undefined;
  return {
    port: d.port as number,
    pid: d.pid as number,
    host: d.host as string,
    token: d.token as string | undefined,
    startedAt: typeof d.startedAt === 'string' ? d.startedAt : '',
    version: typeof d.version === 'string' ? d.version : '',
    ...(state === undefined ? {} : { state }),
  };
}

/**
 * Read + validate a serve.json at `descriptorPath`. Any failure — missing file,
 * malformed JSON, or a descriptor that fails {@link validateServeDescriptor} —
 * resolves to null, so a poisoned descriptor is indistinguishable from an absent
 * one and no field of it ever reaches a fetch target or request header.
 */
export async function readServeDescriptor(
  descriptorPath: string,
  options: { includeDraining?: boolean } = {},
): Promise<ServeDescriptor | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(descriptorPath, 'utf-8'));
  } catch {
    return null;
  }
  const descriptor = validateServeDescriptor(parsed);
  return descriptor?.state === 'draining' && !options.includeDraining ? null : descriptor;
}
