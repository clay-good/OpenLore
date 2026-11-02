/**
 * Which tools the running MCP server actually exposes (change: fix-orient-guidance-preset).
 *
 * `orient`'s `nextSteps` and `suggestedTools` named tools by hand — `record_decision`,
 * `check_spec_drift`, `get_spec` — none of which the default `substrate` preset exposes. An
 * agent that followed them got `Tool "record_decision" is not available in the active
 * "substrate" preset`, in the same session where `install` had just printed "the generated
 * guidance prescribes only tools this preset exposes". The guidance has to know the surface.
 *
 * A module-level registry rather than another dispatch parameter: the surface is a property of
 * the PROCESS (one server, one preset), and every handler that renders guidance can read it
 * without the dispatch signature growing a field each time.
 *
 * Unset means "no MCP server in this process" — the CLI, a test, an embedded host. Then every
 * tool counts as reachable, because there is no preset to contradict and the CLI's own guidance
 * should not be silently thinned.
 */

let activeTools: ReadonlySet<string> | null = null;

/** Record the surface this process serves. Called once, as the server starts. */
export function setActiveToolSurface(names: Iterable<string>): void {
  activeTools = new Set(names);
}

/** Forget the surface (used by tests, and by a server shutting down). */
export function clearActiveToolSurface(): void {
  activeTools = null;
}

/** Whether guidance may name this tool: true when no surface is registered. */
export function toolIsWired(name: string): boolean {
  return activeTools === null || activeTools.has(name);
}

/** The registered surface, or null when this process serves none. */
export function activeToolSurface(): ReadonlySet<string> | null {
  return activeTools;
}
