import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeStatus } from "@/hooks/use-realtime-status";
import { useDashboardActions } from "./use-dashboard-actions";
import { useDashboardRecipes } from "./use-dashboard-recipes";

const DONE_STAGES = new Set(["ready", "error", "cancelled"]);

export function useDashboardData() {
  const router = useRouter();
  const realtime = useRealtimeStatus();
  const currentProcess = realtime.status?.process || null;
  const gpus = realtime.gpus.length > 0 ? realtime.gpus : [];
  const recipesState = useDashboardRecipes(currentProcess);
  const actions = useDashboardActions(recipesState.reload);

  const prevStageRef = useRef(realtime.launchProgress?.stage);
  useEffect(() => {
    const stage = realtime.launchProgress?.stage;
    const prev = prevStageRef.current;
    prevStageRef.current = stage;
    if (stage !== prev && DONE_STAGES.has(stage || "")) {
      actions.clearLaunching();
      recipesState.reload();
    }
  }, [realtime.launchProgress?.stage, actions.clearLaunching, recipesState.reload]);

  const navigate = (path: string) => () => router.push(path);

  return {
    currentProcess,
    currentRecipe: recipesState.currentRecipe,
    metrics: realtime.metrics,
    gpus,
    recipes: recipesState.recipes,
    logs: recipesState.logs,
    loading: recipesState.loading,
    launchProgress: realtime.launchProgress,
    platformKind: realtime.platformKind,
    runtimeSummary: realtime.runtimeSummary,
    services: realtime.services,
    lease: realtime.lease,
    isConnected: realtime.isConnected,
    inferencePort: realtime.status?.inference_port,
    benchmarking: actions.benchmarking,
    launching: actions.launching,
    onLaunch: actions.onLaunch,
    onStop: actions.onStop,
    onBenchmark: actions.onBenchmark,
    onNavigateLogs: navigate("/logs"),
    onNewRecipe: navigate("/recipes?new=1"),
    onViewAll: navigate("/recipes"),
  };
}
