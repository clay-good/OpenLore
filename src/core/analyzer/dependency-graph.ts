/**
 * Dependency Graph Service
 *
 * Builds a complete graph of how files relate to each other through imports.
 * Provides metrics like in-degree, out-degree, betweenness centrality, and PageRank.
 * Detects clusters, cycles, and special nodes (centers, leaves, bridges, orphans).
 */

import { ImportExportParser, resolveImport, type ExportInfo, type FileAnalysis } from './import-parser.js';
import { extractAllHttpEdges, type HttpEdge } from './http-route-parser.js';
import { deriveDomainFromPath } from './domain-naming.js';
import { escapeDotString } from '../../utils/misc.js';
import type { ScoredFile } from '../../types/index.js';
import {
  PAGERANK_DAMPING_FACTOR,
  PAGERANK_CONVERGENCE_TOLERANCE,
  PAGERANK_MAX_ITERATIONS,
} from '../../constants.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const CLUSTER_PALETTE = [
  '#7c6af7',
  '#3ecfcf',
  '#f77c6a',
  '#6af7a0',
  '#f7c76a',
  '#f76ac8',
  '#6aaff7',
  '#c8f76a',
  '#f7a06a',
  '#a0a0ff',
  '#ff6b9d',
  '#00d4aa',
  '#ffb347',
];

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Node in the dependency graph
 */
export interface DependencyNode {
  id: string;
  file: ScoredFile;
  exports: ExportInfo[];
  metrics: {
    inDegree: number;
    outDegree: number;
    betweenness: number;
    pageRank: number;
  };
  cluster?: {
    id: string;
    name: string;
    color: string;
  };
}

/**
 * Edge in the dependency graph
 */
export interface DependencyEdge {
  source: string;
  target: string;
  importedNames: string[];
  isTypeOnly: boolean;
  weight: number;
  /** Present when this edge was derived from an HTTP call rather than a static import */
  httpEdge?: HttpEdge;
  /** True when this edge was synthesized from a call-graph cross-file call (implicit import) */
  isCallEdge?: boolean;
  /** Present when this edge is an HTML page → asset reference (decision b555b680) */
  assetKind?: 'script' | 'stylesheet';
}

/**
 * Cluster of related files
 */
export interface FileCluster {
  id: string;
  name: string;
  files: string[];
  internalEdges: number;
  externalEdges: number;
  cohesion: number;
  coupling: number;
  suggestedDomain: string;
  color: string;
  /**
   * True when the cluster has at least one internal edge (files actually
   * import each other). False clusters are pure directory groups with no
   * connectivity — useful for rendering at a lower visual prominence.
   */
  isStructural: boolean;
}

/**
 * Complete dependency graph result
 */
export interface DependencyGraphResult {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  /** All clusters (structural + directory groups). Use the `isStructural` flag to filter. */
  clusters: FileCluster[];
  /** Only clusters with internalEdges > 0 — worth highlighting visually */
  structuralClusters: FileCluster[];
  rankings: {
    byImportance: string[];
    byConnectivity: string[];
    clusterCenters: string[];
    leafNodes: string[];
    bridgeNodes: string[];
    orphanNodes: string[];
  };
  cycles: string[][];
  statistics: {
    nodeCount: number;
    edgeCount: number;
    /** Edges derived from static imports */
    importEdgeCount: number;
    /** Edges derived from HTTP call→route matching */
    httpEdgeCount: number;
    avgDegree: number;
    density: number;
    /** Total clusters including directory-only groups */
    clusterCount: number;
    /** Clusters with at least one internal edge */
    structuralClusterCount: number;
    cycleCount: number;
  };
}

/**
 * Options for building the dependency graph
 */
export interface DependencyGraphOptions {
  /** Root directory of the project */
  rootDir: string;
  /** File extensions to consider for import resolution */
  extensions?: string[];
  /** Minimum cluster size to report */
  minClusterSize?: number;
  /** PageRank damping factor */
  dampingFactor?: number;
  /** Maximum PageRank iterations */
  maxIterations?: number;
}

// ============================================================================
// DEPENDENCY GRAPH BUILDER
// ============================================================================

