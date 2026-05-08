"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, ReactNode } from "react";
import {
  AlertTriangle,
  FileText,
  Loader2,
  PencilLine,
  Search,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import {
  AttachIcon,
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  GitBranchIcon,
  GlobeIcon,
  SendIcon,
  StopIcon,
} from "@/components/icons";
import { safeJson } from "@/lib/agent/safe-json";
import {
  applyPiEventToAssistantMessage,
  drainQueueAfterAgentEnd,
  formatTokenCount,
  makeFreshTab,
  newId,
  nowLabel,
  piSessionIdFromEvent,
  replaySessionEvents,
  sessionTitleFromPrompt,
  usageFromEvent,
  type ChatMessage,
  type SessionTab,
  type ToolBlock,
  type TokenStats,
} from "@/lib/agent/chat-session";
import { AssistantMarkdown } from "./assistant-markdown";
import {
  attachmentDedupKey,
  attachmentPrompt,
  createAttachment,
  dataTransferHasFiles,
  filesFromDataTransfer,
  formatFileSize,
  isImageAttachment,
  type ChatAttachment,
} from "./chat-attachments";

export {
  drainQueueAfterAgentEnd,
  makeFreshTab,
  replaySessionEvents,
  sessionTitleFromPrompt,
  type SessionTab,
} from "@/lib/agent/chat-session";

// Imperative handle exposed by ChatPane so the workspace can replay a past
// pi session into the focused pane without going through useEffect-driven
// prop plumbing. The workspace calls this directly from event/click handlers
// so the control flow is auditable in one place.
export type ChatPaneHandle = {
  loadAndReplay: (piSessionId: string) => Promise<void>;
};

type Props = {
  paneId: string;
  // The unique runtime session id used as the PiRpcSession key on the server.
  runtimeSessionId: string;
  modelId: string;
  modelName: string | null;
  modelsLoading: boolean;
  contextWindow: number;
  cwd: string;
  projectName: string | null;
  projectSelector?: ReactNode;
  modelSelector?: ReactNode;
  gitBranch?: string | null;
  gitSummary?: {
    isRepo: boolean;
    additions: number;
    deletions: number;
    statusCount: number;
  } | null;
  onInitGit?: () => void;
  browserToolEnabled: boolean;
  onToggleBrowserTool: () => void;
  isFocused: boolean;
  onFocus: () => void;
  // Notify parent that we picked up a fresh pi session id (so the sidebar can
  // refresh its summary list).
  onPiSessionIdChange?: (sessionId: string) => void;
  // The pane's tab state lives in the parent so layout / persistence can see
  // and rehydrate it.
  tabs: SessionTab[];
  activeTabId: string;
  onTabsChange: (tabs: SessionTab[] | ((tabs: SessionTab[]) => SessionTab[])) => void;
  onClose?: () => void;
  // Workspace hands ChatPane a setter so it can register/unregister an
  // imperative handle. There is no useEffect-driven `initialSessionId` field
  // anymore — the workspace calls handle.loadAndReplay() directly when the
  // user clicks a session in the navbar. One source of truth, no race.
  onRegisterHandle?: (handle: ChatPaneHandle | null) => void;
};

export function ChatPane({
  paneId,
  runtimeSessionId,
  modelId,
  modelName,
  modelsLoading,
  contextWindow,
  cwd,
  projectName,
  projectSelector,
  modelSelector,
  gitBranch,
  gitSummary,
  onInitGit,
  browserToolEnabled,
  onToggleBrowserTool,
  isFocused,
  onFocus,
  onPiSessionIdChange,
  tabs,
  activeTabId,
  onTabsChange,
  onClose,
  onRegisterHandle,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isMultiline, setIsMultiline] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [readingAttachments, setReadingAttachments] = useState(false);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const tabsRef = useRef(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId],
  );
  const running = activeTab?.status === "running" || activeTab?.status === "starting";
  const showEmptyPrompt = activeTab && activeTab.messages.length === 0 && !running;

  const updateTab = useCallback(
    (tabId: string, patch: (tab: SessionTab) => SessionTab) => {
      onTabsChange((currentTabs) =>
        currentTabs.map((tab) => (tab.id === tabId ? patch(tab) : tab)),
      );
    },
    [onTabsChange],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (stickToBottomRef.current) {
      requestAnimationFrame(() => element.scrollTo({ top: element.scrollHeight }));
    }
  }, [activeTab?.messages, activeTab?.status]);

  const patchAssistant = useCallback(
    (tabId: string, assistantId: string, patch: (msg: ChatMessage) => ChatMessage) => {
      updateTab(tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) => (m.id === assistantId ? patch(m) : m)),
      }));
    },
    [updateTab],
  );

  const applyPiEvent = useCallback(
    (tabId: string, assistantId: string, event: Record<string, unknown>) => {
      const usage = usageFromEvent(event);
      if (usage) {
        updateTab(tabId, (tab) => ({ ...tab, tokenStats: usage }));
      }
      patchAssistant(tabId, assistantId, (message) =>
        applyPiEventToAssistantMessage(message, event),
      );
    },
    [patchAssistant, updateTab],
  );

  // Send a control-mode message (steer / follow_up) without taking ownership of
  // the long-running prompt stream.
  const sendControlMessage = useCallback(
    async (
      mode: "steer" | "follow_up",
      text: string,
      runtime: string,
      piSessionId?: string | null,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!text.trim() || !modelId) return { ok: false };
      try {
        const response = await fetch("/api/agent/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: runtime,
            modelId,
            message: text,
            cwd: cwd.trim() || undefined,
            piSessionId,
            mode,
            browserToolEnabled,
          }),
        });
        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || `Agent request failed: ${response.status}`);
        }
        // Drain the short SSE stream so the connection closes cleanly.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let controlError = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";
          for (const chunk of chunks) {
            const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
            if (!line) continue;
            const payload = JSON.parse(line.slice(6)) as
              | { type: "status"; phase: string }
              | { type: "error"; error: string };
            if (payload.type === "error") controlError = payload.error;
          }
        }
        if (controlError) throw new Error(controlError);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Message failed" };
      }
    },
    [modelId, cwd, browserToolEnabled],
  );

  const submitPrompt = useCallback(
    async (rawText: string, targetTabId?: string) => {
      const selectedTab =
        (targetTabId ? tabsRef.current.find((tab) => tab.id === targetTabId) : null) ?? activeTab;
      if (!selectedTab) return;
      const text = rawText.trim();
      if ((!text && attachments.length === 0) || !modelId || readingAttachments) return;

      const tabId = selectedTab.id;
      const userId = newId("user");
      const assistantId = newId("assistant");
      const runtime = selectedTab.runtimeSessionId || runtimeSessionId;
      const attachedText = attachmentPrompt(attachments);
      const attachmentSummary =
        attachments.length > 0
          ? `Attached: ${attachments.map((file) => file.name).join(", ")}`
          : "";
      const userText = text || attachmentSummary;
      const displayText = [text, attachmentSummary].filter(Boolean).join("\n\n");
      const promptText = [text, attachedText].filter(Boolean).join("\n\n");

      // Optimistic update: show the user's turn + a blank assistant message.
      updateTab(tabId, (tab) => ({
        ...tab,
        cwd: tab.cwd || cwd,
        modelId: tab.modelId || modelId,
        input: "",
        error: "",
        status: "starting",
        title:
          tab.messages.filter((m) => m.role === "user").length === 0
            ? sessionTitleFromPrompt(userText)
            : tab.title,
        messages: [
          ...tab.messages,
          { id: userId, role: "user", text: displayText, timestamp: nowLabel() },
          {
            id: assistantId,
            role: "assistant",
            text: "",
            blocks: [],
            timestamp: nowLabel(),
          },
        ],
      }));
      stickToBottomRef.current = true;
      setAttachments([]);
      setIsMultiline(false);
      if (textareaRef.current) textareaRef.current.style.height = "";
      if (fileInputRef.current) fileInputRef.current.value = "";

      let agentEnded = false;
      try {
        const response = await fetch("/api/agent/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: runtime,
            modelId,
            message: promptText,
            cwd: cwd.trim() || undefined,
            piSessionId:
              tabsRef.current.find((tab) => tab.id === tabId)?.piSessionId ??
              selectedTab.piSessionId,
            browserToolEnabled,
          }),
        });
        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || `Agent request failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";
          for (const chunk of chunks) {
            const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
            if (!line) continue;
            const payload = JSON.parse(line.slice(6)) as
              | { type: "status"; phase: string; piSessionId?: string | null }
              | { type: "error"; error: string }
              | { type: "pi"; event: Record<string, unknown> };
            if (payload.type === "status") {
              const phase = payload.phase;
              updateTab(tabId, (tab) => ({
                ...tab,
                piSessionId: payload.piSessionId || tab.piSessionId,
                status: phase === "done" ? "idle" : phase,
              }));
              if (payload.piSessionId) onPiSessionIdChange?.(payload.piSessionId);
            } else if (payload.type === "error") {
              updateTab(tabId, (tab) => ({ ...tab, error: payload.error, status: "idle" }));
            } else if (payload.type === "pi") {
              const piEvent = payload.event;
              const eventId = piSessionIdFromEvent(piEvent);
              if (eventId) {
                updateTab(tabId, (tab) => ({ ...tab, piSessionId: eventId }));
                onPiSessionIdChange?.(eventId);
              }
              if (piEvent.type === "agent_end") {
                agentEnded = true;
                const latestPiSessionId =
                  eventId ??
                  tabsRef.current.find((tab) => tab.id === tabId)?.piSessionId ??
                  selectedTab.piSessionId ??
                  "";
                onPiSessionIdChange?.(latestPiSessionId);
              }
              applyPiEvent(tabId, assistantId, piEvent);
            }
          }
        }
      } catch (err) {
        updateTab(tabId, (tab) => ({
          ...tab,
          error: err instanceof Error ? err.message : "Agent request failed",
          status: "idle",
        }));
      } finally {
        updateTab(tabId, (tab) => ({ ...tab, status: "idle" }));
      }

      // Drain queued messages once the agent finished its run.
      if (agentEnded) {
        const queued = (tabsRef.current.find((tab) => tab.id === tabId)?.queue ?? []).slice();
        const { next, remaining } = drainQueueAfterAgentEnd(queued);
        if (next) {
          updateTab(tabId, (tab) => ({ ...tab, queue: remaining }));
          // Schedule on the next tick so React commits the optimistic
          // update before we kick off the next prompt.
          setTimeout(() => void submitPromptRef.current?.(next.text, tabId), 0);
        } else if (queued.length > 0) {
          updateTab(tabId, (tab) => ({ ...tab, queue: remaining }));
        }
      }
    },
    [
      activeTab,
      attachments,
      modelId,
      readingAttachments,
      runtimeSessionId,
      cwd,
      browserToolEnabled,
      onPiSessionIdChange,
      applyPiEvent,
      updateTab,
    ],
  );

  // Stable ref so the queue-drain inside submitPrompt can re-enter without
  // forming a useCallback cycle.
  const submitPromptRef = useRef<(text: string, targetTabId?: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  useEffect(() => {
    submitPromptRef.current = submitPrompt;
  }, [submitPrompt]);

  const sendMessage = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!activeTab) return;
      const text = activeTab.input.trim();
      if ((!text && attachments.length === 0) || !modelId || readingAttachments) return;

      // While running, Enter sends a steering message instead of a fresh prompt.
      if (running) {
        if (!text) return;
        const queuedId = newId("queue");
        updateTab(activeTab.id, (tab) => ({
          ...tab,
          input: "",
          error: "",
          queue: [...(tab.queue ?? []), { id: queuedId, mode: "steer", text }],
        }));
        const result = await sendControlMessage(
          "steer",
          text,
          activeTab.runtimeSessionId || runtimeSessionId,
          activeTab.piSessionId,
        );
        if (!result.ok) {
          updateTab(activeTab.id, (tab) => ({
            ...tab,
            input: text,
            error: result.error || "Message failed",
            queue: (tab.queue ?? []).filter((item) => item.id !== queuedId),
          }));
        }
        return;
      }
      await submitPrompt(text, activeTab.id);
    },
    [
      activeTab,
      attachments.length,
      modelId,
      readingAttachments,
      running,
      runtimeSessionId,
      sendControlMessage,
      submitPrompt,
      updateTab,
    ],
  );

  // Tab-key behavior: when idle, submit immediately; while a turn is running,
  // keep the follow-up visibly queued and replay it as a normal prompt after
  // agent_end. This avoids the "message vanished" state where a chip was added
  // but no prompt was ever sent.
  const queueMessage = useCallback(async () => {
    if (!activeTab) return;
    const text = activeTab.input.trim();
    if (!text || !modelId) return;
    const tabId = activeTab.id;
    if (!running) {
      await submitPromptRef.current(text, tabId);
      return;
    }
    const queuedId = newId("queue");
    updateTab(tabId, (tab) => ({
      ...tab,
      cwd: tab.cwd || cwd,
      input: "",
      error: "",
      queue: [...(tab.queue ?? []), { id: queuedId, mode: "follow_up", text }],
    }));
  }, [activeTab, modelId, running, cwd, updateTab]);

  const removeQueued = useCallback(
    (queueId: string) => {
      if (!activeTab) return;
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        queue: (tab.queue ?? []).filter((entry) => entry.id !== queueId),
      }));
    },
    [activeTab, updateTab],
  );

  const attachFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const fileArray = files ? Array.from(files) : [];
      if (fileArray.length === 0 || !activeTab) return;
      if (running) {
        updateTab(activeTab.id, (tab) => ({
          ...tab,
          error: "Pause or wait for the current turn before attaching files.",
        }));
        return;
      }
      setReadingAttachments(true);
      try {
        const next = await Promise.all(fileArray.map((file) => createAttachment(file)));
        setAttachments((current) => {
          const seen = new Set(current.map(attachmentDedupKey));
          const uniqueNext: ChatAttachment[] = [];
          next.forEach((file) => {
            const key = attachmentDedupKey(file);
            if (seen.has(key)) return;
            seen.add(key);
            uniqueNext.push(file);
          });
          return [...current, ...uniqueNext];
        });
        updateTab(activeTab.id, (tab) => ({ ...tab, error: "" }));
      } catch (err) {
        updateTab(activeTab.id, (tab) => ({
          ...tab,
          error: err instanceof Error ? err.message : "Failed to attach file",
        }));
      } finally {
        setReadingAttachments(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [activeTab, running, updateTab],
  );

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = filesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void attachFiles(files);
    },
    [attachFiles],
  );

  const handleComposerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = running ? "none" : "copy";
      setComposerDragActive(true);
    },
    [running],
  );

  const handleComposerDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setComposerDragActive(false);
  }, []);

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setComposerDragActive(false);
      void attachFiles(filesFromDataTransfer(event.dataTransfer));
    },
    [attachFiles],
  );

  const abortTurn = useCallback(async () => {
    if (!activeTab) return;
    const tabId = activeTab.id;
    await fetch("/api/agent/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeTab.runtimeSessionId || runtimeSessionId }),
    }).catch(() => undefined);
    updateTab(tabId, (tab) => ({ ...tab, status: "idle" }));
  }, [activeTab, runtimeSessionId, updateTab]);

  // Replay a past pi session into the currently active tab. Looks up the
  // active tab by id at call time so concurrent updates don't race.
  const loadAndReplay = useCallback(
    async (piSessionId: string) => {
      if (!cwd) return;
      const tabId = activeTabId;
      if (!tabId) return;
      updateTab(tabId, (tab) => ({ ...tab, status: "loading", error: "" }));
      try {
        const response = await fetch(
          `/api/agent/sessions/${encodeURIComponent(piSessionId)}?cwd=${encodeURIComponent(cwd)}`,
          { cache: "no-store" },
        );
        const payload = await safeJson<{
          events?: Record<string, unknown>[];
          error?: string;
        }>(response);
        if (!response.ok) throw new Error(payload.error || "Failed to load session");

        const { messages, title } = replaySessionEvents(payload.events ?? []);
        const tokenStats = [...(payload.events ?? [])]
          .reverse()
          .map(usageFromEvent)
          .find((stats): stats is TokenStats => Boolean(stats));

        updateTab(tabId, (tab) => ({
          ...tab,
          messages,
          piSessionId,
          cwd: tab.cwd || cwd,
          modelId: tab.modelId || modelId,
          title: title ?? tab.title,
          tokenStats: tokenStats ?? tab.tokenStats,
          status: "idle",
          error: "",
        }));
      } catch (err) {
        updateTab(tabId, (tab) => ({
          ...tab,
          error: err instanceof Error ? err.message : "Failed to load session",
          status: "idle",
        }));
      }
    },
    [cwd, modelId, activeTabId, updateTab],
  );

  // Register a stable imperative handle so the workspace can call
  // loadAndReplay directly from event handlers. This replaces the previous
  // useEffect that watched an `initialSessionId` prop and chained side
  // effects on every re-render.
  const handleRef = useRef<ChatPaneHandle>({ loadAndReplay });
  handleRef.current = { loadAndReplay };
  useEffect(() => {
    if (!onRegisterHandle) return;
    const handle: ChatPaneHandle = {
      loadAndReplay: (id) => handleRef.current.loadAndReplay(id),
    };
    onRegisterHandle(handle);
    return () => onRegisterHandle(null);
  }, [onRegisterHandle]);

  return (
    <section
      onMouseDownCapture={onFocus}
      data-pane-id={paneId}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-(--bg)"
    >
      {onClose ? (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="absolute right-12 top-2 z-30 inline-flex h-7 w-7 items-center justify-center rounded-md text-(--dim) hover:bg-(--surface) hover:text-(--fg)"
          aria-label="Close pane"
          title="Close pane"
        >
          <CloseIcon className="h-3.5 w-3.5 pointer-events-none" />
        </button>
      ) : null}
      {activeTab?.error ? (
        <div className="border-b border-(--border) bg-(--err)/10 px-4 py-2 text-xs text-(--err)">
          {activeTab.error}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const distanceFromBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          stickToBottomRef.current = distanceFromBottom <= 80;
        }}
        className={`min-h-0 flex-1 overflow-y-auto px-6 py-10 ${showEmptyPrompt ? "flex" : ""}`}
      >
        <div
          className={`mx-auto w-full max-w-[var(--thread-w)] ${showEmptyPrompt ? "flex flex-1" : ""}`}
        >
          {showEmptyPrompt ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 -translate-y-12 text-center">
              <h1 className="text-[26px] font-semibold tracking-[-0.04em] text-(--fg)">
                A dream is something you do for yourself
              </h1>
              <p className="text-[12.5px] text-(--dim)">
                Ask the agent to edit, inspect, or run something. Tab to queue · paste/drop files.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {(activeTab?.messages ?? [])
                .filter((m) => m.role !== "system")
                .map((message) => (
                  <TimelineMessage key={message.id} message={message} />
                ))}
              {running ? (
                <div className="flex items-center gap-2 py-4 text-xs text-(--dim)">
                  <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-(--accent)" />
                  <span>Pi is {activeTab?.status}…</span>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <form onSubmit={sendMessage} className="shrink-0 bg-(--bg) px-6 pb-2 pt-1">
        <div
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
          className={`mx-auto max-w-[var(--composer-w)] overflow-hidden rounded-[var(--composer-radius)] border border-(--border) bg-(--composer) shadow-[var(--composer-shadow)] transition-shadow ${
            composerDragActive ? "ring-1 ring-(--accent)/60" : ""
          }`}
        >
          {composerDragActive ? (
            <div className="border-b border-(--accent)/50 bg-(--accent)/10 px-2 py-1.5 text-[11px] text-(--accent)">
              Drop files to attach to the next message.
            </div>
          ) : null}
          {(activeTab?.queue ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-b border-(--border)/50 px-2 py-1.5">
              {(activeTab?.queue ?? []).map((item) => (
                <span
                  key={item.id}
                  className="inline-flex max-w-[260px] items-center gap-1 rounded border border-(--accent)/60 bg-(--accent)/10 px-1.5 py-0.5 text-[11px] text-(--fg)"
                  title={`Queued (${item.mode}): ${item.text}`}
                >
                  <span className="rounded border border-(--accent)/40 px-1 text-[9px] uppercase text-(--accent)">
                    {item.mode === "steer" ? "steer" : "queue"}
                  </span>
                  <span className="truncate">{item.text}</span>
                  <button
                    type="button"
                    onClick={() => removeQueued(item.id)}
                    className="rounded p-0.5 text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
                    aria-label="Remove queued message"
                    title="Remove queued message"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-b border-(--border)/50 px-2 py-1.5">
              {attachments.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex max-w-[220px] items-center gap-1 rounded border border-(--border)/70 bg-(--bg) px-1.5 py-0.5 text-[11px] text-(--dim)"
                  title={`${file.name} · ${file.type} · ${formatFileSize(file.size)}${file.path ? ` · ${file.path}` : ""}`}
                >
                  {isImageAttachment(file) ? (
                    // Keep composer image previews intentionally small; the
                    // attachment is still sent at full inline/file fidelity.
                    <img
                      src={file.content}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded border border-(--border)/70 object-cover"
                    />
                  ) : (
                    <FileIcon className="h-3 w-3 shrink-0" />
                  )}
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 opacity-70">{formatFileSize(file.size)}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((current) => current.filter((item) => item.id !== file.id))
                    }
                    className="rounded p-0.5 hover:bg-(--surface) hover:text-(--fg)"
                    aria-label={`Remove ${file.name}`}
                    title={`Remove ${file.name}`}
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={activeTab?.input ?? ""}
            onPaste={handleComposerPaste}
            onChange={(event) => {
              const value = event.target.value;
              if (!activeTab) return;
              updateTab(activeTab.id, (tab) => ({ ...tab, input: value }));
              const element = event.currentTarget;
              if (!value) {
                element.style.height = "";
                setIsMultiline(false);
                return;
              }
              element.style.height = "auto";
              element.style.height = `${element.scrollHeight}px`;
              setIsMultiline(element.scrollHeight > 38);
            }}
            onKeyDown={(event) => {
              // Enter (no shift) → send. While running, this becomes a steer.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
                return;
              }
              // Tab → queue (follow-up). Captured even while running so the
              // user can pile up tasks while the agent is working.
              if (event.key === "Tab" && !event.shiftKey) {
                if (!activeTab?.input.trim()) return;
                event.preventDefault();
                void queueMessage();
                return;
              }
              // Esc → pause (abort). Cmd/Ctrl+. for parity.
              if (
                event.key === "Escape" ||
                (event.key === "." && (event.metaKey || event.ctrlKey))
              ) {
                if (running) {
                  event.preventDefault();
                  void abortTurn();
                }
              }
            }}
            placeholder={
              !modelName && modelsLoading
                ? "Loading models…"
                : !modelName
                  ? "No models available — check /v1/models"
                  : running
                    ? `Steer ${modelName} (Enter) · queue with Tab · Esc to pause`
                    : `Ask ${modelName} (Enter) · queue with Tab · paste/drop files`
            }
            className="min-h-[42px] max-h-[132px] w-full resize-none overflow-y-auto bg-transparent px-4 py-2 text-sm leading-5 text-(--fg) outline-none placeholder:text-(--dim)"
          />
          <div className="flex min-h-10 items-center gap-1.5 overflow-hidden border-t border-(--border) bg-(--composer-footer) px-3 py-1.5 text-xs">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => void attachFiles(event.currentTarget.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={readingAttachments || running}
              className="inline-flex !h-7 !min-h-7 !w-7 !min-w-7 shrink-0 items-center justify-center rounded-md text-(--dim) hover:bg-(--bg) hover:text-(--fg) disabled:opacity-30"
              aria-label="Attach files"
              title="Attach files (or paste/drop into composer)"
            >
              <AttachIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleBrowserTool}
              aria-pressed={browserToolEnabled}
              title={
                browserToolEnabled
                  ? "Browser tool: ON — agent can drive the browser"
                  : "Browser tool: OFF — click to let the agent navigate, click, fill, and read pages"
              }
              className={`inline-flex !h-7 !min-h-7 !w-7 !min-w-7 shrink-0 items-center justify-center rounded-md ${
                browserToolEnabled
                  ? "bg-(--accent)/10 text-(--accent)"
                  : "text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
              }`}
            >
              <GlobeIcon className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              {projectSelector ? (
                projectSelector
              ) : cwd ? (
                <span className="block min-w-0 truncate font-mono text-[11px] text-(--dim)">
                  {cwd}
                </span>
              ) : null}
            </div>
            {gitBranch ? (
              <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-(--dim)">
                <GitBranchIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{gitBranch}</span>
              </span>
            ) : gitSummary && !gitSummary.isRepo ? (
              <button
                type="button"
                onClick={onInitGit}
                className="inline-flex !h-7 !min-h-7 !w-7 !min-w-7 shrink-0 items-center justify-center rounded-md text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
                aria-label="Initialize git repository"
                title="Init git"
              >
                <GitBranchIcon className="h-3 w-3" />
              </button>
            ) : null}
            {gitSummary?.isRepo ? (
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px]">
                <span className="text-emerald-400">+{gitSummary.additions}</span>
                <span className="text-red-400">-{gitSummary.deletions}</span>
                {gitSummary.statusCount > 0 ? (
                  <span className="text-(--dim)">· {gitSummary.statusCount} files</span>
                ) : null}
              </span>
            ) : null}
            {modelSelector}
            <div className="flex shrink-0 items-center gap-1">
              {running ? (
                <>
                  {activeTab?.input.trim() ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void queueMessage()}
                        className="inline-flex !h-7 !min-h-7 shrink-0 items-center rounded-md px-2 text-[11px] text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
                        title="Queue (Tab)"
                      >
                        Queue
                      </button>
                      <button
                        type="submit"
                        className="inline-flex !h-7 !min-h-7 shrink-0 items-center gap-1 rounded-md bg-(--accent)/10 px-2 text-[11px] text-(--accent) hover:bg-(--accent)/20"
                        title="Steer (Enter): interrupt current turn and send"
                      >
                        <SendIcon className="h-3 w-3" /> Steer
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void abortTurn()}
                    className="inline-flex !h-7 !min-h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
                    title="Pause (Esc)"
                  >
                    <StopIcon className="h-3 w-3" /> Pause
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  disabled={
                    (!activeTab?.input.trim() && attachments.length === 0) ||
                    !modelId ||
                    readingAttachments
                  }
                  className="inline-flex !h-7 !min-h-7 !w-7 !min-w-7 shrink-0 items-center justify-center rounded-md text-(--fg) hover:bg-(--bg) disabled:opacity-30"
                  aria-label="Send"
                  title="Send (Enter) · Queue (Tab)"
                >
                  <SendIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mx-auto mt-0.5 flex max-w-3xl items-center justify-end gap-2 font-mono text-[10px] text-(--dim)">
          <span>R {formatTokenCount(activeTab?.tokenStats?.read ?? 0)}</span>
          <span>W {formatTokenCount(activeTab?.tokenStats?.write ?? 0)}</span>
          <span>
            {formatTokenCount(activeTab?.tokenStats?.current ?? 0)}/
            {formatTokenCount(contextWindow)}
          </span>
        </div>
      </form>
    </section>
  );
}

export function SessionTabsBar({
  paneId,
  tabs,
  activeTabId,
  onActiveTabChange,
  onTabsChange,
  onRenameTab,
}: {
  paneId: string;
  tabs: SessionTab[];
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  onTabsChange: (tabs: SessionTab[] | ((tabs: SessionTab[]) => SessionTab[])) => void;
  onRenameTab: (tabId: string, title: string) => void;
}) {
  const closeTab = useCallback(
    (tabId: string) => {
      const remaining = tabs.filter((tab) => tab.id !== tabId);
      if (remaining.length === 0) {
        const fresh = makeFreshTab();
        onTabsChange([fresh]);
        onActiveTabChange(fresh.id);
        return;
      }
      onTabsChange(remaining);
      if (activeTabId === tabId) onActiveTabChange(remaining[remaining.length - 1].id);
    },
    [tabs, activeTabId, onTabsChange, onActiveTabChange],
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          paneId={paneId}
          active={tab.id === activeTabId}
          onSelect={() => onActiveTabChange(tab.id)}
          onClose={() => closeTab(tab.id)}
          onRename={(title) => onRenameTab(tab.id, title)}
        />
      ))}
    </div>
  );
}

function TabPill({
  tab,
  paneId,
  active,
  onSelect,
  onClose,
  onRename,
}: {
  tab: SessionTab;
  paneId: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tab.title);

  const finishRename = useCallback(() => {
    const next = draft.trim();
    if (next) onRename(next.slice(0, 80));
    setRenaming(false);
  }, [draft, onRename]);

  return (
    <div
      role="tab"
      aria-selected={active}
      draggable
      onDragStart={(event) => {
        if (tab.piSessionId) {
          event.dataTransfer.setData("application/x-vllm-session", tab.piSessionId);
        }
        event.dataTransfer.setData(
          "application/x-vllm-agent-session",
          JSON.stringify({
            piSessionId: tab.piSessionId,
            projectId: tab.projectId,
            cwd: tab.cwd,
            paneId,
            tabId: tab.id,
            title: tab.title,
          }),
        );
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setDraft(tab.title);
        setRenaming(true);
      }}
      title={tab.title}
      className={`group flex h-7 max-w-[200px] shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs ${
        active
          ? "border-(--border) bg-(--bg) text-(--fg)"
          : "border-transparent text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
      }`}
    >
      {renaming ? (
        <input
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={finishRename}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") finishRename();
            if (event.key === "Escape") {
              setDraft(tab.title);
              setRenaming(false);
            }
          }}
          className="min-w-0 bg-transparent outline-none"
        />
      ) : (
        <span className="truncate">{tab.title}</span>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="rounded p-0.5 text-(--dim) opacity-0 hover:bg-(--surface) hover:text-(--fg) group-hover:opacity-100"
        aria-label="Close tab"
        title="Close tab"
      >
        <CloseIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

function TimelineMessage({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  if (isUser) {
    return (
      <article className="flex justify-end">
        <div className="max-w-[72%] rounded-xl bg-(--surface) px-3.5 py-2 text-sm leading-6 text-(--fg)">
          <div className="whitespace-pre-wrap break-words">{message.text}</div>
        </div>
      </article>
    );
  }
  const blocks = message.blocks ?? [];
  return (
    <article className="min-w-0">
      {blocks.length === 0 ? (
        <div className="text-sm leading-6 text-(--dim)">…</div>
      ) : (
        <div className="flex flex-col gap-3">
          {blocks.map((block) => {
            if (block.kind === "thinking") {
              return (
                <details key={block.id} className="text-xs" open>
                  <summary className="cursor-pointer list-none text-[11px] italic text-(--dim) hover:text-(--fg)">
                    Thinking
                  </summary>
                  <pre className="mt-2 max-w-full whitespace-pre-wrap break-words border-l-2 border-(--border) pl-3 font-mono text-[11px] leading-5 text-(--dim) [overflow-wrap:anywhere]">
                    {block.text}
                  </pre>
                </details>
              );
            }
            if (block.kind === "text") {
              return <AssistantMarkdown key={block.id} text={block.text} />;
            }
            return <ToolBlockView key={block.id} block={block} />;
          })}
        </div>
      )}
    </article>
  );
}

// ----- Tool block rendering -----

const FILE_WRITE_TOOL_NAMES = new Set([
  "write_file",
  "write",
  "create_file",
  "edit_file",
  "edit",
  "apply_patch",
  "apply_edit",
  "replace_file",
  "str_replace_editor",
]);

const LANG_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  json: "json",
  md: "md",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  py: "py",
  rs: "rs",
  go: "go",
  sh: "sh",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

function detectLang(filePath: string | null | undefined): string {
  if (!filePath) return "";
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "";
  const ext = filePath.slice(dot + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? "";
}

// Try to extract a streaming-friendly preview of "what file is being written"
// from the partially-parsed tool args. We accept partial JSON: greedy extract
// the value of the most likely "content" / "text" / "patch" key.
function extractPartialField(argsText: string, keys: string[]): string | null {
  if (!argsText) return null;
  for (const key of keys) {
    const needle = `"${key}"`;
    const idx = argsText.indexOf(needle);
    if (idx === -1) continue;
    // Find the colon and the opening quote of the value.
    const colon = argsText.indexOf(":", idx + needle.length);
    if (colon === -1) continue;
    let i = colon + 1;
    while (i < argsText.length && /\s/.test(argsText[i])) i += 1;
    if (argsText[i] !== '"') continue;
    let j = i + 1;
    let out = "";
    while (j < argsText.length) {
      const ch = argsText[j];
      if (ch === "\\") {
        const next = argsText[j + 1];
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "r") out += "\r";
        else if (next === '"') out += '"';
        else if (next === "\\") out += "\\";
        else if (next === undefined) break;
        else out += next;
        j += 2;
        continue;
      }
      if (ch === '"') return out;
      out += ch;
      j += 1;
    }
    // Unterminated string — return what we have so far for live streaming.
    return out;
  }
  return null;
}

function extractFromArgs(
  args: Record<string, unknown> | undefined,
  argsText: string | undefined,
  keys: string[],
): string | null {
  if (args) {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string") return value;
    }
  }
  if (argsText) return extractPartialField(argsText, keys);
  return null;
}

function compactToolText(value: string | null | undefined, limit = 88): string | null {
  if (!value) return null;
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function fileBasename(path: string | null | undefined): string | null {
  if (!path) return null;
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return clean.slice(slash + 1) || clean;
}

function humanizeToolName(name: string): string {
  return name
    .replace(/^functions[._-]/, "")
    .replace(/^mcp__[a-z0-9_-]+__/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function hasAnyNeedle(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function toolArg(
  block: ToolBlock,
  keys: string[],
  fallback?: string | null | undefined,
): string | null {
  return extractFromArgs(block.args, block.argsText, keys) ?? fallback ?? null;
}

function toolMeta(block: ToolBlock, filePath?: string | null) {
  const name = block.name.toLowerCase();
  const path = toolArg(block, [
    "path",
    "file_path",
    "filePath",
    "file",
    "filename",
    "target_file",
    "uri",
    "ref_id",
  ]);
  const query = toolArg(block, ["query", "q", "pattern", "search", "search_query", "needle"]);
  const command = toolArg(block, ["cmd", "command", "script", "shell", "input"]);
  const url = toolArg(block, ["url", "href"]);
  const resolvedPath = filePath ?? path;
  const basename = fileBasename(resolvedPath);

  if (FILE_WRITE_TOOL_NAMES.has(name) || hasAnyNeedle(name, ["edit", "write", "patch"])) {
    return {
      icon: <PencilLine className="h-4 w-4" />,
      label: basename ? `Edited ${basename}` : humanizeToolName(block.name),
      detail: resolvedPath && basename !== resolvedPath ? resolvedPath : null,
    };
  }
  if (hasAnyNeedle(name, ["search", "grep", "find", "ripgrep", "rg"])) {
    return {
      icon: <Search className="h-4 w-4" />,
      label: compactToolText(query, 80)
        ? `Searched for ${compactToolText(query, 80)}`
        : "Searched files",
      detail: path && !query ? path : null,
    };
  }
  if (hasAnyNeedle(name, ["read", "open", "cat", "view", "list"])) {
    return {
      icon: <FileText className="h-4 w-4" />,
      label: basename ? `Read ${basename}` : humanizeToolName(block.name),
      detail: resolvedPath && basename !== resolvedPath ? resolvedPath : null,
    };
  }
  if (hasAnyNeedle(name, ["exec", "command", "shell", "bash", "run", "terminal"])) {
    return {
      icon: <TerminalSquare className="h-4 w-4" />,
      label: "Ran command",
      detail: compactToolText(command, 110),
    };
  }
  if (hasAnyNeedle(name, ["browser", "web", "open_url", "navigate"])) {
    return {
      icon: <GlobeIcon className="h-4 w-4" />,
      label: "Used browser",
      detail: compactToolText(url, 110),
    };
  }
  return {
    icon: <Wrench className="h-4 w-4" />,
    label: humanizeToolName(block.name),
    detail: compactToolText(command ?? query ?? path ?? url, 110),
  };
}

function ToolStatus({ status }: { status: ToolBlock["status"] }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-(--dim)">
        <Loader2 className="h-3 w-3 animate-spin" />
        running
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-(--err)">
        <AlertTriangle className="h-3 w-3" />
        error
      </span>
    );
  }
  return null;
}

function ToolSummary({
  block,
  filePath,
  children,
  open = false,
}: {
  block: ToolBlock;
  filePath?: string | null;
  children?: ReactNode;
  open?: boolean;
}) {
  const meta = toolMeta(block, filePath);
  return (
    <details className="group py-0.5" open={open}>
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md py-1 text-(--dim) hover:text-(--fg) [&::-webkit-details-marker]:hidden">
        <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center opacity-80">
          {meta.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-6">{meta.label}</span>
          {meta.detail ? (
            <span className="block truncate font-mono text-[11px] leading-4 opacity-70">
              {meta.detail}
            </span>
          ) : null}
        </span>
        <ToolStatus status={block.status} />
        {children ? (
          <ChevronDownIcon className="mt-1 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
        ) : null}
      </summary>
      {children ? <div className="ml-6 mt-1">{children}</div> : null}
    </details>
  );
}

function ToolOutput({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-(--dim) [overflow-wrap:anywhere]">
      {children}
    </pre>
  );
}

function ToolBlockView({ block }: { block: ToolBlock }) {
  const isFileWrite = FILE_WRITE_TOOL_NAMES.has(block.name.toLowerCase());
  const filePath = isFileWrite
    ? extractFromArgs(block.args, block.argsText, ["path", "file_path", "filePath", "file"])
    : null;
  const fileContent = isFileWrite
    ? extractFromArgs(block.args, block.argsText, ["content", "text", "newText", "new_content"])
    : null;
  const patchContent = isFileWrite
    ? extractFromArgs(block.args, block.argsText, ["patch", "diff", "edits"])
    : null;
  const lang = detectLang(filePath);
  const isHtml = lang === "html";
  const [showPreview, setShowPreview] = useState(false);

  if (isFileWrite && (fileContent !== null || patchContent !== null)) {
    const body = fileContent ?? patchContent ?? "";
    return (
      <ToolSummary block={block} filePath={filePath} open>
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.08em] text-(--dim)">
          <span>{lang || "source"}</span>
          {isHtml ? (
            <button
              type="button"
              onClick={() => setShowPreview((value) => !value)}
              className="rounded-md px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-(--dim) hover:bg-(--hover) hover:text-(--fg)"
            >
              {showPreview ? "Source" : "Preview"}
            </button>
          ) : null}
        </div>
        {isHtml && showPreview ? (
          <iframe
            sandbox=""
            srcDoc={body}
            className="h-72 w-full rounded-md border border-(--border) bg-white"
            title={filePath ?? "preview"}
          />
        ) : (
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-(--border)/70 bg-(--surface)/35 p-2 font-mono text-[11px] leading-5 text-(--fg)">
            {body}
          </pre>
        )}
        {block.resultText ? (
          <div className="mt-1 font-mono text-[10px] text-(--dim)">
            <ToolOutput>{block.resultText}</ToolOutput>
          </div>
        ) : null}
      </ToolSummary>
    );
  }

  // Generic fallback (shells, reads, searches, browser tools, etc.).
  const display =
    block.resultText || (block.text && block.text !== block.argsText ? block.text : "");
  return (
    <ToolSummary
      block={block}
      open={block.status === "running" || (Boolean(display) && display.length < 2400)}
    >
      {display ? <ToolOutput>{display}</ToolOutput> : null}
    </ToolSummary>
  );
}
