export type ToolBlock = {
  kind: "tool";
  id: string;
  name: string;
  status: "running" | "done" | "error";
  // Streaming raw text of the tool-call arguments (assembled from toolcall_delta
  // events, then replaced by the canonical JSON at toolcall_end). For file-write
  // tools, this lets us live-render the file content as the model generates it.
  argsText?: string;
  // Parsed arguments JSON, set at toolcall_end if `argsText` is valid JSON.
  args?: Record<string, unknown>;
  // Tool execution output (separate from args so we can render both).
  resultText?: string;
  // Back-compat single-text field used by legacy renderers / replays.
  text: string;
};
export type TextBlock = { kind: "text"; id: string; text: string };
export type ThinkingBlock = { kind: "thinking"; id: string; text: string };
export type AssistantBlock = TextBlock | ThinkingBlock | ToolBlock;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  blocks?: AssistantBlock[];
  timestamp?: string;
};

export type TokenStats = {
  read: number;
  write: number;
  current: number;
};

export type QueuedMessage = {
  id: string;
  // "steer" interrupts the current turn between tool runs and the next LLM
  // call; "follow_up" waits until the agent completely finishes.
  mode: "steer" | "follow_up";
  text: string;
};

export function drainQueueAfterAgentEnd(queue: QueuedMessage[]): {
  next: QueuedMessage | null;
  remaining: QueuedMessage[];
} {
  const followUps = queue.filter((item) => item.mode === "follow_up");
  const [next, ...remaining] = followUps;
  return { next: next ?? null, remaining };
}

export type SessionTab = {
  // Stable id local to this pane, used as a React key for tabs.
  id: string;
  // In-memory PiRpcSession key. One per tab so tabs can run independent pi
  // processes instead of sharing a pane-level runtime.
  runtimeSessionId: string;
  // Pi session UUID (null = unstarted, will be assigned by pi when the first
  // turn runs).
  piSessionId: string | null;
  projectId?: string;
  cwd?: string;
  modelId?: string;
  // Display title — derived from the first user message of the session, or a
  // placeholder while empty.
  title: string;
  messages: ChatMessage[];
  status: string;
  error: string;
  input: string;
  tokenStats?: TokenStats;
  // Outgoing pending messages (steer + follow_up). Drawn as chips above the
  // input. Steers fire immediately; follow-ups wait for `agent_end`.
  queue?: QueuedMessage[];
};