/**
 * Compute the outgoing dependency edges for a single file from its parsed
 * imports. The canonical edge-resolution logic, shared by the full-build
 * `buildEdges` and the watcher's incremental `dependency-graph.json` update so
 * the two can never drift. Pure: resolves each import against `fileSet` and
 * returns the edges; the caller owns adjacency/state.
 *
 * @param fromAbs    absolute path of the importing file (edge source)
 * @param analysis   the file's parsed imports/exports (FileAnalysis)
 * @param fileSet    absolute paths of all files that are nodes in the graph
 * @param rootDir    project root, used as the import-resolution base
 * @param extensions optional resolver extension override (undefined = defaults)
 */
export async function computeFileImportEdges(
  fromAbs: string,
  analysis: FileAnalysis,
  fileSet: Set<string>,
  rootDir: string,
  extensions?: string[],
): Promise<DependencyEdge[]> {
  const isPythonFile = fromAbs.endsWith('.py') || fromAbs.endsWith('.pyw');
  const isJavaFile = fromAbs.endsWith('.java');
  const edges: DependencyEdge[] = [];

  for (const imp of analysis.imports) {
    // Skip non-relative imports for JS/TS (always npm packages). Python and Java
    // must NOT skip: `from services.retriever import X` / absolute class FQNs may
    // resolve to a local module.
    if (!imp.isRelative && !isPythonFile && !isJavaFile) continue;
    // Skip builtins / third-party that can't resolve to a project file.
    if (!imp.isRelative && imp.isBuiltin) continue;

    const resolvedPath = await resolveImport(imp.source, fromAbs, {
      baseDir: rootDir,
      extensions,
      sourcePackage: isJavaFile ? analysis.javaPackage : undefined,
    });
    if (!resolvedPath || !fileSet.has(resolvedPath)) continue;

    const edge: DependencyEdge = {
      source: fromAbs,
      target: resolvedPath,
      importedNames: imp.importedNames,
      isTypeOnly: imp.isTypeOnly,
      weight: imp.isTypeOnly ? 0.5 : 1,
    };
    // Carry the HTML asset label (script / stylesheet) onto the edge.
    if (imp.assetKind) edge.assetKind = imp.assetKind;
    edges.push(edge);
  }

  return edges;
}

/**
 * Normalize a cycle to a rotation-invariant key: drop the repeated closing node, rotate so the
 * lexicographically smallest node is first, join. Two rotations of the same cycle map to one key.
 */
function normalizeCycleKey(cycle: string[]): string {
  const clean = cycle.slice(0, -1); // remove the duplicate closing element
  if (clean.length === 0) return '';
  const minIdx = clean.indexOf(clean.reduce((min, curr) => (curr < min ? curr : min)));
  return [...clean.slice(minIdx), ...clean.slice(0, minIdx)].join('|');
}

/**
 * Detect cycles in a directed graph via DFS back-edges — ITERATIVELY, with an explicit frame stack.
 *
 * A recursive DFS here is a latent process-abort: on a repository with a long import/dependency
 * chain the recursion depth equals the chain length, and a chain of a few thousand files overflows
 * the JS call stack with `RangeError: Maximum call stack size exceeded`, aborting `analyze` for the
 * whole repository (issue #302 follow-up: no fatal crash for any repo shape; same lesson as the
 * iterative parse-health walk and the iterative Tarjan SCC in condensation.ts).
 *
 * Output is IDENTICAL to the previous recursive implementation: each frame remembers its position
 * in its neighbor list, so nodes are entered and exited in the exact same order, back-edges are
 * detected at the same points, and the same cycles are recorded in the same order. Deduplication is
 * by rotation-invariant key through a Set — the same result the previous pairwise scan produced,
 * without its O(cycles²) cost on a graph with many cycles.
 */
