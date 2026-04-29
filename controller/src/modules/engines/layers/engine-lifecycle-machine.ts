import { createStateMachine, type StateMachineContainer } from "../../shared/state-machine";
import type { Recipe } from "../../models/types";

// ── States ────────────────────────────────────────────────────────────────
export type EngineLifecycleState =
  | "idle"
  | "evicting"
  | "launching"
  | "waiting"
  | "cached"
  | "ready"
  | "error";

export interface EngineLifecycleSnapshot {
  state: EngineLifecycleState;
  recipeId: string | null;
  pid: number | null;
  error: string | null;
}

// ── Events ────────────────────────────────────────────────────────────────
export type EngineLifecycleEvent =
  | { type: "LAUNCH"; recipe: Recipe }
  | { type: "EVICT"; force: boolean }
  | { type: "CANCEL" }
  | { type: "PROCESS_STARTED"; pid: number }
  | { type: "HEALTH_PASS" }
  | { type: "HEALTH_FAIL"; reason: string }
  | { type: "PROCESS_DIED"; pid: number }
  | { type: "PREEMPT"; recipeId: string };

// ── Effects ───────────────────────────────────────────────────────────────
export type EngineLifecycleEffect =
  | { type: "START_PROCESS"; recipe: Recipe }
  | { type: "KILL_PROCESS"; pid: number; force: boolean }
  | { type: "EMIT_EVENT"; event: string; payload: Record<string, unknown> }
  | { type: "LOG"; level: string; message: string; meta?: Record<string, unknown> }
  | { type: "SET_TIMER"; timeoutMs: number }
  | { type: "EVICT_CURRENT" };

// ── Transition Function ──────────────────────────────────────────────────
type TransitionFn = (
  state: EngineLifecycleSnapshot,
  event: EngineLifecycleEvent,
) => {
  state: EngineLifecycleSnapshot;
  effects: EngineLifecycleEffect[];
};

