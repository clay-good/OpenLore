/**
 * Graceful shutdown handling for openlore CLI
 */

import * as fs from 'fs';
import * as path from 'path';
import { OPENLORE_DIR, ARTIFACT_SHUTDOWN_STATE } from '../constants.js';

export interface ShutdownState {
  /** Current phase when interrupted */
  phase: 'init' | 'analyze' | 'generate' | 'verify';
  /** Files that were being processed */
  currentFiles?: string[];
  /** Partial results that were saved */
  savedResults?: string;
  /** Timestamp of interruption */
  timestamp: number;
}

type CleanupCallback = () => void | Promise<void>;

/**
 * Manages graceful shutdown with cleanup callbacks
 */
export class ShutdownManager {
  private callbacks: CleanupCallback[] = [];
  private isShuttingDown = false;
  private state: ShutdownState | null = null;
  private stateFile: string;
  private handlers: Map<string, (...args: unknown[]) => void> = new Map();
  private handlersAttached = false;

  constructor(projectPath: string = process.cwd(), options?: { skipHandlers?: boolean }) {
    this.stateFile = path.join(projectPath, OPENLORE_DIR, ARTIFACT_SHUTDOWN_STATE);
    // Skip handlers in test environment or when explicitly disabled
    if (!options?.skipHandlers && process.env.NODE_ENV !== 'test') {
      this.setupHandlers();
    }
  }

  private setupHandlers(): void {
    if (this.handlersAttached) return;
    this.handlersAttached = true;

    const sigintHandler = () => this.handleShutdown('SIGINT');
    const sigtermHandler = () => this.handleShutdown('SIGTERM');
    const exceptionHandler = (error: Error) => {
      console.error('\n❌ Uncaught exception:', error.message);
      this.handleShutdown('uncaughtException');
    };
    const rejectionHandler = (reason: unknown) => {
      console.error('\n❌ Unhandled rejection:', reason);
      this.handleShutdown('unhandledRejection');
    };

    // Store handlers for potential cleanup
    this.handlers.set('SIGINT', sigintHandler);
    this.handlers.set('SIGTERM', sigtermHandler);
    this.handlers.set('uncaughtException', exceptionHandler as (...args: unknown[]) => void);
    this.handlers.set('unhandledRejection', rejectionHandler as (...args: unknown[]) => void);

    // Handle Ctrl+C
    process.on('SIGINT', sigintHandler);

    // Handle termination signal
    process.on('SIGTERM', sigtermHandler);

    // Handle uncaught exceptions
    process.on('uncaughtException', exceptionHandler);

    // Handle unhandled promise rejections
    process.on('unhandledRejection', rejectionHandler);
  }

  /**
   * Remove all registered signal handlers (for testing)
   */
  removeHandlers(): void {
    for (const [event, handler] of this.handlers) {
      process.removeListener(event, handler);
    }
    this.handlers.clear();
    this.handlersAttached = false;
  }

