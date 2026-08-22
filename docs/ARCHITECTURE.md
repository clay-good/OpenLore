# openlore Architecture

This document describes the internal architecture of openlore.

## Overview

openlore is a CLI tool that reverse-engineers OpenSpec specifications from existing codebases. It follows a pipeline architecture with five main phases (plus an optional ADR enrichment stage):

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    Init     │ ──▶ │   Analyze   │ ──▶ │  Generate   │ ──▶ │   Verify    │     │    Drift    │
│             │     │             │     │             │     │             │     │             │
│ Project     │     │ Static      │     │ LLM-based   │     │ Accuracy    │     │ Spec-Code   │
│ Detection   │     │ Analysis    │     │ Extraction  │     │ Testing     │     │ Sync Check  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

## Module Organization

### CLI Layer (`src/cli/`)

The CLI layer handles user interaction and command-line parsing. It uses Commander.js for argument parsing and delegates all business logic to the core layer.

```
src/cli/
├── index.ts           # Main entry point, command registration, global options
└── commands/
    ├── init.ts        # Initialize configuration
    ├── analyze.ts     # Run static analysis
    ├── generate.ts    # Generate specs with LLM
    ├── verify.ts      # Verify spec accuracy
    ├── drift.ts       # Detect spec-to-code drift
    └── run.ts         # Full pipeline orchestration
```

**Global Options** (defined in `index.ts`, inherited by all commands via `optsWithGlobals()`):
- `--api-base <url>` — Custom LLM API base URL
- `--insecure` — Disable SSL certificate verification
- `--config <path>` — Path to config file
- `-q, --quiet` / `-v, --verbose` / `--no-color` — Output control

**Design Principles:**
- Commands are thin wrappers that call core modules
- No business logic in CLI layer
- Commands use `this.optsWithGlobals()` to inherit global options
- Three-tier config priority: CLI flags > environment variables > config file
- User-friendly error messages and progress indicators

### API Layer (`src/api/`)

The API layer provides a programmatic interface for external consumers (like OpenSpec CLI). Its analysis and generation entry points are facades over the same core pipelines used by the CLI, so configuration, artifacts, indexes, provider resolution, and cache semantics cannot drift between front ends.

```
src/api/
├── index.ts           # Barrel export — public API surface
├── types.ts           # Option and result type definitions
├── init.ts            # openloreInit() — project detection, config creation
├── analyze.ts         # openloreAnalyze() — shared analysis-core facade
├── generate.ts        # openloreGenerate() — shared generation-core facade
├── verify.ts          # openloreVerify() — spec accuracy testing
├── drift.ts           # openloreDrift() — spec-to-code drift detection
└── run.ts             # openloreRun() — full pipeline orchestration
```

**Design Principles:**
- No `process.exit` or `process.chdir`; logger output is request-scoped and muted by default
- Progress callbacks (`onProgress`) instead of terminal output
- Stable `OpenLoreError` codes at public failure boundaries
- Typed cache/degradation markers and discriminated dry-run results
- Optional dependencies on LLM providers (only imported when needed)

**Package exports:** `import { openloreAnalyze } from 'openlore'` imports the API; the CLI is available at `openlore/cli`.

### Core Layer (`src/core/`)

The core layer contains all business logic, organized by function:

#### Analyzer (`src/core/analyzer/`)

Static analysis modules that examine the codebase without LLM involvement:

```
analyzer/
├── file-walker.ts          # Directory traversal, ignore patterns
├── significance-scorer.ts  # File importance ranking
├── import-parser.ts        # Import/export extraction
├── dependency-graph.ts     # Graph building, metrics
├── repository-mapper.ts    # Orchestration, clustering
└── artifact-generator.ts   # Output file generation
```

**Data Flow:**
```
FileWalker ──▶ SignificanceScorer ──▶ ImportParser ──▶ DependencyGraph
                                                              │
RepositoryMapper ◀────────────────────────────────────────────┘
      │
      ▼
ArtifactGenerator ──▶ .openlore/analysis/
```

#### Generator (`src/core/generator/`)

LLM-powered specification generation:

```
generator/
├── spec-pipeline.ts            # Multi-stage LLM orchestration
├── openspec-format-generator.ts # OpenSpec markdown formatting
├── openspec-compat.ts          # OpenSpec validation
├── openspec-writer.ts          # File writing with backups
└── adr-generator.ts            # ADR markdown formatting and index
```

**Pipeline Stages:**
1. **Project Survey** - Quick categorization (~200 tokens)
2. **Entity Extraction** - Core data models (~1000 tokens)
3. **Service Analysis** - Business logic (~800 tokens)
4. **API Extraction** - HTTP endpoints (~800 tokens)
5. **Architecture Synthesis** - Overall structure (~1200 tokens)
6. **ADR Enrichment** - Architecture Decision Records (~800 tokens, optional with `--adr`)

#### Verifier (`src/core/verifier/`)

Accuracy testing for generated specifications:

