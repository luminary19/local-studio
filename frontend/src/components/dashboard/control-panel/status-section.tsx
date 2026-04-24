// CRITICAL
"use client";

import type { GPU, Metrics, ProcessInfo, RecipeWithStatus, RuntimePlatformKind } from "@/lib/types";
import { toGB, toGBFromMB } from "@/lib/formatters";

interface StatusSectionProps {
  currentProcess: ProcessInfo | null;
  currentRecipe: RecipeWithStatus | null;
  metrics: Metrics | null;
  gpus: GPU[];
  isConnected: boolean;
  platformKind?: RuntimePlatformKind | null;
  inferencePort?: number;
  onNavigateChat: () => void;
  onNavigateLogs: () => void;
  onBenchmark: () => void;
  benchmarking: boolean;
  onStop: () => void;
}

export function StatusSection({
  currentProcess,
  currentRecipe,
  metrics,
  gpus,
  isConnected,
  platformKind,
  inferencePort,
  onNavigateChat,
  onNavigateLogs,
  onBenchmark,
  benchmarking,
  onStop,
}: StatusSectionProps) {
  const modelName = currentRecipe?.name || currentProcess?.model_path?.split("/").pop();
  const isRunning = !!currentProcess;
  const backend = currentProcess?.backend;

  const fallbackTotalPower = gpus.reduce((sum, g) => sum + (g.power_draw || 0), 0);
  const fallbackTotalMemUsed = gpus.reduce((sum, g) => {
    if (g.memory_used_mb != null) return sum + toGBFromMB(g.memory_used_mb);
    return sum + toGB(g.memory_used ?? 0);
  }, 0);
  const fallbackMemCapacity = gpus.reduce((sum, g) => {
    if (g.memory_total_mb != null) return sum + toGBFromMB(g.memory_total_mb);
    return sum + toGB(g.memory_total ?? 0);
  }, 0);
  const fallbackPowerLimit = gpus.reduce((sum, g) => sum + (g.power_limit || 0), 0);

  const totalPower = metrics?.current_power_watts ?? fallbackTotalPower;
  const totalMemUsed = metrics?.vram_used_gb ?? fallbackTotalMemUsed;
  const vramCapacity = metrics?.vram_capacity_gb ?? fallbackMemCapacity;
  const powerLimit = metrics?.power_limit_watts ?? fallbackPowerLimit;

  const sessionInput = metrics?.prompt_tokens_total || 0;
  const sessionOutput = metrics?.generation_tokens_total || 0;
  const kvCache = metrics?.kv_cache_usage ? metrics.kv_cache_usage * 100 : null;
  const kvCachePeak = metrics?.session_peak_kv_cache_usage
    ? metrics.session_peak_kv_cache_usage * 100
    : null;

  const genTps = firstPositive(metrics?.session_avg_generation, metrics?.generation_throughput);
  const prefillTps = firstPositive(metrics?.session_avg_prefill, metrics?.prompt_throughput);
  const genPeak = firstPositive(metrics?.session_peak_generation_throughput);
  const prefillPeak = firstPositive(metrics?.session_peak_prompt_throughput);
  const ttftMs = firstPositive(metrics?.avg_ttft_ms);
  const ttftPeak = firstPositive(metrics?.session_peak_ttft_ms);
  const sessions = metrics?.running_requests ?? 0;
  const sessionsPeak = metrics?.session_peak_running_requests ?? 0;
  const powerPeak = firstPositive(metrics?.session_peak_power_watts);
  const vramPeak = firstPositive(metrics?.session_peak_vram_used_gb);

  return (
    <SectionCard label="Status" icon="monitor">
      {/* Model identity + status */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <StatusDot running={isRunning} />
            <span className="text-xs text-(--dim)">
              {isRunning ? "Active" : "Standby"}
            </span>
            {!isConnected && (
              <Badge variant="error">offline</Badge>
            )}
            {backend && <Badge>{backend}</Badge>}
            {platformKind && <Badge>{platformKind}</Badge>}
          </div>
          <h2 className="text-xl font-semibold text-(--fg) leading-tight">
            {modelName || "No Model Loaded"}
          </h2>
          {inferencePort && (
            <span className="text-xs font-mono text-(--dim) mt-1 block">:{inferencePort}</span>
          )}
        </div>

        {/* Action buttons */}
        {isRunning && (
          <div className="flex items-center gap-2">
            <ActionBtn label="Chat" onClick={onNavigateChat} />
            <ActionBtn label="Logs" onClick={onNavigateLogs} />
            <ActionBtn
              label={benchmarking ? "Running..." : "Benchmark"}
              onClick={onBenchmark}
              disabled={benchmarking}
            />
            <ActionBtn label="Stop" onClick={onStop} danger />
          </div>
        )}
      </div>

      {/* Stat pills */}
      {isRunning && (
        <div className="flex flex-wrap gap-3 mt-5 pt-5 border-t border-(--border)/40">
          <StatPill
            label="Decode"
            value={genTps.toFixed(1)}
            unit="tok/s"
            peak={genPeak > 0 ? `${genPeak.toFixed(1)} max` : undefined}
            highlight
          />
          <StatPill
            label="Prefill"
            value={prefillTps.toFixed(1)}
            unit="tok/s"
            peak={prefillPeak > 0 ? `${prefillPeak.toFixed(1)} max` : undefined}
          />
          <StatPill
            label="TTFT"
            value={ttftMs > 0 ? ttftMs.toFixed(0) : "—"}
            unit="ms"
            peak={ttftPeak > 0 ? `${ttftPeak.toFixed(0)} max` : undefined}
          />
          <StatPill
            label="Sessions"
            value={String(sessions)}
            unit=""
            peak={sessionsPeak > 0 ? `${sessionsPeak} max` : undefined}
          />
          {kvCache != null && (
            <StatPill
              label="KV Cache"
              value={kvCache.toFixed(1)}
              unit="%"
              peak={kvCachePeak != null ? `${kvCachePeak.toFixed(1)} max` : undefined}
            />
          )}
          <StatPill
            label="VRAM"
            value={totalMemUsed.toFixed(1)}
            unit={vramCapacity > 0 ? `/ ${vramCapacity.toFixed(0)} GB` : "GB"}
            peak={vramPeak > 0 ? `${vramPeak.toFixed(1)} max` : undefined}
          />
          <StatPill
            label="Power"
            value={String(Math.round(totalPower))}
            unit={powerLimit > 0 ? `/ ${Math.round(powerLimit)} W` : "W"}
            peak={powerPeak > 0 ? `${Math.round(powerPeak)} max` : undefined}
          />
          {sessionInput > 0 && <StatPill label="Prompt" value={fmt(sessionInput)} unit="tokens" />}
          {sessionOutput > 0 && <StatPill label="Output" value={fmt(sessionOutput)} unit="tokens" />}
        </div>
      )}
    </SectionCard>
  );
}

/* ── Shared primitives ── */

export function SectionCard({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-(--surface) overflow-hidden">
      {/* Section header — no inner border */}
      <div className="px-5 py-3 flex items-center gap-2">
        {icon && <span className="text-sm text-(--dim)">{icon}</span>}
        <span className="text-[11px] uppercase tracking-[0.14em] font-medium text-(--dim)">
          {label}
        </span>
      </div>
      {/* Body */}
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return (
    <span className={`h-2 w-2 rounded-full ${running ? "bg-(--fg)" : "bg-(--dim)/60"}`} />
  );
}

function Badge({ variant, children }: { variant?: "error"; children: React.ReactNode }) {
  const cls = variant === "error"
    ? "bg-(--fg)/10 text-(--fg)"
    : "bg-(--fg)/8 text-(--dim)";
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${cls}`}>
      {children}
    </span>
  );
}

function ActionBtn({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        danger
          ? "text-(--fg)/70 hover:bg-(--fg)/10"
          : "text-(--dim) hover:bg-(--fg)/5 hover:text-(--fg)"
      }`}
    >
      {label}
    </button>
  );
}

function StatPill({
  label,
  value,
  unit,
  peak,
  highlight,
}: {
  label: string;
  value: string;
  unit: string;
  peak?: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-(--bg)">
      <span className="text-[10px] text-(--dim)">{label}</span>
      <span className={`text-sm font-mono tabular-nums ${highlight ? "text-(--fg)" : "text-(--fg)"}`}>
        {value}
      </span>
      {unit && <span className="text-[10px] text-(--dim)">{unit}</span>}
      {peak && <span className="text-[10px] text-(--dim)/70 font-mono tabular-nums">· {peak}</span>}
    </div>
  );
}

function firstPositive(...values: Array<number | null | undefined>): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}