  private async handleShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      console.log('\n⚠️  Force quitting...');
      process.exit(1);
    }

    this.isShuttingDown = true;
    console.log('\n\n🛑 Interrupted! Cleaning up...');

    // Save state if we have one
    if (this.state) {
      await this.saveState();
    }

    // Run cleanup callbacks in reverse order (copy to avoid mutating the array)
    for (const callback of [...this.callbacks].reverse()) {
      try {
        await callback();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }

    // Show resume suggestion
    this.showResumeSuggestion();

    process.exit(signal === 'SIGINT' ? 130 : 1);
  }

  /**
   * Register a cleanup callback to run on shutdown
   */
  onCleanup(callback: CleanupCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove a cleanup callback
   */
  removeCleanup(callback: CleanupCallback): void {
    const index = this.callbacks.indexOf(callback);
    if (index !== -1) {
      this.callbacks.splice(index, 1);
    }
  }

  /**
   * Set the current state for potential resume
   */
  setState(state: Partial<ShutdownState>): void {
    this.state = {
      phase: state.phase ?? 'init',
      currentFiles: state.currentFiles,
      savedResults: state.savedResults,
      timestamp: Date.now(),
    };
  }

  /**
   * Clear state (call on successful completion)
   */
  clearState(): void {
    this.state = null;
    // Remove state file if it exists
    try {
      if (fs.existsSync(this.stateFile)) {
        fs.unlinkSync(this.stateFile);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Save state to file for potential resume
   */
  private async saveState(): Promise<void> {
    if (!this.state) return;

    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
      console.log(`📝 State saved to ${this.stateFile}`);
    } catch (error) {
      console.error('Failed to save state:', error);
    }
  }

  /**
   * Load previous shutdown state
   */
  loadState(): ShutdownState | null {
    try {
      if (fs.existsSync(this.stateFile)) {
        const content = fs.readFileSync(this.stateFile, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Check if there's a previous interrupted session
   */
  hasPreviousState(): boolean {
    return this.loadState() !== null;
  }

  private showResumeSuggestion(): void {
    if (!this.state) return;

    console.log('\n📋 To resume from where you left off:');

    switch (this.state.phase) {
      case 'init':
        console.log('   Run: openlore init');
        break;
      case 'analyze':
        console.log('   Run: openlore analyze');
        if (this.state.savedResults) {
          console.log(`   Partial analysis saved to: ${this.state.savedResults}`);
        }
        break;
      case 'generate':
        console.log('   Run: openlore generate');
        if (this.state.savedResults) {
          console.log(`   Partial specs saved to: ${this.state.savedResults}`);
        }
        break;
      case 'verify':
        console.log('   Run: openlore verify');
        break;
    }

    console.log('');
  }

  /**
   * Check if shutdown is in progress
   */
  isInProgress(): boolean {
    return this.isShuttingDown;
  }
}

// ============================================================================
// Transport-lifetime coordinator (change: fix-process-exit-lifecycle)
// ============================================================================

/**
 * A single idempotent teardown path for a surface whose lifetime is bound to a
 * transport — the MCP stdio server, whose lifetime is its stdin. Distinct from
 * {@link ShutdownManager}, which is the analyze/generate pipeline's interrupt
 * handler (resume state, banner, exit 130). This one has no state file and no
 * banner: a closed transport is ordinary end-of-work, so it exits 0 by default.
 *
 * Every way the surface can end — stdin EOF, `SIGINT`, `SIGTERM` — routes
 * through one `shutdown()`, so no signal implements a partial teardown of its
 * own and running it twice is harmless. Teardown is bounded: a handle that hangs
 * on close cannot turn "exit on EOF" back into a hang, because the process
 * exits once the grace window elapses regardless.
 */
export interface ShutdownCoordinator {
  /** Register a teardown to run once, on the first shutdown. */
  register(teardown: CleanupCallback): void;
  /** Run every teardown once (bounded), then exit. Idempotent. */
  shutdown(code?: number): Promise<void>;
  /** True once shutdown has begun. */
  readonly isShuttingDown: boolean;
}

export function createShutdownCoordinator(
  options: {
    /** Exit hook — defaults to process.exit; injected in tests. */
    exit?: (code: number) => void;
    /** Max ms to wait for teardowns before exiting anyway (default 2000). */
    graceMs?: number;
  } = {},
): ShutdownCoordinator {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceMs = options.graceMs ?? 2_000;
  const teardowns: CleanupCallback[] = [];
  let shuttingDown = false;

  return {
    get isShuttingDown(): boolean {
      return shuttingDown;
    },
    register(teardown: CleanupCallback): void {
      teardowns.push(teardown);
    },
    async shutdown(code = 0): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      // Bound teardown: a watcher/store handle that hangs on close must not
      // reintroduce the very hang this coordinator exists to prevent. The grace
      // timer is unref'd so it never by itself keeps the loop alive.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, graceMs);
        graceTimer.unref?.();
      });
      try {
        await Promise.race([
          Promise.allSettled(teardowns.map((t) => Promise.resolve().then(t))),
          grace,
        ]);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
      exit(code);
    },
  };
}

// Global shutdown manager instance
let globalManager: ShutdownManager | null = null;

/**
 * Get or create the global shutdown manager
 */
export function getShutdownManager(projectPath?: string): ShutdownManager {
  if (!globalManager) {
    globalManager = new ShutdownManager(projectPath);
  }
  return globalManager;
}

/**
 * Register a cleanup callback with the global manager
 */
export function onShutdown(callback: CleanupCallback): void {
  getShutdownManager().onCleanup(callback);
}

/**
 * Set current state for potential resume
 */
export function setShutdownState(state: Partial<ShutdownState>): void {
  getShutdownManager().setState(state);
}

/**
 * Clear shutdown state (call on successful completion)
 */
export function clearShutdownState(): void {
  getShutdownManager().clearState();
}

/**
 * Create a scope that sets/clears state automatically
 */
export async function withShutdownState<T>(
  state: Partial<ShutdownState>,
  fn: () => Promise<T>
): Promise<T> {
  const manager = getShutdownManager();
  manager.setState(state);

  const result = await fn();
  manager.clearState();
  return result;
}