const transition: TransitionFn = (current, event) => {
  const effects: EngineLifecycleEffect[] = [];

  switch (current.state) {
    // ── idle ──
    case "idle": {
      if (event.type === "LAUNCH") {
        return {
          state: { state: "evicting", recipeId: event.recipe.id, pid: null, error: null },
          effects: [
            { type: "EVICT_CURRENT" },
            { type: "EMIT_EVENT", event: "launch_progress", payload: { recipeId: event.recipe.id, status: "evicting", message: "Clearing VRAM..." } },
          ],
        };
      }
      if (event.type === "PREEMPT") {
        return {
          state: { state: "idle", recipeId: event.recipeId, pid: null, error: null },
          effects: [{ type: "LOG", level: "warn", message: `Preempt called while idle for ${event.recipeId}` }],
        };
      }
      break;
    }

    // ── evicting ──
    case "evicting": {
      if (event.type === "CANCEL") {
        return {
          state: { state: "idle", recipeId: null, pid: null, error: null },
          effects: [
            { type: "EMIT_EVENT", event: "launch_progress", payload: { recipeId: current.recipeId, status: "cancelled", message: "Launch cancelled" } },
          ],
        };
      }
      if (event.type === "PROCESS_STARTED") {
        return {
          state: { state: "launching", recipeId: current.recipeId, pid: event.pid, error: null },
          effects: [
            { type: "EMIT_EVENT", event: "launch_progress", payload: { recipeId: current.recipeId, status: "launching", message: `Process started (pid ${event.pid})`, progress: 0.25 } },
          ],
        };
      }
      // When eviction is done (process_died), transition to launching
      if (event.type === "PROCESS_DIED") {
        return {
          state: { state: "evicting", recipeId: current.recipeId, pid: null, error: null },
          effects: [
            { type: "LOG", level: "info", message: `Eviction complete for ${current.recipeId}` },
          ],
        };
      }
      break;
    }

    // ── launching ──
    case "launching": {
      if (event.type === "CANCEL") {
        return {
          state: { state: "idle", recipeId: null, pid: null, error: null },
          effects: [
            current.pid ? { type: "KILL_PROCESS", pid: current.pid, force: true } : { type: "LOG", level: "info", message: "Cancel during launch, no process to kill" },
            { type: "EMIT_EVENT", event: "launch_progress", payload: { recipeId: current.recipeId, status: "cancelled", message: "Launch cancelled" } },
          ],
        };
      }
      if (event.type === "PROCESS_STARTED") {
        return {
          state: { state: "launching", recipeId: current.recipeId, pid: event.pid, error: null },
          effects: [],
        };
      }
      // Eviction done, now move to launching
      if (event.type === "PREEMPT") {
        return {
          state: { state: "evicting", recipeId: event.recipeId, pid: null, error: null },
          effects: [
            { type: "EVICT_CURRENT" },
          ],
        };
      }
      break;
    }

    // ── waiting ──
    case "waiting": {
      if (event.type === "HEALTH_PASS") {
        return {
          state: { state: "ready", recipeId: current.recipeId, pid: current.pid, error: null },
          effects: [
            { type: "EMIT_EVENT", event: "model_switch", payload: { status: "ready", recipeId: current.recipeId } },
          ],
        };
      }
      if (event.type === "HEALTH_FAIL") {
        return {
          state: { state: "error", recipeId: current.recipeId, pid: current.pid, error: event.reason },
          effects: [
            { type: "EMIT_EVENT", event: "model_switch", payload: { status: "error", recipeId: current.recipeId, reason: event.reason } },
          ],
        };
      }
      if (event.type === "PROCESS_DIED") {
        return {
          state: { state: "error", recipeId: current.recipeId, pid: null, error: "Process died while waiting" },
          effects: [
            { type: "EMIT_EVENT", event: "launch_progress", payload: { recipeId: current.recipeId, status: "error", message: "Process died during startup" } },
          ],
        };
      }
      if (event.type === "CANCEL") {
        return {
          state: { state: "idle", recipeId: null, pid: null, error: null },
          effects: [
            current.pid ? { type: "KILL_PROCESS", pid: current.pid, force: true } : { type: "LOG", level: "info", message: "Cancel during wait, no process to kill" },
            { type: "EMIT_EVENT", event: "launch_progress", payload: { recipeId: current.recipeId, status: "cancelled", message: "Launch cancelled during waiting" } },
          ],
        };
      }
      break;
    }

    // ── ready ──
    case "ready": {
      if (event.type === "EVICT") {
        return {
          state: { state: "evicting", recipeId: current.recipeId, pid: current.pid, error: null },
          effects: [
            { type: "EVICT_CURRENT" },
          ],
        };
      }
      if (event.type === "LAUNCH" && event.recipe.id !== current.recipeId) {
        return {
          state: { state: "evicting", recipeId: event.recipe.id, pid: current.pid, error: null },
          effects: [
            { type: "EVICT_CURRENT" },
          ],
        };
      }
      if (event.type === "PROCESS_DIED") {
        return {
          state: { state: "error", recipeId: current.recipeId, pid: null, error: "Process died unexpectedly" },
          effects: [
            { type: "EMIT_EVENT", event: "model_switch", payload: { status: "error", recipeId: current.recipeId, reason: "Process died" } },
          ],
        };
      }
      break;
    }

    // ── error ──
    case "error": {
      if (event.type === "LAUNCH") {
        return {
          state: { state: "evicting", recipeId: event.recipe.id, pid: null, error: null },
          effects: [
            { type: "EVICT_CURRENT" },
          ],
        };
      }
      if (event.type === "EVICT") {
        return {
          state: { state: "idle", recipeId: null, pid: null, error: null },
          effects: [
            { type: "EMIT_EVENT", event: "model_switch", payload: { status: "evicted" } },
          ],
        };
      }
      break;
    }
  }

  // Default: no transition
  return { state: current, effects: [{ type: "LOG", level: "debug", message: `No transition for ${current.state} / ${event.type}` }] };
};

// ── Factory ──────────────────────────────────────────────────────────────
export type EngineLifecycleMachine = StateMachineContainer<
  EngineLifecycleSnapshot,
  EngineLifecycleEvent,
  undefined,
  EngineLifecycleEffect
>;

export const createEngineLifecycleMachine = (): EngineLifecycleMachine => {
  return createStateMachine<
    EngineLifecycleSnapshot,
    EngineLifecycleEvent,
    undefined,
    EngineLifecycleEffect
  >({
    initialState: {
      state: "idle",
      recipeId: null,
      pid: null,
      error: null,
    },
    transition: (state, _ctx, event) => {
      const result = transition(state, event);
      return result;
    },
  });
};