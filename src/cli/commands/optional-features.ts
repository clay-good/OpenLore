/**
 * Fail-soft loaders for optional feature dependencies
 * (change: extend-api-for-supervising-hosts, cli: OptionalFeatureDependenciesDegradeAtTheirOwnCommand).
 *
 * The graph viewer's toolchain and the stdio MCP transport SDK are needed by exactly one command
 * each. Declaring them required makes every embedding host carry React, a Vite toolchain and an MCP
 * SDK it never loads — the same concern as not dragging the analyzer through the package's main
 * entry. They are therefore `optionalDependencies`, loaded at the point of use.
 *
 * `optionalDependencies` still install by default: absence is an installer choice
 * (`--omit=optional`, an offline mirror), not a broken installation, and the message must say so.
 * A raw `ERR_MODULE_NOT_FOUND` stack reads as corruption and tells the user nothing actionable, so
 * every loader here converts it into the missing package plus the exact command that fixes it —
 * the posture the optional tree-sitter grammars and the local embedding service already take.
 */

/** An optional feature package could not be resolved. Carries its own remediation. */
export class OptionalFeatureError extends Error {
  constructor(
    /** The npm package names the feature needs. */
    public readonly packages: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'OptionalFeatureError';
  }
}

/** `npm install a b c` — the exact line that makes the feature work. */
export function installCommandFor(packages: readonly string[]): string {
  return `npm install ${packages.join(' ')}`;
}

/**
 * Build the one message shape every absent optional feature reports: what is missing, why the
 * installation is not broken, the install line, and — when one exists — what still works instead.
 */
function absenceMessage(feature: string, packages: readonly string[], alternative?: string): string {
  const names = packages.join(', ');
  return [
    `${feature} needs ${packages.length > 1 ? 'optional packages' : 'an optional package'} that ${packages.length > 1 ? 'are' : 'is'} not installed: ${names}.`,
    `This is an uninstalled optional feature, not a broken installation — every other openlore command still works.`,
    `Install ${packages.length > 1 ? 'them' : 'it'} with: ${installCommandFor(packages)}`,
    ...(alternative ? [alternative] : []),
  ].join('\n');
}

/** True for the resolution failures that mean "the package is not installed". */
function isModuleNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * Run a dynamic import, converting a resolution failure into an {@link OptionalFeatureError}.
 * Any OTHER failure (a package that is installed but throws while initializing) is rethrown
 * untouched: that is a real fault, and reporting it as "not installed" would send the user to
 * reinstall something they already have.
 *
 * Exported so absence can be tested against a rejecting import: a test runner's module mock cannot
 * reproduce a real `ERR_MODULE_NOT_FOUND` faithfully, and the classification is the behaviour here.
 */
export async function loadOptionalFeature<T>(load: () => Promise<T>, feature: string, packages: readonly string[], alternative?: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    throw new OptionalFeatureError(packages, absenceMessage(feature, packages, alternative));
  }
}

/** The remediation line for the stdio SDK: the daemon transport needs none of it. */
export const MCP_SDK_ALTERNATIVE =
  'The HTTP daemon transport remains available without it: run `openlore serve` and point your client at the daemon.';

/** The viewer's build toolchain. `react` / `react-dom` are resolved by vite when it serves the UI. */
export const VIEWER_PACKAGES = ['vite', '@vitejs/plugin-react', 'react', 'react-dom'] as const;

/** The stdio MCP transport SDK. The HTTP daemon (`openlore serve`) does not use it. */
export const MCP_SDK_PACKAGES = ['@modelcontextprotocol/sdk'] as const;

export interface ViewerToolchain {
  createServer: typeof import('vite')['createServer'];
  react: typeof import('@vitejs/plugin-react')['default'];
}

/** Load vite and the React plugin for `openlore view`. */
export function loadViewerToolchain(): Promise<ViewerToolchain> {
  return loadOptionalFeature(
    async () => {
      const [vite, plugin] = await Promise.all([
        import('vite'),
        import('@vitejs/plugin-react'),
      ]);
      return { createServer: vite.createServer, react: plugin.default };
    },
    'The graph viewer (`openlore view`)',
    VIEWER_PACKAGES,
  );
}

export interface McpSdk {
  Server: typeof import('@modelcontextprotocol/sdk/server/index.js')['Server'];
  StdioServerTransport: typeof import('@modelcontextprotocol/sdk/server/stdio.js')['StdioServerTransport'];
  types: typeof import('@modelcontextprotocol/sdk/types.js');
}

/** Load the stdio transport SDK for `openlore mcp`. */
export function loadMcpSdk(): Promise<McpSdk> {
  return loadOptionalFeature(
    async () => {
      const [server, stdio, types] = await Promise.all([
        import('@modelcontextprotocol/sdk/server/index.js'),
        import('@modelcontextprotocol/sdk/server/stdio.js'),
        import('@modelcontextprotocol/sdk/types.js'),
      ]);
      return { Server: server.Server, StdioServerTransport: stdio.StdioServerTransport, types };
    },
    'The stdio MCP server (`openlore mcp`)',
    MCP_SDK_PACKAGES,
    MCP_SDK_ALTERNATIVE,
  );
}
