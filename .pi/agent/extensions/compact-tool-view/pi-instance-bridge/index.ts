import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseBool } from "../lib/shared/pi-bool.ts";
import { parsePositiveInt } from "../lib/shared/pi-number.ts";
import { asString } from "../lib/shared/pi-string.ts";
import {
  extractAssistantText,
  extractCommandFromInput,
  extractResultTail,
  extractReturnCode,
  extractTextSnippet,
  summarizeToolInput,
} from "./lib/pi-instance-bridge-text.ts";
import {
  controlResultText,
  currentSessionSnapshot,
  defaultTokenFilePath,
  getRouterUrl,
  handleControlOperation,
  loadProjectConfig,
  markerText,
  parseControlPayload,
  parseMarkedText,
  pathBasename,
  readTokenFromFile,
  wsDataToString,
} from "./lib/pi-instance-bridge-helpers.ts";

type PromptFrame = {
  v: number;
  type: "prompt";
  id: string;
  text: string;
  receivedAt?: number;
};

type QueueItem = {
  id: string;
  text: string;
  stage: "queued_to_pi" | "active_turn";
  enqueuedAt: number;
  activeAt?: number;
};

export default function piInstanceBridge(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const projectCfg = loadProjectConfig(cwd);
  const enabledByEnv = parseBool(process.env.PI_ROUTER_INSTANCE_ENABLE, false);
  const enabledByConfig = Boolean(projectCfg);
  const enabled = enabledByEnv || enabledByConfig;

  const uiInstanceEnable = parseBool(process.env.PI_ROUTER_UI_INSTANCE_ENABLE, false);

  const wsUrl = getRouterUrl();

  const tokenEnv = asString(process.env.PI_ROUTER_TOKEN).trim();
  const tokenFile = asString(process.env.PI_ROUTER_TOKEN_FILE).trim() || defaultTokenFilePath();
  const token = tokenEnv || readTokenFromFile(tokenFile);

  const instanceNameEnv = asString(process.env.PI_ROUTER_INSTANCE_NAME).trim() || asString(projectCfg?.name).trim();
  const instanceIdEnv = asString(process.env.PI_ROUTER_INSTANCE_ID).trim() || asString(projectCfg?.id).trim();
  const defaultInstanceName = instanceNameEnv || pathBasename(process.cwd()) || "instance";
  const tagsEnv = asString(process.env.PI_ROUTER_INSTANCE_TAGS).trim();
  const tags = tagsEnv
    ? tagsEnv
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20)
    : projectCfg?.tags && Array.isArray(projectCfg.tags)
      ? projectCfg.tags
      : [];

  const promptTimeoutMs = Math.max(
    10_000,
    // Default: 12h. Some tasks genuinely take a while.
    parsePositiveInt(process.env.PI_ROUTER_INSTANCE_PROMPT_TIMEOUT_MS, 43_200_000),
  );

  let ws: WebSocket | null = null;
  let isStreaming = false;
  let shuttingDown = false;
  let authRejected = false;

  let lastCtx: ExtensionContext | null = null;
  let assignedInstanceId = "";

  const queue: QueueItem[] = [];
  let current: QueueItem | null = null;
  let currentTimeout: ReturnType<typeof setTimeout> | null = null;

  const pendingReplyFrames: Array<Record<string, unknown>> = [];

  let toolCallSeq = 0;
  const toolSeqByCallId = new Map<string, { seq: number; toolName: string }>();

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectBackoffMs = 1000;

  function setStatus(text: string) {
    if (!lastCtx?.hasUI) return;
    lastCtx.ui.setStatus("pi-router-instance", text);
  }

  function statusLine(state: string) {
    const id = assignedInstanceId ? ` (${assignedInstanceId})` : "";
    return `router instance: ${defaultInstanceName}${id} — ${state}`;
  }

  function sendInstanceState(ctx: ExtensionContext | null) {
    if (!ctx) return;

    const snapshot = currentSessionSnapshot(pi, ctx);
    sendOrQueue({
      v: 1,
      type: "instance_state",
      state: snapshot,
      sentAt: Date.now(),
    });
  }

  function socketOpen(): boolean {
    return Boolean(ws && ws.readyState === 1);
  }

  function sendFrame(frame: Record<string, unknown>): boolean {
    if (!socketOpen() || !ws) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  function sendOrQueue(frame: Record<string, unknown>) {
    if (sendFrame(frame)) return;
    pendingReplyFrames.push(frame);
  }

  function flushPending() {
    if (!socketOpen()) return;
    while (pendingReplyFrames.length > 0) {
      const next = pendingReplyFrames[0];
      if (!sendFrame(next)) return;
      pendingReplyFrames.shift();
    }
  }

  function clearCurrentTimeout() {
    if (!currentTimeout) return;
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }

  function clearCurrentAndContinue() {
    clearCurrentTimeout();
    current = null;
    toolCallSeq = 0;
    toolSeqByCallId.clear();
    pumpQueue();
  }

  function failCurrent(errorText: string) {
    if (!current) return;
    sendOrQueue({ v: 1, type: "reply_error", id: current.id, error: errorText, sentAt: Date.now() });
    clearCurrentAndContinue();
  }

  function pumpQueue() {
    if (shuttingDown) return;
    if (!socketOpen()) return;
    if (current) return;

    const next = queue.shift();
    if (!next) return;

    current = next;
    toolCallSeq = 0;
    toolSeqByCallId.clear();

    const marked = markerText(next.id, next.text);
    try {
      if (isStreaming) {
        pi.sendUserMessage(marked, { deliverAs: "followUp" });
      } else {
        pi.sendUserMessage(marked);
      }
    } catch (error) {
      try {
        pi.sendUserMessage(marked, { deliverAs: "followUp" });
      } catch (secondError) {
        const text = asString((secondError as Error)?.message || error);
        failCurrent(`failed to enqueue prompt in pi: ${text}`);
        return;
      }
    }

    clearCurrentTimeout();
    currentTimeout = setTimeout(() => {
      if (!current) return;
      failCurrent(`timeout waiting for assistant reply (${promptTimeoutMs}ms)`);
    }, promptTimeoutMs);

    flushPending();
  }

  function scheduleReconnect() {
    if (shuttingDown || authRejected) return;
    if (reconnectTimer) return;

    const delay = reconnectBackoffMs;
    reconnectBackoffMs = Math.min(30_000, reconnectBackoffMs * 2);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendHello(ctx: ExtensionContext) {
    const cwd = ctx.cwd || process.cwd();
    const name = instanceNameEnv || pathBasename(cwd) || defaultInstanceName || "worker";

    sendFrame({
      v: 1,
      type: "hello",
      token,
      role: "instance",
      client: {
        kind: "pi-extension",
        name: "pi-instance-bridge",
        version: "0.1.0",
        pid: process.pid,
      },
      instance: {
        id: instanceIdEnv || undefined,
        name,
        cwd,
        pid: process.pid,
        tags,
      },
    });
  }

  function connect() {
    if (shuttingDown || authRejected) return;
    if (!wsUrl || !token) return;

    const wsCtor = (globalThis as Record<string, unknown>).WebSocket as
      | (new (url: string) => WebSocket)
      | undefined;

    if (!wsCtor) {
      setStatus(statusLine("disabled; WebSocket client not available in this runtime"));
      return;
    }

    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
      return;
    }

    try {
      ws = new wsCtor(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }

    const socket = ws;

    socket.addEventListener("open", () => {
      reconnectBackoffMs = 1000;
      setStatus(statusLine("connected; authenticating"));
      if (lastCtx) sendHello(lastCtx);
      flushPending();
    });

    socket.addEventListener("message", async (event) => {
      const raw = await wsDataToString(event.data);
      if (!raw) return;

      let frame: Record<string, unknown> | null = null;
      try {
        frame = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = asString(frame.type);

      if (type === "hello_error") {
        authRejected = true;
        setStatus(statusLine("auth rejected"));
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }

      if (type === "hello_ok") {
        const id = asString((frame as Record<string, unknown>)?.you && (frame as Record<string, any>).you?.id).trim();
        if (id) assignedInstanceId = id;
        setStatus(statusLine("connected"));
        sendInstanceState(lastCtx);
        return;
      }

      if (type === "ping") {
        sendFrame({ v: 1, type: "pong", t: frame.t || Date.now() });
        return;
      }

      if (type === "prompt") {
        const prompt = frame as unknown as PromptFrame;
        const id = asString(prompt.id).trim();
        const text = asString(prompt.text);
        if (!id || !text.trim()) {
          sendOrQueue({ v: 1, type: "reply_error", id: id || "unknown", error: "invalid prompt", sentAt: Date.now() });
          return;
        }

        queue.push({ id, text, stage: "queued_to_pi", enqueuedAt: Date.now() });
        sendOrQueue({ v: 1, type: "prompt_ack", id, sentAt: Date.now() });
        pumpQueue();
        return;
      }
    });

    socket.addEventListener("close", () => {
      if (shuttingDown || authRejected) return;
      setStatus(statusLine("disconnected; reconnecting"));
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (shuttingDown || authRejected) return;
      scheduleReconnect();
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;

    if (!enabled) {
      return;
    }

    assignedInstanceId = "";

    // UI guard: do not auto-connect interactive TUIs as worker/instance just because a config file exists.
    // Headless runs (rpc) may still auto-connect based on config.
    if (ctx.hasUI && enabledByConfig && !enabledByEnv && !uiInstanceEnable) {
      setStatus(statusLine("disabled in UI (set PI_ROUTER_UI_INSTANCE_ENABLE=1 to connect)"));
      return;
    }

    if (!wsUrl || !token) {
      const hint = token
        ? ""
        : "missing router token (set PI_ROUTER_TOKEN or PI_ROUTER_TOKEN_FILE)";
      setStatus(statusLine(`disabled; ${hint}`));
      return;
    }

    setStatus(statusLine("connecting"));
    sendInstanceState(ctx);
    connect();
  });

  pi.on("input", async (event, ctx) => {
    lastCtx = ctx;

    if (event.source !== "extension") {
      return { action: "continue" };
    }

    const parsed = parseMarkedText(asString(event.text));
    if (!parsed) {
      return { action: "continue" };
    }

    const control = parseControlPayload(parsed.cleanText);
    if (control) {
      if (!current || current.id !== parsed.id) {
        return { action: "handled" };
      }

      try {
        const data = await handleControlOperation(pi, control, ctx);
        sendOrQueue({
          v: 1,
          type: "reply",
          id: current.id,
          text: controlResultText({ ok: true, data }),
          meta: {
            durationMs: 0,
            assistantChars: 0,
          },
          sentAt: Date.now(),
        });
      } catch (error) {
        sendOrQueue({
          v: 1,
          type: "reply",
          id: current.id,
          text: controlResultText({ ok: false, error: asString((error as Error)?.message || error) }),
          meta: {
            durationMs: 0,
            assistantChars: 0,
          },
          sentAt: Date.now(),
        });
      }

      sendInstanceState(ctx);
      clearCurrentAndContinue();
      return { action: "handled" };
    }

    if (current && current.id === parsed.id) {
      current.stage = "active_turn";
      if (!current.activeAt) current.activeAt = Date.now();
    }

    return { action: "transform", text: parsed.cleanText };
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastCtx = ctx;
    isStreaming = true;
  });

  pi.on("tool_call", async (event) => {
    if (!current || current.stage !== "active_turn") return;

    toolCallSeq += 1;
    const toolCallId = asString((event as { toolCallId?: string }).toolCallId);
    const toolName = asString((event as { toolName?: string }).toolName) || "tool";

    if (toolCallId) {
      toolSeqByCallId.set(toolCallId, { seq: toolCallSeq, toolName });
    }

    const input = (event as { input?: unknown }).input;

    sendOrQueue({
      v: 1,
      type: "tool_call",
      id: current.id,
      seq: toolCallSeq,
      toolName,
      command: extractCommandFromInput(input),
      inputSummary: summarizeToolInput(input),
      sentAt: Date.now(),
    });
  });

  pi.on("tool_result", async (event) => {
    if (!current || current.stage !== "active_turn") return;

    const toolCallId = asString((event as { toolCallId?: string }).toolCallId);
    const mapped = toolCallId ? toolSeqByCallId.get(toolCallId) : undefined;
    const toolName = mapped?.toolName || asString((event as { toolName?: string }).toolName) || "tool";
    const seq = mapped?.seq;

    const content = (event as { content?: unknown; details?: unknown }).content;
    const details = (event as { content?: unknown; details?: unknown }).details;

    sendOrQueue({
      v: 1,
      type: "tool_result",
      id: current.id,
      seq,
      toolName,
      isError: Boolean((event as { isError?: boolean }).isError),
      returnCode: extractReturnCode(details),
      resultSummary: extractTextSnippet(content ?? details),
      resultTail: extractResultTail(content, details),
      sentAt: Date.now(),
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;
    isStreaming = false;

    if (!current || current.stage !== "active_turn") {
      pumpQueue();
      return;
    }

    const finishedAt = Date.now();
    const text = extractAssistantText((event as { messages?: unknown[] }).messages) || "[no assistant response returned]";

    sendOrQueue({
      v: 1,
      type: "reply",
      id: current.id,
      text,
      meta: {
        durationMs: Math.max(0, finishedAt - (current.activeAt || current.enqueuedAt)),
        assistantChars: text.length,
      },
      sentAt: finishedAt,
    });

    sendInstanceState(ctx);
    clearCurrentAndContinue();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    clearCurrentTimeout();
    queue.length = 0;
    current = null;
    pendingReplyFrames.length = 0;

    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  });
}
