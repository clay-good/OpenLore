import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import integration from './vitest.integration.config.js';

/**
 * The integration tests CI runs: every `*.integration.test.ts` except the ones below, so a new
 * integration file runs in CI by default. Each exclusion needs a service or checkout CI does not
 * have; without it the file returns early and its tests would pass without checking anything.
 */
export const CI_EXCLUDED_INTEGRATION_TESTS: Record<string, string> = {
  'src/core/analyzer/e2e.integration.test.ts': 'needs a running embedding server and an embedded index',
  'src/core/analyzer/regression.integration.test.ts': 'needs a running embedding server',
  'src/core/analyzer/vector-index.integration.test.ts': 'needs a running embedding server',
  'src/core/analyzer/leveldb-cpp.integration.test.ts': 'needs a leveldb clone at /tmp/leveldb',
  'src/core/services/mcp-handlers/live-data/live-data.integration.test.ts': 'needs external repository clones',
};

export default mergeConfig(integration, defineConfig({
  test: { exclude: [...configDefaults.exclude, ...Object.keys(CI_EXCLUDED_INTEGRATION_TESTS)] },
}));
