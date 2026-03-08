import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  CHECKPOINT_NOW_MARKER,
  CONTEXT_STAMP_MARKER,
} from "../lib/autockpt/autockpt-markers.ts";
import { isCheckpointCycleActive } from "../lib/autockpt/autockpt-runtime-state.ts";
import {
  appendStampToText,
  containsAutockptFooterMarkers,
  extractTextContent,
  isMachineControlAssistantText,
} from "./context-stamp-message-utils.ts";

/**
 * Context Stamp
 *
 * Injects a context stamp only when auto-checkpointing is armed:
 * - at the end of each tool result message
 * - at the end of assistant messages AFTER send (history annotation only)
 *
 * Notes / tradeoffs:
 * - We intentionally avoid always-on stamping to reduce transcript noise.
 * - For assistant machine-control responses and auto-checkpoint footers, we skip stamping
 *   so downstream parsers keep exact matching behavior.
 * - ctx.getContextUsage() can return tokens=null (right after compaction, before next LLM response);
 *   in that state we cannot arm and therefore emit nothing.
 * - During an active checkpoint cycle, we suppress stamping so we do not retrigger or add noise
 *   while auto-kick / compaction is already in flight.
 */
export default function contextStamp(pi: ExtensionAPI) {
  let enabled = (process.env.PI_CONTEXT_STAMP_ENABLE ?? "1") !== "0";

  const MARKER = CONTEXT_STAMP_MARKER;

  const getSelfCheckpointThresholdPercent = (): number =>
    Number.parseFloat(
      process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME ??
        process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT ??
        process.env.PI_AUTOCHECKPOINT_THRESHOLD_PERCENT ??
        "65",
    );

  const buildStampLine = (ctx: {
    getContextUsage: () => { tokens: number | null; contextWindow: number; percent?: number | null } | undefined;
  }) => {
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;

    const window = usage.contextWindow ?? 0;
    if (window <= 0) return undefined;
    if (usage.tokens === null) return undefined;

    const used = Math.max(0, Math.round(usage.tokens));
    const percent = usage.percent ?? (window > 0 ? (used / window) * 100 : null);
    if (percent === null) return undefined;

    const thresholdPercent = getSelfCheckpointThresholdPercent();
    const checkpointNow = percent >= thresholdPercent;
    if (!checkpointNow) return undefined;
    if (isCheckpointCycleActive(ctx as any)) return undefined;

    const percentStr = percent.toFixed(1) + "%";
    const left = Math.max(0, window - used);
    return `${MARKER} used=${used} (${percentStr}) left=${left} window=${window} ${CHECKPOINT_NOW_MARKER}`;
  };

  const hasStampAlready = (text: string) => text.includes(MARKER);

  pi.registerCommand("ctxstamp", {
    description: "Context-stamp controls (toggle|status|threshold <pct>)",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();

      if (a === "" || a === "toggle") {
        enabled = !enabled;
        ctx.ui.setStatus("ctxstamp", undefined);
        ctx.ui.notify(enabled ? "Context stamping enabled" : "Context stamping disabled", "info");
        return;
      }

      if (a === "status") {
        const threshold = getSelfCheckpointThresholdPercent();
        const runtime = process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME;
        ctx.ui.notify(
          `ctxstamp enabled=${enabled} threshold=${threshold}%` +
            (runtime ? ` (runtime override=${runtime}%)` : "") +
            " (stamp only appears when checkpointing is armed)",
          "info",
        );
        return;
      }

      if (a.startsWith("threshold")) {
        const rest = a.slice("threshold".length).trim();
        if (rest === "" || rest === "reset") {
          delete process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME;
          ctx.ui.notify(`ctxstamp threshold reset (runtime override cleared)`, "info");
          return;
        }

        const next = Number.parseFloat(rest);
        if (!Number.isFinite(next) || next < 0 || next > 100) {
          ctx.ui.notify("Invalid threshold. Use: /ctxstamp threshold <0..100>", "warning");
          return;
        }

        process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME = String(next);
        ctx.ui.notify(`ctxstamp threshold set (runtime override) to ${next}%`, "info");
        return;
      }

      ctx.ui.notify("Usage: /ctxstamp [toggle|status|threshold <pct>|threshold reset]", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("ctxstamp", undefined);
  });

  pi.on("tool_result", (event, ctx) => {
    if (!enabled) return;

    const stampLine = buildStampLine(ctx);
    if (!stampLine) return;

    const existingText = extractTextContent(event.content);
    if (hasStampAlready(existingText)) return;

    return {
      content: [...event.content, { type: "text", text: `\n${stampLine}` }],
    };
  });

  pi.on("message_end", (event, ctx) => {
    if (!enabled) return;

    const msg = (event as any)?.message as any;
    if (!msg) return;

    const role = String(msg.role || "").trim();
    if (role !== "assistant") return;

    const content = msg.content;
    const existingText = extractTextContent(content);
    if (!existingText.trim()) return;
    if (isMachineControlAssistantText(existingText)) return;
    if (containsAutockptFooterMarkers(existingText)) return;
    if (hasStampAlready(existingText)) return;

    const stampLine = buildStampLine(ctx);
    if (!stampLine) return;

    if (typeof content === "string") {
      msg.content = appendStampToText(content, stampLine);
      return;
    }

    if (Array.isArray(content)) {
      msg.content = [...content, { type: "text", text: `\n\n${stampLine}` }];
    }
  });
}