function randomIdSegment(length: number): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID().replace(/-/g, "").slice(0, length);
  }
  const bytes = new Uint8Array(Math.ceil(length / 2));
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${randomIdSegment(8)}`;
}

export function nowLabel() {
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

function numberFromRecord(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

export function piSessionIdFromEvent(event: Record<string, unknown>): string | null {
  if (event.type !== "session") return null;
  for (const key of ["id", "sessionId", "session_id"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function usageFromEvent(event: Record<string, unknown>): TokenStats | null {
  if (event.type !== "message" && event.type !== "message_end") return null;
  const message = asRecord(event.message);
  if (!message || message.role !== "assistant") return null;
  const usage =
    message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
      ? (message.usage as Record<string, unknown>)
      : null;
  if (!usage) return null;
  const read = numberFromRecord(usage, ["input", "prompt_tokens", "input_tokens"]);
  const write = numberFromRecord(usage, ["output", "completion_tokens", "output_tokens"]);
  const total = numberFromRecord(usage, ["totalTokens", "total_tokens", "total"]);
  const current = total || read + write;
  if (read <= 0 && write <= 0 && current <= 0) return null;
  return { read, write, current };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.max(0, Math.round(tokens)));
}

type StreamingToolCallSnapshot = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
};

function contentPartAt(
  messageLike: unknown,
  contentIndex: unknown,
): Record<string, unknown> | null {
  const message = asRecord(messageLike);
  const content = Array.isArray(message?.content) ? message.content : null;
  if (!content) return null;
  if (typeof contentIndex === "number") return asRecord(content[contentIndex]);
  for (let idx = content.length - 1; idx >= 0; idx -= 1) {
    const part = asRecord(content[idx]);
    if (part?.type === "toolCall") return part;
  }
  return null;
}

function toolCallSnapshotFromUpdate(
  assistantMessageEvent: Record<string, unknown> | undefined,
  message?: unknown,
): StreamingToolCallSnapshot | null {
  if (!assistantMessageEvent) return null;
  const explicit = asRecord(assistantMessageEvent.toolCall);
  const part =
    explicit ??
    contentPartAt(assistantMessageEvent.partial, assistantMessageEvent.contentIndex) ??
    contentPartAt(message, assistantMessageEvent.contentIndex);
  const idValue = part?.id ?? assistantMessageEvent.toolCallId;
  const id = typeof idValue === "string" && idValue.trim() ? idValue.trim() : "";
  if (!id) return null;
  const nameValue = part?.name ?? assistantMessageEvent.toolName;
  const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : "tool";
  const args = asRecord(part?.arguments) ?? undefined;
  return { id, name, args };
}

function toolCallDeltaFromUpdate(
  assistantMessageEvent: Record<string, unknown> | undefined,
): string {
  const value = assistantMessageEvent?.delta ?? assistantMessageEvent?.argumentsDelta;
  return typeof value === "string" ? value : "";
}

function stringifyToolArgs(args: Record<string, unknown> | undefined): string | undefined {
  return args && Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined;
}

export function sessionTitleFromPrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 48) || "New session";
}

function messageText(
  content: string | Array<Record<string, unknown>> | undefined,
  separator = "\n",
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join(separator);
}

function blocksFromMessageContent(content: string | Array<Record<string, unknown>> | undefined) {
  if (typeof content === "string") {
    return content ? [{ kind: "text" as const, id: newId("text"), text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AssistantBlock[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      blocks.push({ kind: "text", id: newId("text"), text: part.text });
    } else if (part?.type === "thinking" && typeof part.thinking === "string") {
      blocks.push({ kind: "thinking", id: newId("thinking"), text: part.thinking });
    } else if (part?.type === "toolCall") {
      const argsText = JSON.stringify(part.arguments ?? {}, null, 2);
      const args =
        part.arguments && typeof part.arguments === "object"
          ? (part.arguments as Record<string, unknown>)
          : undefined;
      blocks.push({
        kind: "tool",
        id: typeof part.id === "string" ? part.id : newId("tool"),
        name: typeof part.name === "string" ? part.name : "tool",
        status: "running",
        argsText,
        args,
        text: argsText,
      });
    }
  }
  return blocks;
}

function blocksFromPiEvent(
  blocks: AssistantBlock[],
  event: Record<string, unknown>,
): AssistantBlock[] | null {
  const eventType = event.type;
  if (eventType === "message_update") {
    const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const updateType = ame?.type;
    if (updateType === "text_delta" && typeof ame?.delta === "string") {
      return appendDelta(blocks, "text", ame.delta);
    }
    if (updateType === "thinking_delta" && typeof ame?.delta === "string") {
      return appendDelta(blocks, "thinking", ame.delta);
    }
    if (updateType === "toolcall_start") {
      const snapshot = toolCallSnapshotFromUpdate(ame, event.message);
      if (!snapshot) return null;
      return upsertTool(
        blocks,
        snapshot.id,
        (existing) => ({
          ...existing,
          name: snapshot.name,
          args: snapshot.args ?? existing.args,
        }),
        () => ({
          kind: "tool",
          id: snapshot.id,
          name: snapshot.name,
          status: "running",
          text: "",
          argsText: stringifyToolArgs(snapshot.args) ?? "",
          args: snapshot.args,
        }),
      );
    }
    if (updateType === "toolcall_delta") {
      const snapshot = toolCallSnapshotFromUpdate(ame, event.message);
      const delta = toolCallDeltaFromUpdate(ame);
      if (!snapshot || (!delta && !snapshot.args)) return null;
      return upsertTool(
        blocks,
        snapshot.id,
        (existing) => ({
          ...existing,
          name: snapshot.name || existing.name,
          args: snapshot.args ?? existing.args,
          argsText: delta
            ? (existing.argsText ?? "") + delta
            : existing.argsText || stringifyToolArgs(snapshot.args),
        }),
        () => ({
          kind: "tool",
          id: snapshot.id,
          name: snapshot.name,
          status: "running",
          text: "",
          argsText: delta || stringifyToolArgs(snapshot.args) || "",
          args: snapshot.args,
        }),
      );
    }
    if (updateType === "toolcall_end") {
      const toolCall = ame?.toolCall as
        | { id?: string; name?: string; arguments?: unknown }
        | undefined;
      if (!toolCall) return null;
      const id = toolCall.id || newId("tool");
      const name = toolCall.name || "tool";
      const argsText = JSON.stringify(toolCall.arguments ?? {}, null, 2);
      const argsObj =
        toolCall.arguments && typeof toolCall.arguments === "object"
          ? (toolCall.arguments as Record<string, unknown>)
          : undefined;
      return upsertTool(
        blocks,
        id,
        (existing) => ({
          ...existing,
          name,
          argsText,
          args: argsObj ?? existing.args,
          text: existing.text || argsText,
        }),
        () => ({
          kind: "tool",
          id,
          name,
          status: "running",
          argsText,
          args: argsObj,
          text: argsText,
        }),
      );
    }
  }

  if (eventType === "tool_execution_start") {
    const id = String(event.toolCallId || newId("tool"));
    const name = String(event.toolName || "tool");
    return upsertTool(
      blocks,
      id,
      (existing) => existing,
      () => ({ kind: "tool", id, name, status: "running", text: "" }),
    );
  }

  if (eventType === "tool_execution_update" || eventType === "tool_execution_end") {
    const id = String(event.toolCallId || "");
    if (!id) return null;
    const resultText = extractToolText(event.partialResult || event.result);
    return upsertTool(
      blocks,
      id,
      (existing) => ({
        ...existing,
        status:
          eventType === "tool_execution_end"
            ? ((event.isError ? "error" : "done") as ToolBlock["status"])
            : existing.status,
        resultText: resultText || existing.resultText,
        text: existing.argsText || existing.text || resultText,
      }),
      () => ({
        kind: "tool",
        id,
        name: "tool",
        status:
          eventType === "tool_execution_end"
            ? ((event.isError ? "error" : "done") as ToolBlock["status"])
            : "running",
        resultText,
        text: resultText,
      }),
    );
  }

  return null;
}

export function applyPiEventToAssistantMessage(
  message: ChatMessage,
  event: Record<string, unknown>,
): ChatMessage {
  const blocks = blocksFromPiEvent(message.blocks ?? [], event);
  return blocks ? { ...message, blocks } : message;
}

export function replaySessionEvents(events: Record<string, unknown>[]) {
  const replayed: ChatMessage[] = [];
  let pendingAssistantId: string | null = null;
  let title: string | null = null;

  const ensureAssistant = () => {
    if (pendingAssistantId) return pendingAssistantId;
    const id = newId("assistant");
    replayed.push({ id, role: "assistant", text: "", blocks: [], timestamp: nowLabel() });
    pendingAssistantId = id;
    return id;
  };
  const localPatch = (assistantId: string, patch: (msg: ChatMessage) => ChatMessage) => {
    const idx = replayed.findIndex((m) => m.id === assistantId);
    if (idx !== -1) replayed[idx] = patch(replayed[idx]);
  };
  const assistantWithTool = (toolCallId: string) => {
    for (let idx = replayed.length - 1; idx >= 0; idx -= 1) {
      const message = replayed[idx];
      if (
        message.role === "assistant" &&
        (message.blocks ?? []).some((block) => block.kind === "tool" && block.id === toolCallId)
      ) {
        return message.id;
      }
    }
    return null;
  };

  for (const event of events) {
    const type = event.type;
    if (type === "message" || type === "message_end") {
      const msg = event.message as
        | {
            role?: string;
            content?: string | Array<Record<string, unknown>>;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
          }
        | undefined;
      if (msg?.role === "user") {
        pendingAssistantId = null;
        const text = messageText(msg.content);
        if (text) {
          if (!title) title = sessionTitleFromPrompt(text);
          replayed.push({ id: newId("user"), role: "user", text, timestamp: nowLabel() });
        }
        continue;
      }
      if (msg?.role === "assistant") {
        pendingAssistantId = null;
        const blocks = blocksFromMessageContent(msg.content);
        replayed.push({
          id: newId("assistant"),
          role: "assistant",
          text: blocks
            .filter((block): block is TextBlock => block.kind === "text")
            .map((block) => block.text)
            .join("\n"),
          blocks,
          timestamp: nowLabel(),
        });
        continue;
      }
      if (msg?.role === "toolResult") {
        const id = msg.toolCallId || String(event.toolCallId || "");
        if (id) {
          const resultText = messageText(msg.content);
          const assistantId = assistantWithTool(id) ?? ensureAssistant();
          localPatch(assistantId, (message) => ({
            ...message,
            blocks: upsertTool(
              message.blocks ?? [],
              id,
              (existing) => ({
                ...existing,
                status: msg.isError ? "error" : "done",
                text: resultText || existing.text,
              }),
              () => ({
                kind: "tool",
                id,
                name: msg.toolName || "tool",
                status: msg.isError ? "error" : "done",
                text: resultText,
              }),
            ),
          }));
        }
        continue;
      }
    }

    const eventType = event.type;
    if (
      eventType !== "message_update" &&
      eventType !== "tool_execution_start" &&
      eventType !== "tool_execution_update" &&
      eventType !== "tool_execution_end"
    ) {
      continue;
    }

    const assistantId = ensureAssistant();
    localPatch(assistantId, (msg) => applyPiEventToAssistantMessage(msg, event));
  }

  return { messages: replayed, title };
}

function appendDelta(
  blocks: AssistantBlock[],
  kind: "text" | "thinking",
  delta: string,
): AssistantBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + delta }];
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

export function makeFreshTab(): SessionTab {
  return {
    id: newId("tab"),
    runtimeSessionId: newId("rt"),
    piSessionId: null,
    title: "New session",
    messages: [],
    status: "idle",
    error: "",
    input: "",
  };
}