```
verifier/
└── verification-engine.ts  # Prediction and comparison
```

**Verification Process:**
1. Select files NOT used in generation
2. LLM predicts file contents from specs only
3. Compare predictions to actual code
4. Calculate accuracy scores

#### Drift Detection (`src/core/drift/`)

Spec-to-code drift detection using git analysis:

```
drift/
├── drift-detector.ts      # Core drift detection engine
├── spec-mapper.ts         # Maps source files to spec domains
├── git-analyzer.ts        # Git diff parsing and change analysis
└── llm-enhancer.ts        # Optional LLM-based semantic filtering
```

**Drift Categories:**
- **Gap**: Code changed but its spec wasn't updated
- **Stale**: Spec references deleted or renamed files
- **Uncovered**: New files with no matching spec domain
- **Orphaned**: Spec declares files that no longer exist
- **ADR Gap**: Code changed in a domain referenced by an ADR (info severity)
- **ADR Orphaned**: ADR references domains that no longer exist in specs

#### Services (`src/core/services/`)

Shared services used across modules:

```
services/
├── llm-service.ts         # LLM provider abstraction (Anthropic + OpenAI)
├── config-manager.ts      # Configuration loading/saving
├── project-detector.ts    # Language/framework detection
└── gitignore-manager.ts   # Gitignore handling
```

### Types (`src/types/`)

Centralized TypeScript type definitions:

```typescript
// Core types
interface FileMetadata { ... }
interface ScoredFile extends FileMetadata { ... }
interface DependencyNode { ... }
interface DependencyEdge { ... }

// Configuration types
interface OpenLoreConfig {
  version: string;
  projectType: ProjectType;
  openspecPath: string;
  analysis: AnalysisConfig;
  generation: GenerationConfig;
  llm?: LLMConfig;           // Optional custom endpoint config
  createdAt: string;
  lastRun: string | null;
}

interface LLMConfig {
  apiBase?: string;           // Custom API base URL
  sslVerify?: boolean;        // SSL verification (default: true)
}

// Options types
interface GlobalOptions { ... }
interface InitOptions extends GlobalOptions { ... }
interface AnalyzeOptions extends GlobalOptions { ... }
interface GenerateOptions extends GlobalOptions { ... }
interface VerifyOptions extends GlobalOptions { ... }
```

### Utils (`src/utils/`)

Pure utility functions:

```
utils/
└── logger.ts  # Semantic logging with colors
```

## Key Design Decisions

### 1. Separation of Analysis and Generation

**Rationale:** Keep static analysis separate from LLM-based generation to:
- Allow analysis without API costs
- Cache and reuse analysis results
- Enable offline analysis
- Make testing easier

### 2. Multi-Stage LLM Pipeline

**Rationale:** Break LLM generation into stages to:
- Keep context focused per stage
- Allow partial results on failure
- Enable stage-specific prompts
- Control token usage

### 3. Significance Scoring

**Rationale:** Rank files by importance to:
- Prioritize high-value files for LLM context
- Stay within token limits
- Focus on business logic over utilities
- Identify domain boundaries

**Scoring Formula:**
```
Score = NameScore (0-30) + PathScore (0-25) +
        StructureScore (0-25) + ConnectivityScore (0-20)
```

### 4. Dependency Graph Analysis

**Rationale:** Build import graph to:
- Detect natural domain clusters
- Identify core vs peripheral code
- Find integration points
- Guide LLM analysis order

**Metrics Calculated:**
- In-degree / Out-degree
- PageRank-style importance
- Betweenness centrality
- Cluster cohesion/coupling

### 5. OpenSpec Compatibility Layer

**Rationale:** Dedicated compatibility module to:
- Validate output format
- Ensure RFC 2119 compliance
- Handle config.yaml merging
- Support existing OpenSpec setups

## Data Flow

### Full Pipeline

```
User runs: openlore

  ┌─────────────────────────────────────────────────────────────┐
  │                      INITIALIZATION                          │
  │                                                              │
  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
  │  │  Project    │ ──▶│   Config    │ ──▶│  OpenSpec   │     │
  │  │  Detector   │    │   Writer    │    │   Setup     │     │
  │  └─────────────┘    └─────────────┘    └─────────────┘     │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                        ANALYSIS                              │
  │                                                              │
  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
  │  │    File     │ ──▶│ Significance│ ──▶│   Import    │     │
  │  │   Walker    │    │   Scorer    │    │   Parser    │     │
  │  └─────────────┘    └─────────────┘    └─────────────┘     │
  │                                               │              │
  │  ┌─────────────┐    ┌─────────────┐          │              │
  │  │  Artifact   │ ◀──│ Repository  │ ◀────────┘              │
  │  │  Generator  │    │   Mapper    │                         │
  │  └─────────────┘    └─────────────┘                         │
  │         │                 │                                  │
  │         ▼                 ▼                                  │
  │  .openlore/         Dependency                               │
  │  analysis/          Graph                                    │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                       GENERATION                             │
  │                                                              │
  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
  │  │    Spec     │ ──▶│  OpenSpec   │ ──▶│  OpenSpec   │     │
  │  │  Pipeline   │    │  Formatter  │    │   Writer    │     │
  │  └─────────────┘    └─────────────┘    └─────────────┘     │
  │         │                                     │              │
  │         ▼                                     ▼              │
  │    LLM Service                          openspec/            │
  │    (Claude/GPT)                         specs/ + decisions/  │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                      VERIFICATION                            │
  │                                                              │
  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
  │  │   Candidate │ ──▶│  Prediction │ ──▶│  Comparison │     │
  │  │  Selection  │    │    (LLM)    │    │   Scoring   │     │
  │  └─────────────┘    └─────────────┘    └─────────────┘     │
  │                                               │              │
  │                                               ▼              │
  │                                        Verification          │
  │                                        Report                │
  └─────────────────────────────────────────────────────────────┘
```