export function detectDependencyCycles(
  adjacencyList: ReadonlyMap<string, ReadonlySet<string>>,
  nodeIds: Iterable<string>,
): string[][] {
  const cycles: string[][] = [];
  const seenKeys = new Set<string>();
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  interface Frame { node: string; neighbors: string[]; index: number; }

  // Mark a node on entry (exactly as the recursion did at function entry) and build its frame.
  const enter = (node: string): Frame => {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);
    return { node, neighbors: [...(adjacencyList.get(node) ?? [])], index: 0 };
  };

  for (const rootId of nodeIds) {
    if (visited.has(rootId)) continue;
    const stack: Frame[] = [enter(rootId)];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index < frame.neighbors.length) {
        const neighbor = frame.neighbors[frame.index++];
        if (!visited.has(neighbor)) {
          stack.push(enter(neighbor)); // descend — equivalent to the recursive call
        } else if (recursionStack.has(neighbor)) {
          // Back-edge: the neighbor is on the current path, so path[cycleStart..] is a cycle.
          const cycle = path.slice(path.indexOf(neighbor));
          cycle.push(neighbor); // complete the cycle
          const key = normalizeCycleKey(cycle);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            cycles.push(cycle);
          }
        }
      } else {
        // Neighbors exhausted — leave the node, exactly as the recursion did on return.
        path.pop();
        recursionStack.delete(frame.node);
        stack.pop();
      }
    }
  }

  return cycles;
}

/**
 * Builds and analyzes a dependency graph from scored files
 */
export class DependencyGraphBuilder {
  private nodes: Map<string, DependencyNode> = new Map();
  private edges: DependencyEdge[] = [];
  private adjacencyList: Map<string, Set<string>> = new Map();
  private reverseAdjacencyList: Map<string, Set<string>> = new Map();
  private httpEdgeCount = 0;
  private parser: ImportExportParser;
  private options: Required<DependencyGraphOptions>;

  constructor(options: DependencyGraphOptions) {
    this.parser = new ImportExportParser();
    this.options = {
      rootDir: options.rootDir,
      extensions: options.extensions ?? [],  // empty = auto-detect per file in resolveImport
      minClusterSize: options.minClusterSize ?? 2,
      dampingFactor: options.dampingFactor ?? PAGERANK_DAMPING_FACTOR,
      maxIterations: options.maxIterations ?? PAGERANK_MAX_ITERATIONS,
    };
  }

