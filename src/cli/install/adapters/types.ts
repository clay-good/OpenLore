/**
 * Shared types for OpenLore install adapters.
 *
 * An adapter knows how to plan, apply, and uninstall OpenLore's footprint on
 * one specific agent surface. Adapters never write to disk directly when
 * `dryRun` is true; instead they return a list of `PlannedChange` entries that
 * the caller renders.
 */

import type { AgentName } from '../detect.js';
import type { PlatformCommandRuntime } from '../../../utils/platform-command.js';

export interface PlannedChange {
  /** Absolute path the change applies to. */
  path: string;
  /** What we'd do to that file. */
  kind: 'create' | 'update' | 'noop' | 'delete';
  /** Short human-readable summary (one line). */
  summary: string;
  /** Optional unified-diff-ish preview for `--dry-run`. */
  preview?: string;
}

export interface ApplyContext {
  root: string;
  /** Platform on which generated launch commands will execute. */
  platform: NodeJS.Platform;
  /** Trusted executable roots used when emitting Windows command wrappers. */
  platformCommandRuntime: PlatformCommandRuntime;
  /** Template content for the markdown instruction block. */
  instructionTemplate: string;
  dryRun: boolean;
  force: boolean;
  /**
   * Optional MCP tool preset (e.g. "memory", "navigation", "minimal"). When set,
   * adapters that register the MCP server wire `openlore mcp --preset <name>` so
   * the agent sees that curated surface instead of the full tool set. Undefined
   * = the server's default (all tools).
   */
  preset?: string;
}

export interface ApplyResult {
  changes: PlannedChange[];
  /** Warnings to surface to the user (e.g. hand-edited block, unsure-of-path TODO). */
  warnings: string[];
  /** If true, install should exit non-zero (hand-edit conflict without --force). */
  conflict: boolean;
}

export interface Adapter {
  name: AgentName;
  apply(ctx: ApplyContext): Promise<ApplyResult>;
  uninstall(ctx: ApplyContext): Promise<ApplyResult>;
  /**
   * Preset-insensitive presence check for `connect list`: is OpenLore's managed
   * footprint present for this agent under `root`? Checks for our marker (a
   * markdown block, or a managed JSON entry), NOT config equality — an agent
   * wired with a different preset or an older template still counts as connected.
   */
  isConnected(root: string): Promise<boolean>;
}
