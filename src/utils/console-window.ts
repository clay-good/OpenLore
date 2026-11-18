/**
 * `windowsHide` for a child that INHERITS this process's stdio.
 *
 * On Windows, a console program (node, git, docker…) started by a process that has no console of
 * its own gets a brand-new VISIBLE console window — empty, because its stdio goes elsewhere —
 * unless the spawn sets `windowsHide`. OpenLore often runs with no console: the MCP server and the
 * serve daemon are launched hidden by their host (Claude Code, Pi), and every `analyze` they start
 * to self-heal the index is spawned hidden and detached. A second hop from there (the adaptive-heap
 * re-exec, preflight's analyze fix) therefore opens a window on every repair unless it hides too.
 *
 * Hiding is not always free: with `windowsHide`, a child of an INTERACTIVE terminal no longer
 * shares that console, so it would stop receiving the terminal's Ctrl-C. So hide exactly when no
 * standard stream is a terminal — the console-less case, and also any redirected run (a hook, CI),
 * where no window is wanted either. An interactive terminal keeps today's behaviour.
 *
 * Off Windows `windowsHide` is a documented no-op, so the value is harmless everywhere.
 */
export function hideConsoleWindow(
  streams: ReadonlyArray<{ isTTY?: boolean }> = [process.stdin, process.stdout, process.stderr],
): boolean {
  return !streams.some(stream => stream?.isTTY === true);
}