  /**
   * Build the dependency graph from scored files
   */
  async build(files: ScoredFile[]): Promise<DependencyGraphResult> {
    // Clear any previous state
    this.nodes.clear();
    this.edges = [];
    this.adjacencyList.clear();
    this.reverseAdjacencyList.clear();
    this.httpEdgeCount = 0;

    // Parse all files and create nodes
    const analyses = await this.parseFiles(files);

    // Create nodes for each file
    for (const file of files) {
      const analysis = analyses.get(file.absolutePath);
      this.nodes.set(file.absolutePath, {
        id: file.absolutePath,
        file,
        exports: analysis?.exports ?? [],
        metrics: {
          inDegree: 0,
          outDegree: 0,
          betweenness: 0,
          pageRank: 1 / files.length,
        },
      });
      this.adjacencyList.set(file.absolutePath, new Set());
      this.reverseAdjacencyList.set(file.absolutePath, new Set());
    }

    // Create edges from imports
    await this.buildEdges(files, analyses);

    // Create cross-language edges from HTTP calls (fetch/axios → FastAPI routes)
    await this.buildHttpCrossEdges(files);

    // Calculate metrics
    this.calculateDegrees();
    this.calculateBetweenness();
    this.calculatePageRank();

    // Detect clusters
    const clusters = this.detectClusters();

    // Assign clusters to nodes
    const clusterByNode: Record<string, { id: string; name: string; color: string }> = {};
    clusters.forEach((cl) => {
      cl.files.forEach((fid) => {
        clusterByNode[fid] = { id: cl.id, name: cl.name, color: cl.color };
      });
    });
    for (const [id, node] of this.nodes) {
      node.cluster = clusterByNode[id];
    }

    // Detect cycles
    const cycles = this.detectCycles();

    // Generate rankings
    const rankings = this.generateRankings(clusters);

    // Calculate statistics
    const statistics = this.calculateStatistics(clusters, cycles);

    const structuralClusters = clusters.filter(c => c.isStructural);

    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      clusters,
      structuralClusters,
      rankings,
      cycles,
      statistics,
    };
  }

  /**
   * Parse all files to extract imports/exports
   */
  private async parseFiles(files: ScoredFile[]): Promise<Map<string, FileAnalysis>> {
    const analyses = new Map<string, FileAnalysis>();

    for (const file of files) {
      try {
        const analysis = await this.parser.parseFile(file.absolutePath);
        analyses.set(file.absolutePath, analysis);
      } catch (error) {
        // File couldn't be parsed (binary, syntax error, etc.) — skip it
        if (process.env.DEBUG) {
          console.debug(`[dep-graph] Failed to parse ${file.absolutePath}: ${(error as Error).message}`);
        }
      }
    }

    return analyses;
  }

  /**
   * Build cross-language edges by matching HTTP calls in JS/TS files to
   * FastAPI/Flask/Django route definitions in Python files.
   * Only creates edges between files that are already nodes in the graph.
   */
  private async buildHttpCrossEdges(files: ScoredFile[]): Promise<void> {
    const fileSet = new Set(files.map(f => f.absolutePath));
    const filePaths = Array.from(fileSet);

    // Skip HTTP edge detection entirely when there cannot be any cross-language
    // edges: we need at least one caller file AND at least one handler file.
    // Callers are JS/TS. Handlers can be Python, Java, or TS/JS (server-side).
    const jsExts = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
    const pyExts = new Set(['.py', '.pyw']);
    const hasJs = filePaths.some(fp => jsExts.has(fp.slice(fp.lastIndexOf('.')).toLowerCase()));
    const hasHandler = filePaths.some(fp => {
      const ext = fp.slice(fp.lastIndexOf('.')).toLowerCase();
      return pyExts.has(ext) || ext === '.java';
    });
    if (!hasJs || !hasHandler) return;

    const { edges: httpEdges } = await extractAllHttpEdges(filePaths);

    for (const httpEdge of httpEdges) {
      // Both ends must be known nodes
      if (!fileSet.has(httpEdge.callerFile) || !fileSet.has(httpEdge.handlerFile)) continue;
      // Skip self-loops
      if (httpEdge.callerFile === httpEdge.handlerFile) continue;

      // Weight by confidence: exact=1.0, path=0.75, fuzzy=0.5
      const weight =
        httpEdge.confidence === 'exact' ? 1.0 :
        httpEdge.confidence === 'path'  ? 0.75 : 0.5;

      const edge: DependencyEdge = {
        source: httpEdge.callerFile,
        target: httpEdge.handlerFile,
        importedNames: [httpEdge.route.handlerName],
        isTypeOnly: false,
        weight,
        httpEdge,
      };

      this.edges.push(edge);
      this.httpEdgeCount++;
      this.adjacencyList.get(httpEdge.callerFile)?.add(httpEdge.handlerFile);
      this.reverseAdjacencyList.get(httpEdge.handlerFile)?.add(httpEdge.callerFile);
    }
  }

  /**
   * Build edges from import relationships
   */
  private async buildEdges(
    files: ScoredFile[],
    analyses: Map<string, FileAnalysis>
  ): Promise<void> {
    const fileSet = new Set(files.map(f => f.absolutePath));

    for (const file of files) {
      const analysis = analyses.get(file.absolutePath);
      if (!analysis) continue;

      const edges = await computeFileImportEdges(
        file.absolutePath,
        analysis,
        fileSet,
        this.options.rootDir,
        this.options.extensions.length > 0 ? this.options.extensions : undefined,
      );
      for (const edge of edges) {
        this.edges.push(edge);
        // Update adjacency lists
        this.adjacencyList.get(file.absolutePath)?.add(edge.target);
        this.reverseAdjacencyList.get(edge.target)?.add(file.absolutePath);
      }
    }
  }

  /**
   * Calculate in-degree and out-degree for each node
   */
  private calculateDegrees(): void {
    for (const [nodeId, node] of this.nodes) {
      node.metrics.outDegree = this.adjacencyList.get(nodeId)?.size ?? 0;
      node.metrics.inDegree = this.reverseAdjacencyList.get(nodeId)?.size ?? 0;
    }
  }

  /**
   * Calculate betweenness centrality using Brandes' algorithm
   */
  private calculateBetweenness(): void {
    const nodeIds = Array.from(this.nodes.keys());
    const betweenness = new Map<string, number>();

    // Initialize betweenness to 0
    for (const id of nodeIds) {
      betweenness.set(id, 0);
    }

    // Brandes' algorithm
    for (const source of nodeIds) {
      const stack: string[] = [];
      const predecessors = new Map<string, string[]>();
      const sigma = new Map<string, number>();
      const distance = new Map<string, number>();
      const delta = new Map<string, number>();

      // Initialize
      for (const v of nodeIds) {
        predecessors.set(v, []);
        sigma.set(v, 0);
        distance.set(v, -1);
        delta.set(v, 0);
      }

      sigma.set(source, 1);
      distance.set(source, 0);

      // BFS
      const queue: string[] = [source];
      while (queue.length > 0) {
        const v = queue.shift()!;
        stack.push(v);

        const neighbors = this.adjacencyList.get(v) ?? new Set();
        for (const w of neighbors) {
          // First visit?
          if (distance.get(w)! < 0) {
            queue.push(w);
            distance.set(w, distance.get(v)! + 1);
          }
          // Shortest path to w via v?
          if (distance.get(w) === distance.get(v)! + 1) {
            sigma.set(w, sigma.get(w)! + sigma.get(v)!);
            predecessors.get(w)!.push(v);
          }
        }
      }

      // Back-propagation
      while (stack.length > 0) {
        const w = stack.pop()!;
        for (const v of predecessors.get(w)!) {
          delta.set(
            v,
            delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!)
          );
        }
        if (w !== source) {
          betweenness.set(w, betweenness.get(w)! + delta.get(w)!);
        }
      }
    }

    // Normalize and update nodes
    const maxBetweenness = Array.from(betweenness.values()).reduce((a, b) => Math.max(a, b), 1);
    for (const [nodeId, node] of this.nodes) {
      node.metrics.betweenness = betweenness.get(nodeId)! / maxBetweenness;
    }
  }

  /**
   * Calculate PageRank-style importance scores
   */
  private calculatePageRank(): void {
    const nodeIds = Array.from(this.nodes.keys());
    const n = nodeIds.length;
    if (n === 0) return;

    const d = this.options.dampingFactor;
    let pageRank = new Map<string, number>();
    let newPageRank = new Map<string, number>();

    // Initialize
    for (const id of nodeIds) {
      pageRank.set(id, 1 / n);
    }

    // Iterate until convergence
    for (let iter = 0; iter < this.options.maxIterations; iter++) {
      let maxDiff = 0;

      for (const id of nodeIds) {
        // Sum contributions from nodes that link to this one
        let sum = 0;
        const incomingNodes = this.reverseAdjacencyList.get(id) ?? new Set();
        for (const source of incomingNodes) {
          const outDegree = this.adjacencyList.get(source)?.size ?? 1;
          sum += pageRank.get(source)! / outDegree;
        }

        const newRank = (1 - d) / n + d * sum;
        newPageRank.set(id, newRank);
        maxDiff = Math.max(maxDiff, Math.abs(newRank - pageRank.get(id)!));
      }

      // Swap
      [pageRank, newPageRank] = [newPageRank, pageRank];

      // Check convergence
      if (maxDiff < PAGERANK_CONVERGENCE_TOLERANCE) break;
    }

    // Normalize and update nodes
    const maxPageRank = Array.from(pageRank.values()).reduce((a, b) => Math.max(a, b), 0.001);
    for (const [nodeId, node] of this.nodes) {
      node.metrics.pageRank = pageRank.get(nodeId)! / maxPageRank;
    }
  }

  /**
   * Detect clusters using a simple community detection approach
   * Groups files by their common directory prefix and connectivity
   */
  private detectClusters(): FileCluster[] {
    const clusters: FileCluster[] = [];
    const nodeIds = Array.from(this.nodes.keys());

    // Group by directory
    const dirGroups = new Map<string, string[]>();
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId)!;
      const dir = node.file.directory || '(root)';

      if (!dirGroups.has(dir)) {
        dirGroups.set(dir, []);
      }
      dirGroups.get(dir)!.push(nodeId);
    }

    // Create clusters from directory groups
    let clusterId = 0;
    for (const [dir, files] of dirGroups) {
      if (files.length < this.options.minClusterSize) continue;

      // Calculate internal and external edges
      let internalEdges = 0;
      let externalEdges = 0;
      const fileSet = new Set(files);

      for (const edge of this.edges) {
        const sourceInCluster = fileSet.has(edge.source);
        const targetInCluster = fileSet.has(edge.target);

        if (sourceInCluster && targetInCluster) {
          internalEdges++;
        } else if (sourceInCluster || targetInCluster) {
          externalEdges++;
        }
      }

      // Calculate cohesion (internal density)
      const possibleInternalEdges = files.length * (files.length - 1);
      const cohesion = possibleInternalEdges > 0 ? internalEdges / possibleInternalEdges : 0;

      // Calculate coupling (external connections)
      const totalEdges = internalEdges + externalEdges;
      const coupling = totalEdges > 0 ? externalEdges / totalEdges : 0;

      // Generate suggested domain name
      const suggestedDomain = this.suggestDomainName(dir, files);

      clusters.push({
        id: `cluster-${clusterId}`,
        name: dir,
        files,
        internalEdges,
        externalEdges,
        cohesion,
        coupling,
        suggestedDomain,
        color: CLUSTER_PALETTE[clusterId++ % CLUSTER_PALETTE.length],
        isStructural: internalEdges > 0,
      });
    }

    return clusters;
  }

  /**
   * Suggest a domain name based on directory and file contents
   */
  private suggestDomainName(dir: string, files: string[]): string {
    // Walk the directory path leaf-first, skipping build-layout / reverse-DNS
    // package noise, via the shared helper so cluster domains stay in lockstep
    // with repository-mapper's inferred domains (issue #138).
    const parts = dir.split('/').filter(p => p && p !== '(root)');
    const derived = deriveDomainFromPath(parts);
    if (derived) {
      return derived;
    }

    // Fallback: derive from the first file's name (any language extension)
    if (files.length > 0) {
      const firstFile = this.nodes.get(files[0])?.file.name ?? 'unknown';
      return firstFile.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '-');
    }

    return 'misc';
  }

  /**
   * Detect cycles in the dependency graph. Delegates to the module-level iterative implementation
   * so a deep import chain cannot overflow the call stack (see {@link detectDependencyCycles}).
   */
  private detectCycles(): string[][] {
    return detectDependencyCycles(this.adjacencyList, this.nodes.keys());
  }

  /**
   * Generate various rankings of nodes
   */
  private generateRankings(clusters: FileCluster[]): DependencyGraphResult['rankings'] {
    const nodes = Array.from(this.nodes.values());

    // By PageRank importance — use .slice() to avoid mutating the shared array
    const byImportance = nodes
      .slice()
      .sort((a, b) => b.metrics.pageRank - a.metrics.pageRank)
      .map(n => n.id);

    // By total connectivity (in + out degree)
    const byConnectivity = nodes
      .slice()
      .sort((a, b) =>
        (b.metrics.inDegree + b.metrics.outDegree) -
        (a.metrics.inDegree + a.metrics.outDegree)
      )
      .map(n => n.id);

    // Cluster centers (highest in-degree within each cluster)
    const clusterCenters: string[] = [];
    for (const cluster of clusters) {
      const clusterNodes = cluster.files
        .map(f => this.nodes.get(f))
        .filter((n): n is DependencyNode => n !== undefined);

      if (clusterNodes.length > 0) {
        const center = clusterNodes.reduce((max, n) =>
          n.metrics.inDegree > max.metrics.inDegree ? n : max
        );
        clusterCenters.push(center.id);
      }
    }

    // Leaf nodes (high out-degree, low in-degree)
    const leafNodes = nodes
      .filter(n => n.metrics.outDegree > 0 && n.metrics.inDegree === 0)
      .sort((a, b) => b.metrics.outDegree - a.metrics.outDegree)
      .map(n => n.id);

    // Bridge nodes (high betweenness)
    const bridgeNodes = nodes
      .filter(n => n.metrics.betweenness > 0.1)
      .sort((a, b) => b.metrics.betweenness - a.metrics.betweenness)
      .map(n => n.id);

    // Orphan nodes (no connections)
    const orphanNodes = nodes
      .filter(n => n.metrics.inDegree === 0 && n.metrics.outDegree === 0)
      .map(n => n.id);

    return {
      byImportance,
      byConnectivity,
      clusterCenters,
      leafNodes,
      bridgeNodes,
      orphanNodes,
    };
  }

  /**
   * Calculate overall statistics
   */
  private calculateStatistics(
    clusters: FileCluster[],
    cycles: string[][]
  ): DependencyGraphResult['statistics'] {
    const nodeCount = this.nodes.size;
    const edgeCount = this.edges.length;

    // Average degree
    let totalDegree = 0;
    for (const node of this.nodes.values()) {
      totalDegree += node.metrics.inDegree + node.metrics.outDegree;
    }
    const avgDegree = nodeCount > 0 ? totalDegree / nodeCount : 0;

    // Density: actual edges / possible edges
    const possibleEdges = nodeCount * (nodeCount - 1);
    const density = possibleEdges > 0 ? edgeCount / possibleEdges : 0;

    return {
      nodeCount,
      edgeCount,
      importEdgeCount: edgeCount - this.httpEdgeCount,
      httpEdgeCount: this.httpEdgeCount,
      avgDegree,
      density,
      clusterCount: clusters.length,
      structuralClusterCount: clusters.filter(c => c.isStructural).length,
      cycleCount: cycles.length,
    };
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Build a dependency graph from scored files
 */
export async function buildDependencyGraph(
  files: ScoredFile[],
  options: DependencyGraphOptions
): Promise<DependencyGraphResult> {
  const builder = new DependencyGraphBuilder(options);
  return builder.build(files);
}

// ============================================================================
// CALL-GRAPH EDGE INJECTION
// ============================================================================

/**
 * Languages that share a module-level namespace without explicit intra-file imports.
 * For these, dependency edges must be derived from the call graph rather than imports.
 */
const IMPLICIT_IMPORT_LANGS = new Set(['Swift', 'C++', 'C']);

/**
 * Languages that DO use explicit imports for cross-package references but need
 * NO import for same-package classes (JVM package semantics). Their dependency
 * graph would otherwise show only the sparse cross-package import edges and miss
 * every same-package relationship — so call-graph edges are injected (deduped
 * against existing import edges) regardless of the import-edge count. See #138.
 */
const SAME_PACKAGE_IMPLICIT_LANGS = new Set(['Java', 'Kotlin']);

/**
 * Synthesize dependency edges from cross-file call edges and inject them into
 * an existing DependencyGraphResult in-place.
 *
 * Use this for languages like Swift or C++ that don't have explicit intra-module
 * imports, resulting in an empty dep graph when only import-based edges are built.
 */
export function injectCallGraphEdges(
  depGraph: DependencyGraphResult,
  callEdges: Array<{ callerId: string; calleeId: string }>,
  nodeFilePath: (id: string) => string | undefined,
): void {
  // Build a Set of node IDs for quick membership test
  const nodeIds = new Set(depGraph.nodes.map(n => n.id));

  // Collect unique file-level edges. Seed `seen` with the file pairs that
  // already have an edge (e.g. cross-package imports) so injected call edges
  // never duplicate an existing import edge — this makes injection safe to run
  // for languages that mix explicit imports with implicit same-package refs
  // (Java/Kotlin), not just import-less languages (Swift/C/C++).
  const seen = new Set<string>(depGraph.edges.map(e => `${e.source}→${e.target}`));
  const newEdges: DependencyEdge[] = [];

  for (const ce of callEdges) {
    const callerFile = nodeFilePath(ce.callerId);
    const calleeFile = nodeFilePath(ce.calleeId);
    if (!callerFile || !calleeFile || callerFile === calleeFile) continue;
    if (!nodeIds.has(callerFile) || !nodeIds.has(calleeFile)) continue;
    const key = `${callerFile}→${calleeFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    newEdges.push({ source: callerFile, target: calleeFile, importedNames: [], isTypeOnly: false, weight: 1, isCallEdge: true });
  }

  if (newEdges.length === 0) return;

  depGraph.edges.push(...newEdges);

  // Recompute node in/out degrees
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of depGraph.edges) {
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  for (const node of depGraph.nodes) {
    node.metrics.inDegree = inDeg.get(node.id) ?? 0;
    node.metrics.outDegree = outDeg.get(node.id) ?? 0;
  }

  // Update statistics
  depGraph.statistics.edgeCount = depGraph.edges.length;
  const totalDegree = depGraph.nodes.reduce((s, n) => s + n.metrics.inDegree + n.metrics.outDegree, 0);
  depGraph.statistics.avgDegree = depGraph.nodes.length > 0 ? totalDegree / depGraph.nodes.length : 0;
  const possible = depGraph.statistics.nodeCount * (depGraph.statistics.nodeCount - 1);
  depGraph.statistics.density = possible > 0 ? depGraph.statistics.edgeCount / possible : 0;

  // Recompute cluster internalEdges and rebuild structuralClusters.
  // Without this, the viewer's cluster view stays empty even when edges exist.
  const fileToCluster = new Map<string, string>();
  for (const cl of depGraph.clusters) {
    for (const fid of cl.files) fileToCluster.set(fid, cl.id);
  }
  const clusterInternalEdges = new Map<string, number>();
  for (const e of depGraph.edges) {
    const sc = fileToCluster.get(e.source);
    const tc = fileToCluster.get(e.target);
    if (sc && sc === tc) clusterInternalEdges.set(sc, (clusterInternalEdges.get(sc) ?? 0) + 1);
  }
  for (const cl of depGraph.clusters) {
    cl.internalEdges = clusterInternalEdges.get(cl.id) ?? 0;
    cl.isStructural = cl.internalEdges > 0;
  }
  depGraph.structuralClusters = depGraph.clusters.filter(cl => cl.internalEdges > 0);
  depGraph.statistics.structuralClusterCount = depGraph.structuralClusters.length;
}

export { IMPLICIT_IMPORT_LANGS, SAME_PACKAGE_IMPLICIT_LANGS };

// ============================================================================
// EXPORT FORMATS
// ============================================================================

/**
 * Convert graph to D3.js force graph format
 */
export function toD3Format(result: DependencyGraphResult): {
  nodes: Array<{ id: string; group: number; score: number }>;
  links: Array<{ source: string; target: string; value: number }>;
} {
  // Use only structural clusters for group colouring — directory-only
  // clusters (cohesion=0) would produce too many indistinct colour groups.
  const clusterIndex = new Map<string, number>();
  result.structuralClusters.forEach((cluster, idx) => {
    for (const file of cluster.files) {
      clusterIndex.set(file, idx);
    }
  });

  return {
    nodes: result.nodes.map(n => ({
      id: n.file.path,
      group: clusterIndex.get(n.id) ?? -1,
      score: n.metrics.pageRank,
    })),
    links: result.edges.map(e => ({
      source: result.nodes.find(n => n.id === e.source)?.file.path ?? e.source,
      target: result.nodes.find(n => n.id === e.target)?.file.path ?? e.target,
      value: e.weight,
    })),
  };
}

/**
 * Convert graph to Mermaid diagram syntax
 */
export function toMermaidFormat(result: DependencyGraphResult, maxNodes = 50): string {
  const lines: string[] = ['graph TD'];

  // Take top nodes by importance
  const topNodes = result.rankings.byImportance.slice(0, maxNodes);
  const nodeSet = new Set(topNodes);

  // Create node labels
  const nodeLabels = new Map<string, string>();
  result.nodes
    .filter(n => nodeSet.has(n.id))
    .forEach((n, idx) => {
      const label = `N${idx}`;
      nodeLabels.set(n.id, label);
      const name = n.file.name.replace(/["[\]]/g, '');
      lines.push(`    ${label}["${name}"]`);
    });

  // Create edges
  for (const edge of result.edges) {
    const sourceLabel = nodeLabels.get(edge.source);
    const targetLabel = nodeLabels.get(edge.target);
    if (sourceLabel && targetLabel) {
      const style = edge.isTypeOnly ? '-.->' : '-->';
      lines.push(`    ${sourceLabel} ${style} ${targetLabel}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert graph to DOT format (Graphviz)
 */
export function toDotFormat(result: DependencyGraphResult): string {
  const lines: string[] = ['digraph Dependencies {'];
  lines.push('    rankdir=LR;');
  lines.push('    node [shape=box];');

  // Every value below is a repository-derived path or symbol name interpolated into a
  // double-quoted DOT string, so all of them go through the same escape. Escaping only
  // the visible label (the previous behaviour) left the node/edge ids able to terminate
  // their own quoted string and corrupt the rest of the graph.
  for (const node of result.nodes) {
    const name = escapeDotString(node.file.name);
    const color = node.metrics.pageRank > 0.5 ? 'lightblue' : 'white';
    lines.push(
      `    "${escapeDotString(node.id)}" [label="${name}" fillcolor="${color}" style="filled"];`
    );
  }

  // Create edges
  for (const edge of result.edges) {
    const style = edge.isTypeOnly ? 'dashed' : 'solid';
    lines.push(
      `    "${escapeDotString(edge.source)}" -> "${escapeDotString(edge.target)}" [style="${style}"];`
    );
  }

  lines.push('}');
  return lines.join('\n');
}
