/**
 * Standard MCP tool annotations are explicit and verified (change: adopt-mcp-protocol-conformance;
 * mcp-quality: Tool Behavior Annotations).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TOOL_DEFINITIONS, toolAnnotations, ANNOTATED_TOOL_NAMES } from './mcp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DISPATCH = resolve(ROOT, 'src/core/services/tool-dispatch.ts');

/** Node primitives that write, move, or delete files, or start a process. */
const WRITE_PRIMITIVE = /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync|truncate|truncateSync|chmod|chmodSync|utimes|utimesSync|createWriteStream|spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/;
const PRIMITIVE_MODULE = /node_modules[\\/]@types[\\/]node[\\/](fs|fs[\\/]promises|child_process)\.d\.ts$/;

/** Shared write helpers: a write inside one is attributed to the function that called it. */
const WRITE_HELPERS = new Set(['atomicWriteFile', 'renameWithContentionRetry', 'casUpdate', 'writeJsonAtomicStreaming']);

/**
 * Audited writes a read-only tool may reach (`function@file`), each with why it is not user-visible
 * state. Anything else a read-only tool can reach fails the guard.
 */
const READ_ONLY_TOOL_MAY_WRITE: Record<string, string> = {
  // Paths every tool shares: opt-in telemetry, and recovery of an already-corrupt store or index.
  'emit@src/core/services/telemetry.ts': 'opt-in telemetry (OPENLORE_TELEMETRY=1)',
  'rotateTelemetryFile@src/core/services/telemetry.ts': 'opt-in telemetry rotation',
  'quarantineCorrupt@src/core/decisions/atomic-store.ts': 'moves an already-corrupt store aside',
  'quarantineCorruptSync@src/core/decisions/atomic-store.ts': 'moves an already-corrupt index aside',
  'moveSiblingsSync@src/core/decisions/atomic-store.ts': 'part of corrupt-index quarantine',
  // Transient coordination files removed on release.
  'acquireLockAt@src/core/runtime/advisory-lock.ts': 'advisory lock file, removed on release',
  'acquireNamespaceGate@src/core/runtime/advisory-lock.ts': 'advisory lock gate, removed on release',
  'releaseSync@src/core/runtime/analysis-ownership.ts': 'releases an ownership lock',
  'release@src/core/runtime/analysis-ownership.ts': 'releases an ownership lock',
  'restoreGuard@src/utils/path-confinement.ts': 'restores a confinement guard link it created',
  // Rebuildable caches and scratch space.
  'persistCorpusSidecar@src/core/analyzer/vector-index.ts': 'rebuildable BM25 corpus sidecar',
  'latchFailed@src/core/analyzer/cfg-spill.ts': 'removes its own CFG spill file',
  'sweepLeakedCfgSpills@src/core/analyzer/cfg-spill.ts': 'removes leaked CFG spill files',
  'sweepLeakedStaging@src/core/analyzer/text-line-index.ts': 'removes leaked text-index staging',
  'runGit@src/core/services/mcp-handlers/analysis.ts': 'OS temp directory, removed in finally',
  // Argument-gated writes every read-only dispatch turns off (asserted below).
  'writeSpecLinkIndex@src/core/generator/spec-link-service.ts': 'mapping.json cache, only when persist is true',
  'audit@src/api/audit.ts': 'audit report, only when save is true',
  'generate@src/core/analyzer/spec-snapshot-generator.ts': 'spec snapshot, only when persist is true',
};

interface ToolReach { names: string[]; resolved: number; writes: Map<string, string[]> }

/** Follow every tool's dispatch branch through resolved calls to write primitives. */
function traceWrites(): ToolReach[] {
  const config = ts.getParsedCommandLineOfConfigFile(resolve(ROOT, 'tsconfig.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {},
  });
  const program = ts.createProgram({ rootNames: [DISPATCH], options: { ...config!.options, noEmit: true } });
  const checker = program.getTypeChecker();
  type Fn = ts.FunctionLikeDeclaration & { body: ts.Node };

  const inProject = (node: ts.Node) => {
    const file = node.getSourceFile().fileName;
    return !file.includes('node_modules') && !file.endsWith('.d.ts');
  };
  const nameOf = (fn: ts.Node): string => {
    const named = fn as { name?: ts.Node };
    if (named.name) return named.name.getText();
    return fn.parent && ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText() : '<anonymous>';
  };
  const keyOf = (fn: ts.Node) => `${nameOf(fn)}@${relative(ROOT, fn.getSourceFile().fileName).split('\\').join('/')}`;
  const calleeOf = (call: ts.CallExpression | ts.NewExpression): ts.Declaration | undefined => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (declaration && !ts.isJSDocSignature(declaration)) return declaration;
    const expression = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations?.[0];
  };
  const functionOf = (declaration: ts.Node | undefined): Fn | undefined => {
    let node = declaration;
    if (node && ts.isVariableDeclaration(node) && node.initializer) node = node.initializer;
    if (!node || !inProject(node)) return undefined;
    const fn = node as ts.FunctionLikeDeclaration;
    return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)) && fn.body
      ? fn as Fn : undefined;
  };
  const isWritePrimitive = (declaration: ts.Declaration | undefined) => {
    if (!declaration || !PRIMITIVE_MODULE.test(declaration.getSourceFile().fileName)) return false;
    const name = (declaration as { name?: ts.Node }).name?.getText() ?? '';
    return WRITE_PRIMITIVE.test(name);
  };

  const reach = (starts: Fn[]): Map<string, string[]> => {
    const parent = new Map<Fn, Fn | null>(starts.map(start => [start, null]));
    const queue = [...starts];
    const writes = new Map<string, string[]>();
    for (let head = 0; head < queue.length; head++) {
      const fn = queue[head];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callee = calleeOf(node);
          if (isWritePrimitive(callee)) {
            let owner: Fn | null | undefined = fn;
            while (owner && (WRITE_HELPERS.has(nameOf(owner)) || nameOf(owner) === '<anonymous>')) owner = parent.get(owner);
            if (owner && !writes.has(keyOf(owner))) {
              const chain: string[] = [];
              for (let c: Fn | null | undefined = owner; c; c = parent.get(c)) chain.unshift(keyOf(c));
              writes.set(keyOf(owner), chain);
            }
          }
          const next = functionOf(callee);
          if (next && !parent.has(next)) { parent.set(next, fn); queue.push(next); }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(fn.body, visit);
    }
    return writes;
  };

  const source = program.getSourceFile(DISPATCH)!;
  const tools: ToolReach[] = [];
  const findBranches = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const names: string[] = [];
      const collect = (e: ts.Expression): void => {
        if (!ts.isBinaryExpression(e)) return;
        if (e.operatorToken.kind === ts.SyntaxKind.BarBarToken) { collect(e.left); collect(e.right); return; }
        if (e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && e.left.getText() === 'name' && ts.isStringLiteral(e.right)) names.push(e.right.text);
      };
      collect(node.expression);
      if (names.length > 0) {
        const starts: Fn[] = [];
        const gather = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) { const fn = functionOf(calleeOf(n)); if (fn) starts.push(fn); }
          ts.forEachChild(n, gather);
        };
        gather(node.thenStatement);
        tools.push({ names, resolved: starts.length, writes: reach(starts) });
      }
    }
    ts.forEachChild(node, findBranches);
  };
  findBranches(source);
  return tools;
}

