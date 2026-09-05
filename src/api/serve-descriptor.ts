/**
 * `openlore/serve-descriptor` — the daemon-discovery contract, published for embedding hosts.
 *
 * A host that supervises OpenLore per working tree must discover the daemon it runs. Reading
 * `.openlore/serve.json` makes it a reader of an attacker-writable artifact that becomes a fetch
 * target, so it faces the identical threat model as the three in-package readers
 * (mcp-security: ServeDescriptorValidatedAtEveryReader). Without this entry point a host carries a
 * hand-copied validator that drifts from ours — the "one threat model, three postures" failure the
 * validator was extracted to prevent, reproduced one package boundary away.
 *
 * WHY THIS IS ITS OWN SUBPATH, NOT `"."`.
 * `src/api/index.ts` statically re-exports `openloreAnalyze`, whose import graph reaches the
 * analyzer and tree-sitter. Importing anything from `"."` therefore loads the analyzer eagerly —
 * into the very process a supervising host keeps free of it. `serve-descriptor.ts` is
 * dependency-light BY CONTRACT (node builtins plus the loopback predicate) precisely so a host can
 * import it without that weight, and a `"."` home would destroy the property this module exists to
 * provide. Keep this file's imports to the one module below; adding any other import silently
 * re-introduces the weight (guarded by `serve-descriptor-subpath.test.ts`).
 */

export {
  readServeDescriptor,
  readServeDescriptorState,
  validateServeDescriptor,
  validateServeHealth,
  serveHttpBaseUrl,
  canonicalServeRoot,
  SERVE_PROTOCOL_VERSION,
} from '../cli/commands/serve-descriptor.js';

export type {
  ServeDescriptor,
  ServeHealth,
  ServeDescriptorRead,
} from '../cli/commands/serve-descriptor.js';
