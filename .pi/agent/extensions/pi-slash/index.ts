import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { asString } from "../lib/shared/pi-string.ts";

type PendingSessionOp =
  | { kind: "reload" }
  | { kind: "new" }
  | { kind: "resume"; sessionPath: string }
  | { kind: "compact"; customInstructions?: string };

let pendingSessionOp: PendingSessionOp | null = null;

const THINKING_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const CONFIRM_COMMAND_PREFIXES = ["/compact", "/new", "/resume"] as const;

type ModelRegistryLike = {
  find?: (provider: string, id: string) => unknown;
  refresh?: () => void;
};

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  const raw = asString(value).trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(raw) ? (raw as ThinkingLevel) : "";
}

function isSlashCommand(text: string): boolean {
  const cmd = text.trim();
  return cmd.startsWith("/") && cmd.length > 1;
}

function needsConfirmation(command: string): boolean {
  const cmd = command.trim();
  return CONFIRM_COMMAND_PREFIXES.some((prefix) => cmd.startsWith(prefix));
}

async function confirmIfNeeded(ctx: ExtensionContext, force: boolean, command: string): Promise<boolean> {
  if (force) return true;
  if (!ctx.hasUI) return false;

  return ctx.ui.confirm(
    "Run command?",
    `Run: ${command}\n\nConfirmation required for /compact, /new, /resume.`,
  );
}

function parseSlash(command: string): { name: string; args: string } | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).trim();
  const args = (space === -1 ? "" : trimmed.slice(space + 1)).trim();
  if (!name) return null;
  return { name, args };
}

