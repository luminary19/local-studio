import type { Config } from "../config/env";
import type { Logger } from "../core/logger";
import type { EventManager } from "../modules/system/event-manager";
import type { LaunchState } from "../modules/engines/layers/launch-state";
import type { ControllerMetrics, MetricsRegistry } from "../modules/system/metrics";
import type { ProcessManager } from "../modules/engines/layers/process-manager";
import type { EngineCoordinator } from "../modules/engines/layers/engine-coordinator";
import type { DownloadManager } from "../modules/engines/layers/download-manager";
import type { DownloadStore } from "../modules/engines/layers/download-store";
import type { LifetimeMetricsStore, PeakMetricsStore } from "../modules/system/metrics-store";
import type { RecipeStore } from "../modules/models/recipes/recipe-store";
import type { InferenceRequestStore } from "../stores/inference-request-store";

/**
 * Application-wide dependency container.
 */
export interface AppContext {
  config: Config;
  logger: Logger;
  eventManager: EventManager;
  launchState: LaunchState;
  metrics: ControllerMetrics;
  metricsRegistry: MetricsRegistry;
  processManager: ProcessManager;
  downloadManager: DownloadManager;
  engineService: EngineCoordinator;
  stores: {
    recipeStore: RecipeStore;
    downloadStore: DownloadStore;
    peakMetricsStore: PeakMetricsStore;
    lifetimeMetricsStore: LifetimeMetricsStore;
    inferenceRequestStore: InferenceRequestStore;
  };
}
