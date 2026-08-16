/**
 * End-to-end integration tests for openloreVerify()
 *
 * These tests drive the full public API — openloreVerify() — with a real
 * project directory on disk. The only mock is createLLMService(), which is
 * swapped for a MockLLMProvider to avoid live network calls. Everything else
 * is real: config loading, dep graph loading, candidate selection, scoring,
 * and report writing.
 *
 * Run with: vitest --config vitest.integration.config.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openloreVerify } from './verify.js';
import { MockLLMProvider, LLMService } from '../core/services/llm-service.js';

// Only createLLMService is mocked — everything else (fs, config, scoring) is real.
vi.mock('../core/services/llm-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/services/llm-service.js')>();
  return {
    ...actual,
    createLLMService: vi.fn(),
  };
});

vi.mock('../../utils/logger.js', () => ({
  default: {
    discovery: vi.fn(), analysis: vi.fn(), success: vi.fn(),
    warning: vi.fn(), error: vi.fn(), info: vi.fn(), blank: vi.fn(), debug: vi.fn(),
  },
}));

import { createLLMService } from '../core/services/llm-service.js';
const mockCreateLLMService = vi.mocked(createLLMService);

// ============================================================================
// FIXTURE BUILDERS
// ============================================================================

/**
 * Minimal openlore config written to .openlore/config.json
 */
const OPENLORE_CONFIG = {
  version: '1.0.0',
  projectType: 'nodejs',
  openspecPath: './openspec',
  analysis: { maxFiles: 100, includePatterns: ['**/*.ts'], excludePatterns: [] },
  generation: { domains: ['payment', 'auth'] },
  createdAt: new Date().toISOString(),
  lastRun: null,
};

/**
 * Build a minimal DependencyGraphResult that references source files in the project.
 */
function buildDepGraph(files: Array<{ path: string; absolutePath: string; lines: number; inDegree?: number; outDegree?: number }>) {
  const nodes = files.map(f => ({
    id: f.path,
    file: {
      path: f.path,
      absolutePath: f.absolutePath,
      name: f.path.split('/').pop(),
      extension: '.ts',
      size: f.lines * 50,
      lines: f.lines,
      depth: 2,
      directory: f.path.split('/').slice(0, -1).join('/'),
      isEntryPoint: false,
      isConfig: false,
      isTest: false,
      isGenerated: false,
      score: 5,
      scoreBreakdown: { name: 1, path: 1, structure: 1, connectivity: 2 },
      tags: [],
    },
    exports: [{ name: 'default', isDefault: true, isType: false, isReExport: false, kind: 'class', line: 1 }],
    metrics: {
      inDegree: f.inDegree ?? 3,
      outDegree: f.outDegree ?? 3,
      betweenness: 0.1,
      pageRank: 0.5,
    },
  }));

  return {
    nodes,
    edges: [],
    clusters: [],
    structuralClusters: [],
    rankings: {
      byImportance: files.map(f => f.path),
      byConnectivity: files.map(f => f.path),
      clusterCenters: [],
      leafNodes: [],
      bridgeNodes: [],
      orphanNodes: [],
    },
    cycles: [],
    statistics: {
      nodeCount: files.length, edgeCount: 0, importEdgeCount: 0, httpEdgeCount: 0,
      avgDegree: 3, density: 0.2, clusterCount: 1, structuralClusterCount: 0, cycleCount: 0,
    },
  };
}

const PAYMENT_SPEC = `# Payment Domain

## Purpose

Processes payment transactions and manages billing and refunds.

## Requirements

### PaymentProcessing
The system SHALL process payments via Stripe.

### RefundHandling
The system SHALL support full refunds.
`;

const AUTH_SPEC = `# Auth Domain

## Purpose

Handles user authentication, login/logout, and session token management.

## Requirements

### UserLogin
The system SHALL authenticate users with email and password.
`;

const PAYMENT_SERVICE_SRC = `/**
 * Payment Service
 *
 * Processes payment transactions, manages billing and refund operations.
 */

import { database } from './database.js';
import { stripe } from './stripe-client.js';

export interface Payment { id: string; amount: number; currency: string; }

export class PaymentService {
  async charge(amount: number, currency: string): Promise<Payment> {
    return stripe.createCharge({ amount, currency });
  }
  async refund(paymentId: string): Promise<void> {
    await stripe.refund(paymentId);
    await database.markRefunded(paymentId);
  }
}

export function createPaymentService(): PaymentService {
  return new PaymentService();
}
`.repeat(3); // repeat to exceed minComplexity line count