async function runSlash(command: string, ctx: ExtensionContext): Promise<{ ok: boolean; text: string }> {
  const parsed = parseSlash(command);
  if (!parsed) return { ok: false, text: "Invalid slash command." };

  // Note: built-in slash commands are handled by the TUI input layer and are not
  // executed when extensions/tools "send" a message. So we execute the underlying
  // session control actions directly via ctx.*.
  switch (parsed.name) {
    case "reload": {
      const reload = (ctx as unknown as { reload?: () => Promise<void> }).reload;
      if (!reload) return { ok: false, text: "Reload not available in this context." };

      // If called from a tool invocation, we're typically mid-turn (not idle), and
      // the interactive reload handler will refuse to run. Schedule it for after
      // the current turn ends.
      if (!ctx.isIdle()) {
        pendingSessionOp = { kind: "reload" };
        return {
          ok: true,
          text: [
            "Scheduled: reload after the current response finishes.",
            "After it finishes: run /pi-slash-commands to confirm behavior is unchanged.",
          ].join("\n"),
        };
      }

      await reload();

      const commands = pi.getCommands();
      const hasSelf = commands.some((c) => c.name === "pi-slash-commands");

      return {
        ok: true,
        text: [
          "OK: reloaded extensions, skills, prompts, themes.",
          `commands_seen: ${commands.length}`,
          `has_pi_slash_commands: ${hasSelf}`,
        ].join("\n"),
      };
    }

    case "session": {
      const sm = ctx.sessionManager;
      const header = sm.getHeader?.();
      const info = [
        "Session Info",
        `- id: ${sm.getSessionId?.() ?? ""}`,
        `- name: ${sm.getSessionName?.() ?? ""}`,
        `- file: ${sm.getSessionFile?.() ?? ""}`,
        `- cwd: ${sm.getCwd?.() ?? ""}`,
        header ? `- created: ${header.timestamp}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { ok: true, text: info };
    }

    case "new": {
      const newSession = (ctx as unknown as {
        newSession?: (options?: {
          parentSession?: string;
          setup?: (sessionManager: unknown) => Promise<void>;
        }) => Promise<{ cancelled: boolean }>;
      }).newSession;
      if (!newSession) return { ok: false, text: "New session not available in this context." };

      if (!ctx.isIdle()) {
        pendingSessionOp = { kind: "new" };
        return { ok: true, text: "Scheduled: /new after the current response finishes." };
      }

      const result = await newSession();
      return result.cancelled
        ? { ok: false, text: "Cancelled." }
        : { ok: true, text: "OK: new session started." };
    }

    case "compact": {
      const customInstructions = parsed.args || undefined;

      // Important: running compaction from inside a tool call can abort the current
      // turn (including this tool), which appears as "No result provided".
      // So we schedule compaction for after the current turn when not idle.
      if (!ctx.isIdle()) {
        pendingSessionOp = { kind: "compact", customInstructions };
        return {
          ok: true,
          text: "Scheduled: /compact after the current response finishes.",
        };
      }

      const result = await new Promise<{ summary?: string; tokensBefore?: number }>((resolve, reject) => {
        ctx.compact({
          customInstructions,
          onComplete: (r) => resolve(r as { summary?: string; tokensBefore?: number }),
          onError: reject,
        });
      });

      const summary = (result.summary || "").trim();
      const tokensBefore = Number(result.tokensBefore || 0);
      const text = [
        "OK: compacted context.",
        tokensBefore ? `tokensBefore: ${tokensBefore}` : "",
        summary ? `summary:\n${summary}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return { ok: true, text };
    }

    case "resume": {
      const switchSession = (ctx as unknown as {
        switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
      }).switchSession;
      if (!switchSession) return { ok: false, text: "Resume not available in this context." };

      let sessionPath = parsed.args;
      if (!sessionPath) {
        if (!ctx.hasUI) {
          return { ok: false, text: "Usage: /resume <sessionPath>" };
        }

        const cwd = ctx.sessionManager.getCwd();
        const sessionDir = ctx.sessionManager.getSessionDir();
        const sessions = await SessionManager.list(cwd, sessionDir);
        sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

        const options = sessions.slice(0, 30).map((s) => {
          const name = (s.name || "").trim();
          const label = name ? name : s.firstMessage;
          return `${label}  (${s.path})`;
        });

        const picked = await ctx.ui.select("Resume session", options);
        if (!picked) return { ok: false, text: "Cancelled." };

        const m = /\(([^)]+)\)$/.exec(picked);
        sessionPath = (m?.[1] || "").trim();
        if (!sessionPath) return { ok: false, text: "Failed to parse selected session." };
      }

      if (!ctx.isIdle()) {
        pendingSessionOp = { kind: "resume", sessionPath };
        return { ok: true, text: `Scheduled: /resume after the current response finishes: ${sessionPath}` };
      }

      const result = await switchSession(sessionPath);
      return result.cancelled
        ? { ok: false, text: "Cancelled." }
        : { ok: true, text: `OK: resumed session: ${sessionPath}` };
    }

    case "model": {
      return { ok: false, text: "Use op=model.set (the built-in /model is interactive)." };
    }

    default:
      return { ok: false, text: `Unsupported slash command: /${parsed.name}` };
  }
}

function resolveModel(ctx: ExtensionContext, provider: string, modelId: string): unknown {
  const registry = ctx.modelRegistry as unknown as ModelRegistryLike;

  try {
    registry.refresh?.();
  } catch {
    // ignore refresh failures; find() may still work
  }

  return registry.find?.(provider, modelId);
}

