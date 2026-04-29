"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Folder,
  GitBranch,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { AssistantMarkdown } from "./assistant-markdown";
import { SessionsSidebar } from "./sessions-sidebar";

type WebviewElement = HTMLElement & {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  src: string;
};

type AgentModel = {
  id: string;
  name: string;
  provider: "vllm-studio";
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
};

type ToolBlock = {
  kind: "tool";
  id: string; // toolCallId
  name: string;
  status: "running" | "done" | "error";
  text: string;
};

type TextBlock = { kind: "text"; id: string; text: string };
type ThinkingBlock = { kind: "thinking"; id: string; text: string };

type AssistantBlock = TextBlock | ThinkingBlock | ToolBlock;

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  // For user/system messages, plain text is enough.
  text: string;
  // For assistant messages, blocks preserves the temporal order of
  // thinking / text / tool events as they arrive from the pi RPC stream.
  blocks?: AssistantBlock[];
  timestamp?: string;
};

type StreamPayload =
  | { type: "status"; phase: string; [key: string]: unknown }
  | { type: "error"; error: string }
  | { type: "pi"; event: Record<string, unknown> };

type ProjectEntry = {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  exists: boolean;
  hasGit: boolean;
  branch: string | null;
};

type DesktopBridge = {
  openDirectory: () => Promise<ProjectEntry | null>;
  listProjects: () => Promise<ProjectEntry[]>;
  addProject: (directoryPath: string) => Promise<ProjectEntry>;
  removeProject: (id: string) => Promise<{ ok: true }>;
};

const SESSION_ID = "vllm-studio-agent";
const DEFAULT_AGENT_CWD = "";
const SELECTED_PROJECT_KEY = "vllm-studio.agent.selectedProjectId";
const SESSIONS_COLLAPSED_KEY = "vllm-studio.agent.sessionsCollapsed";
const ACTIVE_PI_SESSION_KEY = "vllm-studio.agent.activePiSessionId";

function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { vllmStudioDesktop?: Partial<DesktopBridge> })
    .vllmStudioDesktop;
  if (!candidate) return null;
  if (
    typeof candidate.openDirectory !== "function" ||
    typeof candidate.listProjects !== "function" ||
    typeof candidate.addProject !== "function" ||
    typeof candidate.removeProject !== "function"
  ) {
    return null;
  }
  return candidate as DesktopBridge;
}

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowLabel() {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(),
  );
}

function extractToolText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const result = value as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Append a delta to the last block of `kind` if it's currently at the end of
// the timeline; otherwise start a fresh block. This preserves the temporal
// order in which Pi emits thinking / text / tool events.
function appendDelta(
  blocks: AssistantBlock[],
  kind: "text" | "thinking",
  delta: string,
): AssistantBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    const updated: AssistantBlock = { ...last, text: last.text + delta };
    return [...blocks.slice(0, -1), updated];
  }
  return [...blocks, { kind, id: newId(kind), text: delta }];
}

function upsertTool(
  blocks: AssistantBlock[],
  toolCallId: string,
  patch: (tool: ToolBlock) => ToolBlock,
  fallback: () => ToolBlock,
): AssistantBlock[] {
  const idx = blocks.findIndex((b) => b.kind === "tool" && b.id === toolCallId);
  if (idx === -1) return [...blocks, fallback()];
  const next = blocks.slice();
  next[idx] = patch(next[idx] as ToolBlock);
  return next;
}

