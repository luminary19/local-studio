"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

export type SessionSummary = {
  id: string;
  filename: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  modelId: string | null;
  provider: string | null;
  firstUserMessage: string | null;
  turnCount: number;
};

type Props = {
  cwd: string | null;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

const COLLAPSED_WIDTH = "w-9";
const EXPANDED_WIDTH = "w-[260px]";

function formatRelative(isoString: string): string {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function SessionsSidebar({
  cwd,
  activeSessionId,
  onSelect,
  onNew,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!cwd) {
      setSessions([]);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/agent/sessions?cwd=${encodeURIComponent(cwd)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as { sessions?: SessionSummary[] };
      setSessions(payload.sessions ?? []);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Refresh when the active session id changes (after a turn completes pi may
  // have created a new session file in this cwd).
  useEffect(() => {
    if (!activeSessionId) return;
    const handle = window.setTimeout(() => void reload(), 500);
    return () => window.clearTimeout(handle);
  }, [activeSessionId, reload]);

  const aside = useMemo(
    () =>
      `flex shrink-0 flex-col border-r border-(--border) bg-(--bg) transition-[width] duration-150 ${
        collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH
      }`,
    [collapsed],
  );

  if (collapsed) {
    return (
      <aside className={aside}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-9 w-full shrink-0 items-center justify-center border-b border-(--border) text-(--dim) hover:bg-(--surface) hover:text-(--fg)"
          title="Show sessions"
          aria-label="Show sessions"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </aside>
    );
  }

  return (
    <aside className={aside}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--border) px-2 text-xs">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-6 w-6 items-center justify-center rounded text-(--dim) hover:bg-(--surface) hover:text-(--fg)"
          title="Hide sessions"
          aria-label="Hide sessions"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="font-medium uppercase tracking-wide text-(--dim)">Sessions</span>
        <button
          type="button"
          onClick={onNew}
          className="flex h-6 w-6 items-center justify-center rounded text-(--dim) hover:bg-(--surface) hover:text-(--fg)"
          title="New session"
          aria-label="New session"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {!cwd ? (
        <div className="flex flex-1 items-center justify-center px-3 text-center text-[11px] text-(--dim)">
          Pick a project to see its session history.
        </div>
      ) : loading && sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-(--dim)">
          Loading…
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-3 text-center text-[11px] text-(--dim)">
          No past sessions in this project.
        </div>
      ) : (
        // Virtualize so projects with hundreds of past sessions stay snappy.
        <Virtuoso
          data={sessions}
          className="min-h-0 flex-1"
          itemContent={(_, session) => (
            <SessionRow
              session={session}
              active={session.id === activeSessionId}
              onSelect={() => onSelect(session.id)}
            />
          )}
          computeItemKey={(_, session) => session.id}
        />
      )}
    </aside>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={session.firstUserMessage || "Untitled session"}
      data-session-id={session.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-vllm-session", session.id);
        event.dataTransfer.effectAllowed = "copy";
      }}
      className={`group flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
        active
          ? "border-(--accent) bg-(--surface)"
          : "border-transparent hover:bg-(--surface)"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-(--fg)">
          {session.firstUserMessage || "Untitled session"}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[10px] text-(--dim)">
          <span>{formatRelative(session.updatedAt)}</span>
          <span aria-hidden>·</span>
          <span>
            {session.turnCount} {session.turnCount === 1 ? "turn" : "turns"}
          </span>
        </span>
      </span>
    </button>
  );
}