export default function piSlash(pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    if (!pendingSessionOp) return;

    const op = pendingSessionOp;
    pendingSessionOp = null;

    try {
      if (op.kind === "reload") {
        const reload = (ctx as unknown as { reload?: () => Promise<void> }).reload;
        if (reload) await reload();
      } else if (op.kind === "new") {
        const newSession = (ctx as unknown as {
          newSession?: () => Promise<{ cancelled: boolean }>;
        }).newSession;
        if (newSession) await newSession();
      } else if (op.kind === "resume") {
        const switchSession = (ctx as unknown as {
          switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
        }).switchSession;
        if (switchSession) await switchSession(op.sessionPath);
      } else if (op.kind === "compact") {
        await new Promise<void>((resolve, reject) => {
          ctx.compact({
            customInstructions: op.customInstructions,
            onComplete: () => resolve(),
            onError: reject,
          });
        });
      }
    } catch {
      // Swallow: reload/new/resume are best-effort when scheduled from a tool call.
      // If this becomes a problem, we can surface via ctx.ui.notify.
    }
  });
  pi.registerCommand("pi-slash-commands", {
    description: "Show available slash-command control operations",
    handler: async (_args, ctx) => {
      const text = [
        "pi slash-command control:",
        "- Natural language: ask pi to change model / thinking level / run session commands.",
        "- Tool: pi_slash (model.set, thinking.set, slash.run).",
        "",
        "Notes:",
        "- /model is interactive; the assistant uses pi.setModel() instead.",
        "- Confirmation is required for /compact, /new, /resume.",
      ].join("\n");

      ctx.ui.notify(text, "info");
    },
  });

  pi.registerTool({
    name: "pi_slash",
    label: "Pi Slash Control",
    description:
      "Run pi session commands on the user’s behalf. Prefer structured ops like model.set over interactive commands (e.g., /model). For risky operations, require confirmation unless force=true.",
    parameters: Type.Object({
      op: Type.Union([Type.Literal("model.set"), Type.Literal("thinking.set"), Type.Literal("slash.run")]),
      provider: Type.Optional(Type.String({ description: "Provider id (for model.set), e.g. openai-codex" })),
      modelId: Type.Optional(Type.String({ description: "Model id (for model.set), e.g. gpt-5.3-codex" })),
      thinkingLevel: Type.Optional(
        Type.Union([
          Type.Literal(""),
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
        ]),
      ),
      level: Type.Optional(
        Type.Union([
          Type.Literal(""),
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
        ]),
      ),
      command: Type.Optional(Type.String({ description: "Slash command text (for slash.run), e.g. /session" })),
      force: Type.Optional(Type.Boolean({ description: "Skip confirmation prompts" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as Record<string, unknown>;
      const op = asString(p.op).trim();

      if (op === "model.set") {
        const provider = asString(p.provider).trim();
        const modelId = asString(p.modelId).trim();
        const thinkingLevel = normalizeThinkingLevel(p.thinkingLevel);

        if (!provider || !modelId) {
          return {
            content: [{ type: "text", text: "Missing provider/modelId." }],
            details: { ok: false },
          };
        }

        const model = resolveModel(ctx, provider, modelId);
        if (!model) {
          return {
            content: [{ type: "text", text: `Model not found in registry: ${provider}/${modelId}` }],
            details: { ok: false, provider, modelId },
          };
        }

        const switched = await pi.setModel(model as never);
        if (!switched) {
          return {
            content: [{ type: "text", text: `Failed to activate model (missing auth?): ${provider}/${modelId}` }],
            details: { ok: false, provider, modelId },
          };
        }

        if (thinkingLevel) {
          pi.setThinkingLevel(thinkingLevel);
        }

        return {
          content: [
            {
              type: "text",
              text: `OK: model set to ${provider}/${modelId}${thinkingLevel ? ` (thinking: ${thinkingLevel})` : ""}.`,
            },
          ],
          details: { ok: true, provider, modelId, thinkingLevel },
        };
      }

      if (op === "thinking.set") {
        const level = normalizeThinkingLevel(p.level);
        if (!level) {
          return {
            content: [{ type: "text", text: "Invalid thinking level." }],
            details: { ok: false },
          };
        }

        pi.setThinkingLevel(level);
        return {
          content: [{ type: "text", text: `OK: thinking level set to ${level}.` }],
          details: { ok: true, level },
        };
      }

      if (op === "slash.run") {
        const command = asString(p.command).trim();
        const force = Boolean(p.force);

        if (!isSlashCommand(command)) {
          return {
            content: [{ type: "text", text: "Invalid slash command. Expected a string starting with '/'." }],
            details: { ok: false },
          };
        }

        if (needsConfirmation(command)) {
          const ok = await confirmIfNeeded(ctx, force, command);
          if (!ok) {
            return {
              content: [{ type: "text", text: "Cancelled." }],
              details: { ok: false, cancelled: true },
            };
          }
        }

        const result = await runSlash(command, ctx);
        return {
          content: [{ type: "text", text: result.text }],
          details: { ok: result.ok, command },
        };
      }

      return {
        content: [{ type: "text", text: `Unsupported op: ${op}` }],
        details: { ok: false, op },
      };
    },
  });
}
