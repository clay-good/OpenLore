/**
 * Bootstrap that sizes the V8 heap as an import side effect (change: make-analyze-scale-to-any-repo).
 *
 * Why a separate module, imported first: like the Node-version guard, this must run BEFORE commander
 * and the command modules evaluate — ES modules evaluate a module's dependencies in source order,
 * each fully before the next, so importing this early makes {@link maybeReexecForHeap} (and its
 * re-exec + `process.exit`) run ahead of the heavy imports. When a re-exec happens, the parent does
 * essentially no wasted work before handing off to the larger-heap child.
 *
 * `heap-sizing.ts` stays side-effect-free at module load (its planner and cgroup parsers are pure)
 * so they can be unit-tested without re-executing or exiting the test process.
 */
import { maybeReexecForHeap } from './heap-sizing.js';

maybeReexecForHeap();