## LLM Service Architecture

```typescript
interface LLMProvider {
  name: string;
  generateCompletion(request: CompletionRequest): Promise<CompletionResponse>;
  countTokens(text: string): number;
  maxContextTokens: number;
  maxOutputTokens: number;
}

interface LLMServiceOptions {
  provider?: 'anthropic' | 'openai';
  model?: string;
  apiBase?: string;      // Custom API base URL
  sslVerify?: boolean;   // SSL certificate verification (default: true)
  maxRetries?: number;
  timeout?: number;
  logDir?: string;       // Explicit trusted path, or a path confined by logRoot
  logRoot?: string;      // Canonical project-root boundary for OpenLore-owned logs
  enableLogging?: boolean;
}
```

When logging is enabled, OpenLore-owned callers always pair their repository-derived
`logDir` with `logRoot`. Embedders may omit `logRoot` only when they supply an explicit,
trusted `logDir`; enabling logging with neither boundary nor an explicit path is rejected.

**Supported Providers:**
- Anthropic Claude (primary, used when `ANTHROPIC_API_KEY` is set)
- OpenAI GPT (fallback, used when only `OPENAI_API_KEY` is set)
- Any OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM, etc.)

**Custom Endpoint Support:**

Both providers accept a custom `baseUrl` via the `apiBase` option. The URL is validated and normalized by `normalizeApiBase()` which rejects non-http(s) protocols and strips trailing slashes.

When `sslVerify: false` is configured, `disableSslVerification()` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide (Node.js native `fetch()` does not support per-request TLS configuration).

**Configuration Priority:**
```
CLI --api-base flag  >  OPENAI_API_BASE / ANTHROPIC_API_BASE env var  >  config.json llm.apiBase  >  provider default
CLI --insecure flag  >  config.json llm.sslVerify  >  true (default)
```

**Features:**
- Automatic retry with exponential backoff
- Token counting and context management
- JSON response extraction
- Request/response logging
- Cost tracking
- URL validation and normalization for custom endpoints

## Error Handling Strategy

### Graceful Degradation

- If analysis fails for one file, continue with others
- If one LLM stage fails, save partial results
- If verification fails, still report what succeeded

### Error Categories

```typescript
class OpenLoreError extends Error {
  code: string;        // Machine-readable code
  suggestion?: string; // User-friendly fix
}
```

**Common Errors:**
- `NO_API_KEY` - Missing LLM credentials
- `NOT_A_REPOSITORY` - Not in a git repo
- `ANALYSIS_FAILED` - Static analysis error
- `LLM_RATE_LIMIT` - API rate limiting
- `OPENSPEC_INVALID` - Output validation failure

## Performance Considerations

### File Walking

- Async directory traversal
- Parallel file reading with concurrency limit
- Early filtering before content analysis
- Progress callbacks for UI updates

### Dependency Graph

- O(n + e) graph construction
- Tarjan's algorithm for cycle detection
- PageRank iteration with convergence check
- Lazy metric calculation

### LLM Optimization

- Context truncation for token limits
- Prioritize high-score files
- Cache parsed ASTs during analysis
- Batch related prompts where possible

## Testing Strategy

### Unit Tests

- Every core module has corresponding tests
- Mock file system and LLM responses
- Test edge cases (empty files, circular deps)

### Integration Tests

- Full pipeline with mock LLM
- OpenSpec CLI compatibility
- Real file system operations

### E2E Tests (Manual)

- Test against real open-source projects
- Verify generated specs with openspec validate
- Check cost estimates accuracy

## Future Considerations

### Planned Enhancements

1. **More Languages** — Deeper Python, Go, Java support
2. **Incremental Analysis** — Only re-analyze changed files
3. **Custom Prompts** — User-provided LLM prompts
4. **Spec Diffing** — Show changes between generations

### Extension Points

- Custom significance scorers
- Language-specific parsers
- Alternative LLM providers via custom `--api-base` endpoint
- Output format plugins