describe('tool annotation coverage', () => {
  it('every advertised tool has an explicit read/write annotation entry', () => {
    const annotated = new Set(ANNOTATED_TOOL_NAMES);
    const missing = TOOL_DEFINITIONS.map(t => t.name).filter(name => !annotated.has(name));
    expect(missing, `tools without a TOOL_ANNOTATIONS entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries no annotation entry for a tool that is not advertised', () => {
    const defined = new Set(TOOL_DEFINITIONS.map(t => t.name));
    expect(ANNOTATED_TOOL_NAMES.filter(name => !defined.has(name))).toEqual([]);
  });

  it('never serves fallback read-only hints for a tool without an entry', () => {
    const a = toolAnnotations('a_tool_nobody_annotated');
    expect(a.readOnlyHint).toBeUndefined();
    expect(a.destructiveHint).toBeUndefined();
    expect(a.idempotentHint).toBeUndefined();
    expect(toolAnnotations('constructor').readOnlyHint).toBeUndefined();
  });
});

describe('tool annotation accuracy against the dispatch target', () => {
  let tools: ToolReach[] = [];
  const byName = (name: string) => tools.find(t => t.names.includes(name));
  beforeAll(() => { tools = traceWrites(); }, 120_000);

  it('dispatches every advertised tool through at least one resolved handler', () => {
    const unresolved = TOOL_DEFINITIONS.map(t => t.name).filter(name => (byName(name)?.resolved ?? 0) === 0);
    expect(unresolved).toEqual([]);
  });

  it('never declares a tool read-only when it can reach a write outside the audited paths', () => {
    const violations = TOOL_DEFINITIONS
      .filter(t => toolAnnotations(t.name).readOnlyHint === true)
      .flatMap(t => [...(byName(t.name)?.writes ?? new Map<string, string[]>())]
        .filter(([owner]) => !(owner in READ_ONLY_TOOL_MAY_WRITE))
        .map(([, chain]) => `${t.name}: ${chain.join(' -> ')}`));
    expect(violations).toEqual([]);
  });

  it('detects the known writers, so the trace is not vacuous', () => {
    const expected: Record<string, string> = {
      generate_tests: 'writeTestFiles@src/core/test-generator/test-writer.ts',
      federation_status: 'saveRegistry@src/core/federation/registry.ts',
      change_impact_certificate: 'persistCertificate@src/core/services/mcp-handlers/impact-certificate.ts',
      remember: 'updateMemoryStore@src/core/decisions/memory-store.ts',
      record_decision: 'spawnConsolidateBackground@src/core/services/mcp-handlers/decisions.ts',
      sync_decisions: 'createADR@src/core/decisions/syncer.ts',
    };
    for (const [tool, owner] of Object.entries(expected)) {
      expect([...(byName(tool)?.writes.keys() ?? [])], tool).toContain(owner);
    }
  });

  it('keeps every allowed write in use, so the allowlist cannot go stale', () => {
    const reached = new Set(tools.flatMap(t => [...t.writes.keys()]));
    expect(Object.keys(READ_ONLY_TOOL_MAY_WRITE).filter(owner => !reached.has(owner))).toEqual([]);
  });
});

describe('argument-gated writes stay off for read-only dispatch', () => {
  it('passes persist:false or save:false wherever a read-only tool reaches a gated write', async () => {
    const { readFileSync } = await import('node:fs');
    const dispatch = readFileSync(DISPATCH, 'utf-8');
    expect(dispatch).toContain('handleAuditSpecCoverage(directory, maxUncovered, hubThreshold, false)');
    const workflow = readFileSync(resolve(ROOT, 'src/core/services/spec-workflow.ts'), 'utf-8');
    expect(workflow.match(/persist: false/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const analysis = readFileSync(resolve(ROOT, 'src/core/services/mcp-handlers/analysis.ts'), 'utf-8');
    expect(analysis).toMatch(/resolveSpecLinkIndex\(\{[^}]*persist: false/);
  });
});