export function AgentWorkspace() {
  const [models, setModels] = useState<AgentModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [agentCwd, setAgentCwd] = useState(DEFAULT_AGENT_CWD);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "system",
      timestamp: nowLabel(),
      text: "T3 Code shell mounted inside vLLM Studio. The only provider is Pi coding-agent, configured from the active backend /v1/models.",
    },
  ]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [loadingModels, setLoadingModels] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [isMultiline, setIsMultiline] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("https://duckduckgo.com");
  const [browserInput, setBrowserInput] = useState("https://duckduckgo.com");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectPickerInput, setProjectPickerInput] = useState("");
  const [projectPickerError, setProjectPickerError] = useState("");
  const [activePiSessionId, setActivePiSessionId] = useState<string | null>(null);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const isElectron = typeof window !== "undefined" && /electron/i.test(navigator.userAgent);
  const desktopBridge = useMemo<DesktopBridge | null>(() => getDesktopBridge(), []);

  const activeModel = useMemo(
    () => models.find((model) => model.id === selectedModel),
    [models, selectedModel],
  );
  const running = status === "running" || status === "starting";

  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      setLoadingModels(true);
      setError("");
      try {
        const response = await fetch("/api/agent/models", { cache: "no-store" });
        const payload = (await response.json()) as { models?: AgentModel[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to load models");
        if (cancelled) return;
        const nextModels = payload.models ?? [];
        setModels(nextModels);
        setSelectedModel((current) => current || nextModels[0]?.id || "");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load models");
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    }
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status]);

  // Restore the sessions sidebar collapsed/expanded preference + the last
  // resumed pi session id across reloads.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const collapsed = window.localStorage.getItem(SESSIONS_COLLAPSED_KEY);
    if (collapsed === "1") setSessionsCollapsed(true);
    const last = window.localStorage.getItem(ACTIVE_PI_SESSION_KEY);
    if (last) setActivePiSessionId(last);
  }, []);

  const persistSessionsCollapsed = useCallback((value: boolean) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SESSIONS_COLLAPSED_KEY, value ? "1" : "0");
  }, []);

  const persistActivePiSessionId = useCallback((id: string | null) => {
    if (typeof window === "undefined") return;
    if (id) window.localStorage.setItem(ACTIVE_PI_SESSION_KEY, id);
    else window.localStorage.removeItem(ACTIVE_PI_SESSION_KEY);
  }, []);

  const loadProjects = useCallback(async (): Promise<ProjectEntry[]> => {
    if (desktopBridge) {
      return desktopBridge.listProjects();
    }
    const response = await fetch("/api/agent/projects", { cache: "no-store" });
    const payload = (await response.json()) as { projects?: ProjectEntry[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "Failed to load projects");
    return payload.projects ?? [];
  }, [desktopBridge]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await loadProjects();
        if (cancelled) return;
        setProjects(list);
        const stored =
          typeof window !== "undefined" ? window.localStorage.getItem(SELECTED_PROJECT_KEY) : null;
        const initial = (stored && list.find((entry) => entry.id === stored)) || list[0];
        if (initial) {
          setSelectedProjectId(initial.id);
          setAgentCwd(initial.path);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[agent] failed to load projects", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProjects]);

  const persistSelectedProjectId = useCallback((id: string | null) => {
    if (typeof window === "undefined") return;
    if (id) {
      window.localStorage.setItem(SELECTED_PROJECT_KEY, id);
    } else {
      window.localStorage.removeItem(SELECTED_PROJECT_KEY);
    }
  }, []);

  const selectProject = useCallback(
    (project: ProjectEntry) => {
      setSelectedProjectId(project.id);
      setAgentCwd(project.path);
      persistSelectedProjectId(project.id);
      // A different project has its own session pool — clear the active pi
      // session so the next turn starts a fresh one in the new project.
      setActivePiSessionId(null);
      persistActivePiSessionId(null);
      setMessages([]);
    },
    [persistActivePiSessionId, persistSelectedProjectId],
  );

  const addProjectFromPath = useCallback(
    async (rawPath: string): Promise<ProjectEntry> => {
      if (desktopBridge) {
        return desktopBridge.addProject(rawPath);
      }
      const response = await fetch("/api/agent/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rawPath }),
      });
      const payload = (await response.json()) as { project?: ProjectEntry; error?: string };
      if (!response.ok || !payload.project) {
        throw new Error(payload.error || "Failed to add project");
      }
      return payload.project;
    },
    [desktopBridge],
  );

  const handleOpenProject = useCallback(async () => {
    setProjectPickerError("");
    if (desktopBridge) {
      try {
        const project = await desktopBridge.openDirectory();
        if (!project) return;
        const list = await loadProjects();
        setProjects(list);
        selectProject(project);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open directory");
      }
      return;
    }
    setProjectPickerInput("");
    setProjectPickerOpen(true);
  }, [desktopBridge, loadProjects, selectProject]);

  const submitProjectPicker = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const value = projectPickerInput.trim();
      if (!value) return;
      try {
        const project = await addProjectFromPath(value);
        const list = await loadProjects();
        setProjects(list);
        selectProject(project);
        setProjectPickerOpen(false);
        setProjectPickerInput("");
        setProjectPickerError("");
      } catch (err) {
        setProjectPickerError(err instanceof Error ? err.message : "Failed to add project");
      }
    },
    [addProjectFromPath, loadProjects, projectPickerInput, selectProject],
  );

  const removeProjectById = useCallback(
    async (id: string) => {
      try {
        if (desktopBridge) {
          await desktopBridge.removeProject(id);
        } else {
          const response = await fetch(`/api/agent/projects?id=${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(payload.error || "Failed to remove project");
          }
        }
        const list = await loadProjects();
        setProjects(list);
        if (selectedProjectId === id) {
          const next = list[0] ?? null;
          if (next) {
            selectProject(next);
          } else {
            setSelectedProjectId(null);
            persistSelectedProjectId(null);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove project");
      }
    },
    [desktopBridge, loadProjects, persistSelectedProjectId, selectProject, selectedProjectId],
  );

  const handleCwdInputChange = useCallback(
    (value: string) => {
      setAgentCwd(value);
      const match = projects.find((entry) => entry.path === value.trim().replace(/\/+$/, ""));
      if (match) {
        if (selectedProjectId !== match.id) {
          setSelectedProjectId(match.id);
          persistSelectedProjectId(match.id);
        }
      } else if (selectedProjectId !== null) {
        setSelectedProjectId(null);
        persistSelectedProjectId(null);
      }
    },
    [persistSelectedProjectId, projects, selectedProjectId],
  );

  function patchAssistant(id: string, patch: (message: ChatMessage) => ChatMessage) {
    setMessages((current) =>
      current.map((message) => (message.id === id ? patch(message) : message)),
    );
  }

  function applyPiEvent(assistantId: string, event: Record<string, unknown>) {
    const eventType = event.type;

    if (eventType === "message_update") {
      const assistantMessageEvent = event.assistantMessageEvent as
        | Record<string, unknown>
        | undefined;
      const updateType = assistantMessageEvent?.type;

      if (updateType === "text_delta" && typeof assistantMessageEvent?.delta === "string") {
        const delta = assistantMessageEvent.delta;
        patchAssistant(assistantId, (message) => ({
          ...message,
          blocks: appendDelta(message.blocks ?? [], "text", delta),
        }));
        return;
      }

      if (updateType === "thinking_delta" && typeof assistantMessageEvent?.delta === "string") {
        const delta = assistantMessageEvent.delta;
        patchAssistant(assistantId, (message) => ({
          ...message,
          blocks: appendDelta(message.blocks ?? [], "thinking", delta),
        }));
        return;
      }

      if (updateType === "toolcall_end") {
        const toolCall = assistantMessageEvent?.toolCall as
          | { id?: string; name?: string; arguments?: unknown }
          | undefined;
        if (!toolCall) return;
        const id = toolCall.id || newId("tool");
        const name = toolCall.name || "tool";
        const text = JSON.stringify(toolCall.arguments ?? {}, null, 2);
        patchAssistant(assistantId, (message) => ({
          ...message,
          blocks: upsertTool(
            message.blocks ?? [],
            id,
            (existing) => ({ ...existing, text: existing.text || text }),
            () => ({ kind: "tool", id, name, status: "running", text }),
          ),
        }));
        return;
      }
    }

    if (eventType === "tool_execution_start") {
      const id = String(event.toolCallId || newId("tool"));
      const name = String(event.toolName || "tool");
      patchAssistant(assistantId, (message) => ({
        ...message,
        blocks: upsertTool(
          message.blocks ?? [],
          id,
          (existing) => existing,
          () => ({ kind: "tool", id, name, status: "running", text: "" }),
        ),
      }));
      return;
    }

    if (eventType === "tool_execution_update" || eventType === "tool_execution_end") {
      const id = String(event.toolCallId || "");
      if (!id) return;
      const resultText = extractToolText(event.partialResult || event.result);
      patchAssistant(assistantId, (message) => ({
        ...message,
        blocks: upsertTool(
          message.blocks ?? [],
          id,
          (existing) => ({
            ...existing,
            status:
              eventType === "tool_execution_end"
                ? ((event.isError ? "error" : "done") as ToolBlock["status"])
                : existing.status,
            text: resultText || existing.text,
          }),
          () => ({
            kind: "tool",
            id,
            name: "tool",
            status:
              eventType === "tool_execution_end"
                ? ((event.isError ? "error" : "done") as ToolBlock["status"])
                : "running",
            text: resultText,
          }),
        ),
      }));
      return;
    }

    // message_end is intentionally a no-op for assistant content. We've already
    // streamed all blocks in order via the deltas above; reapplying flattened
    // text/thinking from the final payload would re-collapse them and lose the
    // interleaved order.
  }

  // Replay a past pi session into the renderer by hydrating user messages
  // (recorded as message_end events with role=user) and walking every other
  // event through applyPiEvent so the same block-ordered timeline used for
  // live turns is reused for replay.
  const loadAndReplaySession = useCallback(
    async (cwd: string, piSessionId: string) => {
      setError("");
      setStatus("loading");
      try {
        const response = await fetch(
          `/api/agent/sessions/${encodeURIComponent(piSessionId)}?cwd=${encodeURIComponent(cwd)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as { events?: Record<string, unknown>[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to load session");

        const replayed: ChatMessage[] = [];
        let pendingAssistantId: string | null = null;
        const ensureAssistant = () => {
          if (pendingAssistantId) return pendingAssistantId;
          const id = newId("assistant");
          replayed.push({ id, role: "assistant", text: "", blocks: [], timestamp: nowLabel() });
          pendingAssistantId = id;
          return id;
        };
        const flushAssistant = () => {
          pendingAssistantId = null;
        };

        // We mutate `replayed` in place by reusing applyPiEvent's logic on a
        // local working set rather than going through React state for each of
        // potentially thousands of events.
        const localPatch = (assistantId: string, patch: (msg: ChatMessage) => ChatMessage) => {
          const idx = replayed.findIndex((m) => m.id === assistantId);
          if (idx !== -1) replayed[idx] = patch(replayed[idx]);
        };

        for (const event of payload.events ?? []) {
          const type = event.type;
          if (type === "message_end") {
            const message = event.message as
              | {
                  role?: string;
                  content?: Array<{ type?: string; text?: string; thinking?: string }>;
                }
              | undefined;
            if (message?.role === "user") {
              flushAssistant();
              const text = Array.isArray(message.content)
                ? message.content
                    .filter((part) => part?.type === "text" && typeof part.text === "string")
                    .map((part) => part.text)
                    .join("\n")
                : "";
              if (text) {
                replayed.push({
                  id: newId("user"),
                  role: "user",
                  text,
                  timestamp: nowLabel(),
                });
              }
              continue;
            }
            if (message?.role === "assistant" && pendingAssistantId) {
              flushAssistant();
              continue;
            }
          }

          // Everything else (text_delta, thinking_delta, toolcall_end,
          // tool_execution_*) feeds into the active assistant turn.
          const assistantId = ensureAssistant();
          const before = replayed.find((m) => m.id === assistantId);
          if (!before) continue;
          // Apply the same logic locally. This intentionally duplicates a tiny
          // portion of applyPiEvent because it operates on the local array
          // rather than React state.
          const eventType = event.type;
          if (eventType === "message_update") {
            const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
            const updateType = ame?.type;
            if (updateType === "text_delta" && typeof ame?.delta === "string") {
              const delta = ame.delta;
              localPatch(assistantId, (msg) => ({
                ...msg,
                blocks: appendDelta(msg.blocks ?? [], "text", delta),
              }));
            } else if (updateType === "thinking_delta" && typeof ame?.delta === "string") {
              const delta = ame.delta;
              localPatch(assistantId, (msg) => ({
                ...msg,
                blocks: appendDelta(msg.blocks ?? [], "thinking", delta),
              }));
            } else if (updateType === "toolcall_end") {
              const toolCall = ame?.toolCall as
                | { id?: string; name?: string; arguments?: unknown }
                | undefined;
              if (toolCall) {
                const id = toolCall.id || newId("tool");
                const name = toolCall.name || "tool";
                const text = JSON.stringify(toolCall.arguments ?? {}, null, 2);
                localPatch(assistantId, (msg) => ({
                  ...msg,
                  blocks: upsertTool(
                    msg.blocks ?? [],
                    id,
                    (existing) => ({ ...existing, text: existing.text || text }),
                    () => ({ kind: "tool", id, name, status: "running", text }),
                  ),
                }));
              }
            }
          } else if (eventType === "tool_execution_start") {
            const id = String(event.toolCallId || newId("tool"));
            const name = String(event.toolName || "tool");
            localPatch(assistantId, (msg) => ({
              ...msg,
              blocks: upsertTool(
                msg.blocks ?? [],
                id,
                (existing) => existing,
                () => ({ kind: "tool", id, name, status: "running", text: "" }),
              ),
            }));
          } else if (eventType === "tool_execution_update" || eventType === "tool_execution_end") {
            const id = String(event.toolCallId || "");
            if (id) {
              const resultText = extractToolText(event.partialResult || event.result);
              localPatch(assistantId, (msg) => ({
                ...msg,
                blocks: upsertTool(
                  msg.blocks ?? [],
                  id,
                  (existing) => ({
                    ...existing,
                    status:
                      eventType === "tool_execution_end"
                        ? ((event.isError ? "error" : "done") as ToolBlock["status"])
                        : existing.status,
                    text: resultText || existing.text,
                  }),
                  () => ({
                    kind: "tool",
                    id,
                    name: "tool",
                    status:
                      eventType === "tool_execution_end"
                        ? ((event.isError ? "error" : "done") as ToolBlock["status"])
                        : "running",
                    text: resultText,
                  }),
                ),
              }));
            }
          }
        }

        setMessages(replayed);
        setActivePiSessionId(piSessionId);
        persistActivePiSessionId(piSessionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load session");
      } finally {
        setStatus("idle");
      }
    },
    [persistActivePiSessionId],
  );

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || !selectedModel || running) return;

    const userId = newId("user");
    const assistantId = newId("assistant");
    setInput("");
    setIsMultiline(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "";
    }
    setError("");
    setStatus("starting");
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", text, timestamp: nowLabel() },
      { id: assistantId, role: "assistant", text: "", blocks: [], timestamp: nowLabel() },
    ]);

    try {
      const response = await fetch("/api/agent/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          modelId: selectedModel,
          message: text,
          // Send undefined (not empty string) when no project picked so the
          // server-side resolver can fall back to the last-used project / $HOME.
          cwd: agentCwd.trim() || undefined,
          piSessionId: activePiSessionId,
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
          const payload = JSON.parse(line.slice(6)) as StreamPayload;
          if (payload.type === "status")
            setStatus(payload.phase === "done" ? "idle" : payload.phase);
          if (payload.type === "error") {
            setError(payload.error);
            setStatus("idle");
          }
          if (payload.type === "pi") {
            const piEvent = payload.event;
            // Capture the session id pi assigns when starting fresh. Subsequent
            // turns will pass this back in `piSessionId` so the same session
            // continues, and the sidebar can highlight the active row.
            const eventId = piEvent.id;
            if (piEvent.type === "session" && typeof eventId === "string") {
              if (activePiSessionId !== eventId) {
                setActivePiSessionId(eventId);
                persistActivePiSessionId(eventId);
              }
            }
            applyPiEvent(assistantId, piEvent);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent request failed");
    } finally {
      setStatus("idle");
    }
  }

  async function abortTurn() {
    await fetch("/api/agent/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    }).catch(() => undefined);
    setStatus("idle");
  }

  function normalizeBrowserInput(raw: string): string {
    const value = raw.trim();
    if (!value) return "https://duckduckgo.com";
    if (/^https?:\/\//i.test(value)) return value;
    if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(value) || /^localhost(:\d+)?/i.test(value)) {
      return `https://${value}`;
    }
    return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
  }

  function submitBrowserUrl(event: FormEvent) {
    event.preventDefault();
    const next = normalizeBrowserInput(browserInput);
    setBrowserInput(next);
    setBrowserUrl(next);
  }

  function browserBack() {
    if (isElectron && webviewRef.current) {
      webviewRef.current.goBack();
    }
  }

  function browserForward() {
    if (isElectron && webviewRef.current) {
      webviewRef.current.goForward();
    }
  }

  function browserReload() {
    if (isElectron && webviewRef.current) {
      webviewRef.current.reload();
      return;
    }
    if (iframeRef.current) {
      try {
        iframeRef.current.contentWindow?.location.reload();
      } catch {
        // Cross-origin reload via src reset
        const current = iframeRef.current.src;
        iframeRef.current.src = current;
      }
    }
  }

  function newThread() {
    setMessages([
      {
        id: newId("system"),
        role: "system",
        timestamp: nowLabel(),
        text: "New Pi agent thread. The Project directory field is applied to each Pi turn; models are still sourced from /v1/models.",
      },
    ]);
    setInput("");
    setIsMultiline(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "";
    }
    setError("");
    setActivePiSessionId(null);
    persistActivePiSessionId(null);
  }

  const activeProject = useMemo(
    () => projects.find((entry) => entry.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  return (
    <div className="flex h-[calc(100dvh-2.5rem)] min-h-0 w-full flex-col bg-(--bg) text-(--fg) md:h-[100dvh]">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-(--border) px-4">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="font-semibold tracking-tight">Agent</span>
          {activeProject ? (
            <span className="hidden items-center gap-1 truncate text-xs text-(--dim) sm:inline-flex">
              <span className="opacity-60">/</span>
              <span className="truncate">{activeProject.name}</span>
              {activeProject.hasGit && activeProject.branch ? (
                <span className="ml-1 inline-flex items-center gap-1 rounded border border-(--border) px-1 py-0.5 font-mono text-[10px]">
                  <GitBranch className="h-3 w-3" />
                  {activeProject.branch}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>

        <div className="flex-1" />

        <ProjectPicker
          projects={projects}
          activeId={selectedProjectId}
          onSelect={selectProject}
          onOpen={() => void handleOpenProject()}
          onRemove={(id) => void removeProjectById(id)}
          pickerOpen={projectPickerOpen}
          onPickerOpenChange={setProjectPickerOpen}
          pickerInput={projectPickerInput}
          onPickerInputChange={setProjectPickerInput}
          pickerError={projectPickerError}
          onPickerSubmit={submitProjectPicker}
          onPickerCancel={() => {
            setProjectPickerOpen(false);
            setProjectPickerInput("");
            setProjectPickerError("");
          }}
          cwd={agentCwd}
          onCwdChange={handleCwdInputChange}
          running={running}
        />

        <button
          type="button"
          onClick={newThread}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-(--border) bg-(--surface) px-2 text-xs text-(--fg) hover:bg-(--bg)"
          title="Start a fresh thread"
        >
          <Plus className="h-3.5 w-3.5" /> New thread
        </button>

        <button
          type="button"
          onClick={() => setRightPanelOpen((value) => !value)}
          aria-pressed={rightPanelOpen}
          className={`hidden h-7 items-center gap-1.5 rounded border px-2 text-xs xl:inline-flex ${
            rightPanelOpen
              ? "border-(--border) bg-(--surface) text-(--fg)"
              : "border-transparent text-(--dim) hover:text-(--fg) hover:bg-(--surface)"
          }`}
          title="Toggle browser"
        >
          Browser
        </button>
      </header>

      {error ? (
        <div className="border-b border-(--border) bg-(--err)/10 px-4 py-2 text-xs text-(--err)">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <SessionsSidebar
          cwd={activeProject?.path ?? null}
          activeSessionId={activePiSessionId}
          onSelect={(id) => {
            const cwd = activeProject?.path;
            if (!cwd) return;
            void loadAndReplaySession(cwd, id);
          }}
          onNew={newThread}
          collapsed={sessionsCollapsed}
          onToggleCollapsed={() => {
            const next = !sessionsCollapsed;
            setSessionsCollapsed(next);
            persistSessionsCollapsed(next);
          }}
        />
        <section className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
            <div className="mx-auto w-full max-w-2xl">
              {(() => {
                const visible = messages.filter((message) => message.role !== "system");
                if (visible.length === 0 && !running) {
                  return <ChatEmptyState />;
                }
                return (
                  <div className="space-y-6">
                    {visible.map((message) => (
                      <TimelineMessage key={message.id} message={message} />
                    ))}
                    {running ? <WorkingRow status={status} /> : null}
                  </div>
                );
              })()}
            </div>
          </div>

          {!selectedProjectId && projects.length === 0 ? (
            <div className="shrink-0 border-t border-(--border) bg-(--surface) px-6 py-2 text-[11px] text-(--dim)">
              No project selected — agent runs in your home directory. Pick a project from the
              header to scope it.
            </div>
          ) : null}

          <form
            onSubmit={sendMessage}
            className="shrink-0 border-t border-(--border) bg-(--bg) px-6 py-3"
          >
            <div
              className={`mx-auto max-w-2xl rounded-lg border bg-(--surface) ${
                isMultiline ? "border-(--accent)/60 ring-1 ring-(--accent)/30" : "border-(--border)"
              }`}
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => {
                  const value = event.target.value;
                  setInput(value);
                  const element = event.currentTarget;
                  if (!value) {
                    element.style.height = "";
                    setIsMultiline(false);
                    return;
                  }
                  element.style.height = "auto";
                  element.style.height = `${element.scrollHeight}px`;
                  setIsMultiline(element.scrollHeight > 44);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={
                  activeModel
                    ? `Ask ${activeModel.name}…`
                    : loadingModels
                      ? "Loading models…"
                      : "No models available — check /v1/models"
                }
                className="min-h-[40px] max-h-[240px] w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-sm leading-6 text-(--fg) outline-none placeholder:text-(--dim)"
              />
              <div className="flex items-center gap-2 border-t border-(--border) px-2 py-1.5">
                <select
                  className="h-7 max-w-[280px] rounded border border-(--border) bg-(--bg) px-2 text-xs text-(--fg) outline-none"
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                  disabled={loadingModels || running}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
                <div className="flex-1" />
                {running ? (
                  <button
                    type="button"
                    onClick={() => void abortTurn()}
                    className="inline-flex h-7 items-center gap-1.5 rounded border border-(--border) bg-(--bg) px-2 text-xs text-(--dim) hover:text-(--fg)"
                  >
                    <Square className="h-3 w-3" /> Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() || !selectedModel}
                    className="inline-flex h-7 items-center gap-1.5 rounded bg-(--fg) px-2.5 text-xs font-medium text-(--bg) disabled:opacity-30"
                  >
                    <Send className="h-3 w-3" /> Send
                  </button>
                )}
              </div>
            </div>
          </form>
        </section>

        {rightPanelOpen ? (
          <aside className="hidden w-[440px] shrink-0 flex-col border-l border-(--border) bg-(--bg) xl:flex">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--border) px-3 text-xs text-(--dim)">
              <span className="font-medium uppercase tracking-wide">Browser</span>
              <button
                type="button"
                onClick={() => setRightPanelOpen(false)}
                className="rounded p-1 hover:bg-(--surface) hover:text-(--fg)"
                title="Close"
                aria-label="Close browser"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <form
              onSubmit={submitBrowserUrl}
              className="flex shrink-0 items-center gap-1 border-b border-(--border) px-2 py-1.5"
            >
              <button
                type="button"
                onClick={browserBack}
                className="rounded p-1 text-(--dim) hover:bg-(--surface) hover:text-(--fg)"
                title="Back"
                aria-label="Back"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={browserForward}
                className="rounded p-1 text-(--dim) hover:bg-(--surface) hover:text-(--fg)"
                title="Forward"
                aria-label="Forward"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={browserReload}
                className="rounded p-1 text-(--dim) hover:bg-(--surface) hover:text-(--fg)"
                title="Reload"
                aria-label="Reload"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <input
                value={browserInput}
                onChange={(event) => setBrowserInput(event.target.value)}
                spellCheck={false}
                placeholder="Search or enter URL"
                className="min-w-0 flex-1 rounded border border-(--border) bg-(--surface) px-2 py-1 font-mono text-[11px] text-(--fg) outline-none placeholder:text-(--dim)"
                aria-label="Browser address"
              />
            </form>
            <div className="min-h-0 flex-1 bg-white">
              {isElectron ? (
                <webview
                  ref={(node) => {
                    webviewRef.current = (node as unknown as WebviewElement) ?? null;
                  }}
                  src={browserUrl}
                  allowpopups={true}
                  className="size-full"
                  style={{ width: "100%", height: "100%", display: "flex" }}
                />
              ) : (
                <iframe
                  ref={iframeRef}
                  src={browserUrl}
                  className="size-full"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  title="Agent browser"
                />
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function TimelineMessage({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  if (isUser) {
    return (
      <article className="flex flex-col gap-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-(--dim)">You</div>
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-(--fg)">
          {message.text}
        </div>
      </article>
    );
  }
  const blocks = message.blocks ?? [];
  return (
    <article className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-(--dim)">Pi</div>
      {blocks.length === 0 ? (
        <div className="text-sm leading-6 text-(--dim)">…</div>
      ) : (
        <div className="flex flex-col gap-2">
          {blocks.map((block) => {
            if (block.kind === "thinking") {
              return (
                <details key={block.id} className="text-xs">
                  <summary className="cursor-pointer list-none text-[11px] italic text-(--dim) hover:text-(--fg)">
                    Show thinking
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap border-l-2 border-(--border) pl-3 font-mono text-[11px] leading-5 text-(--dim)">
                    {block.text}
                  </pre>
                </details>
              );
            }
            if (block.kind === "text") {
              return <AssistantMarkdown key={block.id} text={block.text} />;
            }
            return (
              <details
                key={block.id}
                className="rounded border border-(--border)"
                open={block.status === "running"}
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 text-[11px] text-(--dim) hover:text-(--fg)">
                  <span className="font-mono font-medium">{block.name}</span>
                  <span className="opacity-70">· {block.status}</span>
                </summary>
                {block.text ? (
                  <pre className="overflow-x-auto whitespace-pre-wrap border-t border-(--border) p-2 font-mono text-[11px] leading-5 text-(--fg)">
                    {block.text}
                  </pre>
                ) : null}
              </details>
            );
          })}
        </div>
      )}
    </article>
  );
}

function ChatEmptyState() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-center">
      <p className="text-sm text-(--dim)">Ask the agent to edit, inspect, or run something.</p>
    </div>
  );
}

function ProjectPicker({
  projects,
  activeId,
  onSelect,
  onOpen,
  onRemove,
  pickerOpen,
  onPickerOpenChange,
  pickerInput,
  onPickerInputChange,
  pickerError,
  onPickerSubmit,
  onPickerCancel,
  cwd,
  onCwdChange,
  running,
}: {
  projects: ProjectEntry[];
  activeId: string | null;
  onSelect: (project: ProjectEntry) => void;
  onOpen: () => void;
  onRemove: (id: string) => void;
  pickerOpen: boolean;
  onPickerOpenChange: (value: boolean) => void;
  pickerInput: string;
  onPickerInputChange: (value: string) => void;
  pickerError: string;
  onPickerSubmit: (event: FormEvent) => void;
  onPickerCancel: () => void;
  cwd: string;
  onCwdChange: (value: string) => void;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = projects.find((entry) => entry.id === activeId) || null;

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded border border-(--border) bg-(--surface) px-2 text-xs text-(--fg) hover:bg-(--bg)"
        title={active?.path || "No project selected"}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-(--dim)" />
        <span className="truncate">{active?.name || "Choose project"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-(--dim)" />
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-50 w-80 overflow-hidden rounded-md border border-(--border) bg-(--surface) shadow-lg">
          <div className="max-h-72 overflow-y-auto p-1">
            {projects.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-(--dim)">
                No projects yet. Open a directory to get started.
              </div>
            ) : (
              projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  active={project.id === activeId}
                  onSelect={() => {
                    onSelect(project);
                    setOpen(false);
                  }}
                  onRemove={() => onRemove(project.id)}
                />
              ))
            )}
          </div>
          <div className="border-t border-(--border) p-2">
            {pickerOpen ? (
              <form onSubmit={onPickerSubmit} className="space-y-1.5">
                <input
                  value={pickerInput}
                  onChange={(event) => onPickerInputChange(event.target.value)}
                  placeholder="/Users/you/code/my-project"
                  spellCheck={false}
                  autoFocus
                  className="w-full rounded border border-(--border) bg-(--bg) px-2 py-1 font-mono text-[11px] text-(--fg) outline-none"
                />
                {pickerError ? <div className="text-[11px] text-(--err)">{pickerError}</div> : null}
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={onPickerCancel}
                    className="h-6 rounded px-2 text-[11px] text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="h-6 rounded bg-(--fg) px-2 text-[11px] font-medium text-(--bg)"
                  >
                    Add
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onOpen();
                  // Keep dropdown open so the inline form (web fallback) remains visible.
                  if (!isLikelyElectron()) onPickerOpenChange(true);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-(--border) px-2 py-1.5 text-xs text-(--dim) hover:bg-(--bg) hover:text-(--fg)"
              >
                <Plus className="h-3.5 w-3.5" /> Open project…
              </button>
            )}
          </div>
          <div className="border-t border-(--border) p-2">
            <label className="block text-[10px] uppercase tracking-wide text-(--dim)">cwd</label>
            <input
              value={cwd}
              onChange={(event) => onCwdChange(event.target.value)}
              disabled={running}
              spellCheck={false}
              className="mt-1 w-full rounded border border-(--border) bg-(--bg) px-2 py-1 font-mono text-[11px] text-(--fg) outline-none disabled:opacity-60"
              aria-label="Agent working directory"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isLikelyElectron(): boolean {
  if (typeof window === "undefined") return false;
  return /electron/i.test(navigator.userAgent);
}

function ProjectRow({
  project,
  active,
  onSelect,
  onRemove,
}: {
  project: ProjectEntry;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={`group flex items-start gap-2 rounded px-2 py-1.5 text-left ${
        active ? "bg-(--bg)" : "hover:bg-(--bg)"
      } ${project.exists ? "" : "opacity-60"}`}
    >
      <button
        type="button"
        onClick={onSelect}
        title={project.path}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <Folder className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--dim)" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-(--fg)">{project.name}</span>
            {project.hasGit && project.branch ? (
              <span className="inline-flex items-center gap-1 rounded border border-(--border) px-1 font-mono text-[10px] text-(--dim)">
                <GitBranch className="h-2.5 w-2.5" />
                <span className="max-w-[80px] truncate">{project.branch}</span>
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[10px] text-(--dim)">{project.path}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemove();
        }}
        className="mt-0.5 rounded p-0.5 text-(--dim) opacity-0 hover:bg-(--surface) hover:text-(--err) group-hover:opacity-100"
        title="Remove from list"
        aria-label="Remove project"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function WorkingRow({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-(--dim)">
      <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-(--dim)" />
      <span>Pi is {status}…</span>
    </div>
  );
}