// Auth service: docblock placed after a long import block (tests fix #2)
const LATE_IMPORTS = Array.from({ length: 36 }, (_, i) => `import { m${i} } from './mod${i}.js';`).join('\n');
const AUTH_SERVICE_SRC = `${LATE_IMPORTS}

/**
 * Auth Service
 *
 * Handles user authentication and session management.
 */

export class AuthService {
  async login(email: string, password: string): Promise<string> { return 'token'; }
  async logout(token: string): Promise<void> {}
}
export function createAuthService(): AuthService { return new AuthService(); }
`.repeat(2);

// ============================================================================
// SETUP / TEARDOWN
// ============================================================================

describe('openloreVerify — e2e via public API', () => {
  let rootDir: string;
  let mockProvider: MockLLMProvider;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `openlore-api-e2e-${Date.now()}`);

    // Directory structure expected by openloreVerify()
    const openloreDir     = join(rootDir, '.openlore');
    const analysisDir    = join(openloreDir, 'analysis');
    const outputsDir     = join(openloreDir, 'outputs');
    const paymentSpecDir = join(rootDir, 'openspec', 'specs', 'payment');
    const authSpecDir    = join(rootDir, 'openspec', 'specs', 'auth');
    const srcPaymentDir  = join(rootDir, 'src', 'payment');
    const srcAuthDir     = join(rootDir, 'src', 'auth');

    await Promise.all([
      mkdir(analysisDir,    { recursive: true }),
      mkdir(outputsDir,     { recursive: true }),
      mkdir(paymentSpecDir, { recursive: true }),
      mkdir(authSpecDir,    { recursive: true }),
      mkdir(srcPaymentDir,  { recursive: true }),
      mkdir(srcAuthDir,     { recursive: true }),
    ]);

    // Write config
    await writeFile(join(openloreDir, 'config.json'), JSON.stringify(OPENLORE_CONFIG));

    // Write specs
    await writeFile(join(paymentSpecDir, 'spec.md'), PAYMENT_SPEC);
    await writeFile(join(authSpecDir,    'spec.md'), AUTH_SPEC);

    // Write source files
    const paymentSrcPath = join(srcPaymentDir, 'payment-service.ts');
    const authSrcPath    = join(srcAuthDir,    'auth-service.ts');
    await writeFile(paymentSrcPath, PAYMENT_SERVICE_SRC);
    await writeFile(authSrcPath,    AUTH_SERVICE_SRC);

    // Write dependency graph (what openloreAnalyze() would produce)
    const depGraph = buildDepGraph([
      { path: 'src/payment/payment-service.ts', absolutePath: paymentSrcPath, lines: PAYMENT_SERVICE_SRC.split('\n').length },
      { path: 'src/auth/auth-service.ts',       absolutePath: authSrcPath,    lines: AUTH_SERVICE_SRC.split('\n').length },
    ]);
    await writeFile(join(analysisDir, 'dependency-graph.json'), JSON.stringify(depGraph));

    // Write generation report (optional — omitting it is also valid, but include for realism)
    await writeFile(join(outputsDir, 'generation-report.json'), JSON.stringify({ filesWritten: [] }));

    // Wire up MockLLMProvider
    mockProvider = new MockLLMProvider();
    const llmService = new LLMService(mockProvider);
    mockCreateLLMService.mockReturnValue(llmService);

    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(async () => {
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.ANTHROPIC_API_KEY;
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------

  it('loads config, dep graph, and specs from disk and returns a report', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Processes payment transactions and refunds',
      predictedImports: ['database', 'stripe'],
      predictedExports: ['PaymentService', 'createPaymentService'],
      predictedLogic: ['charge', 'refund'],
      relatedRequirements: ['PaymentProcessing', 'RefundHandling'],
      confidence: 0.85,
      reasoning: 'Matches payment spec',
    }));

    const result = await openloreVerify({ rootPath: rootDir });

    expect(result.report).toBeDefined();
    expect(result.report.specVersion).toBe('1.0.0');
    expect(result.report.sampledFiles).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('scores a well-aligned file above 0 on every sub-metric', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Processes payment transactions, manages billing and refund operations',
      predictedImports: ['database', 'stripe'],
      predictedExports: ['PaymentService', 'Payment', 'createPaymentService'],
      predictedLogic: ['charge via stripe', 'refund and update database'],
      relatedRequirements: ['PaymentProcessing', 'RefundHandling'],
      confidence: 0.9,
      reasoning: 'Strong match',
    }));

    const result = await openloreVerify({ rootPath: rootDir });

    const paymentResult = result.report.results.find(r => r.filePath.includes('payment'));
    expect(paymentResult).toBeDefined();
    expect(paymentResult!.overallScore).toBeGreaterThan(0);
    expect(paymentResult!.purposeMatch.similarity).toBeGreaterThan(0);
  });

  it('extracts purpose from auth-service.ts whose JSDoc is after line 36', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Handles authentication and session management',
      predictedImports: [],
      predictedExports: ['AuthService', 'createAuthService'],
      predictedLogic: ['login', 'logout'],
      relatedRequirements: ['UserLogin'],
      confidence: 0.75,
      reasoning: 'Auth spec describes these operations',
    }));

    const result = await openloreVerify({ rootPath: rootDir });

    const authResult = result.report.results.find(r => r.filePath.includes('auth'));
    expect(authResult).toBeDefined();
    // Fix #2: purpose must be extracted even though JSDoc starts after line 36
    expect(authResult!.purposeMatch.actual).toContain('Auth Service');
    expect(authResult!.purposeMatch.similarity).toBeGreaterThan(0);
  });

  it('discloses files whose LLM prediction fails without grading them as zero', async () => {
    mockProvider.setDefaultResponse('NOT VALID JSON {{{');

    const result = await openloreVerify({ rootPath: rootDir });

    // Failed candidates are absent from scores but present in the denominator receipt.
    expect(result.report.sampledFiles).toBe(0);
    expect(result.report.results).toHaveLength(0);
    expect(result.report.attemptedFiles).toBeGreaterThan(0);
    expect(result.report.failedFiles).toBe(result.report.attemptedFiles);
    expect(result.report.failures).toHaveLength(result.report.failedFiles);
    expect(result.report.aggregateBasis).toBe('successful-files');
    expect(result.report.recommendation).not.toBe('ready');
    expect(result.report.recommendationQualification).toMatch(/could not be verified/);
    expect(result.report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const reportJson = JSON.parse(await readFile(join(rootDir, '.openlore', 'verification', 'report.json'), 'utf-8'));
    const reportMarkdown = await readFile(join(rootDir, '.openlore', 'verification', 'REPORT.md'), 'utf-8');
    expect(reportJson.failedFiles).toBe(result.report.failedFiles);
    expect(reportMarkdown).toContain('Files Failed Verification');
    expect(reportMarkdown).toContain('Verification Failures');
  });

  it('writes report.json and REPORT.md to .openlore/verification/', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Processes payments',
      predictedImports: [],
      predictedExports: ['PaymentService'],
      predictedLogic: [],
      relatedRequirements: ['PaymentProcessing'],
      confidence: 0.7,
      reasoning: 'ok',
    }));

    await openloreVerify({ rootPath: rootDir });

    const verificationDir = join(rootDir, '.openlore', 'verification');
    const jsonRaw  = await readFile(join(verificationDir, 'report.json'), 'utf-8');
    const mdRaw    = await readFile(join(verificationDir, 'REPORT.md'),   'utf-8');

    // JSON is valid and has the expected shape
    const json = JSON.parse(jsonRaw);
    expect(json).toHaveProperty('timestamp');
    expect(json).toHaveProperty('overallConfidence');
    expect(json).toHaveProperty('results');

    // Markdown contains the key sections
    expect(mdRaw).toContain('# Spec Verification Report');
    expect(mdRaw).toContain('## Summary');
    expect(mdRaw).toContain('## Domain Breakdown');
  });

  it('throws when no openlore config exists', async () => {
    const emptyDir = join(tmpdir(), `openlore-no-config-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });
    try {
      await expect(openloreVerify({ rootPath: emptyDir })).rejects.toThrow(/configuration/i);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('throws when no LLM API key is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(openloreVerify({ rootPath: rootDir })).rejects.toThrow(/API key/i);
  });

  it('throws when dep graph is missing', async () => {
    await rm(join(rootDir, '.openlore', 'analysis', 'dependency-graph.json'));
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await expect(openloreVerify({ rootPath: rootDir })).rejects.toThrow();
  });

  it('passes onProgress callbacks through the pipeline', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Processes payments',
      predictedImports: [],
      predictedExports: ['PaymentService'],
      predictedLogic: [],
      relatedRequirements: [],
      confidence: 0.7,
      reasoning: 'ok',
    }));

    const events: string[] = [];
    await openloreVerify({
      rootPath: rootDir,
      onProgress: ({ step, status }) => events.push(`${step}:${status}`),
    });

    expect(events).toContain('Loading analysis:start');
    expect(events).toContain('Loading analysis:complete');
    expect(events).toContain('Verifying specs against codebase:start');
    expect(events).toContain('Verifying specs against codebase:complete');
  });
});
