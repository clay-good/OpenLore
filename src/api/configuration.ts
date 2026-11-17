/** Provider-free configuration operations; no analyzer, watcher or model bootstrap. */
export { inspectConfiguration } from '../core/configuration/inspect.js';
export {
  previewConfiguration,
  applyConfiguration,
  verifyConfiguration,
  revertConfiguration,
  configurationRoot,
} from '../core/configuration/workflow.js';
export type * from '../core/configuration/types.js';
export { configureOpenLore } from '../core/configuration/adapter.js';
export type { ConfigurationRequest } from '../core/configuration/adapter.js';
export { reviewConfiguration, dismissConfigurationReview } from '../core/configuration/review.js';
export type {
  ConfigurationReviewSignal,
  ConfigurationReviewState,
  ConfigurationReviewResult,
} from '../core/configuration/review.js';
export { observeConfiguration } from '../core/configuration/observe.js';
export { reviewConfigurationWithStore } from '../core/configuration/review-store.js';
export { reviewConfigurationOnIdle } from '../core/configuration/evolution.js';
