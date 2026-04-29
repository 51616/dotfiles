import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString } from "./pi-instance-manager-common.ts";

export type UnitSnapshot = {
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  restarts: number;
  error: string;
};

export function readUnitSnapshot(unit: string): UnitSnapshot {
  const out = spawnSync(
    "systemctl",
    [
      "--user",
      "show",
      unit,
      "--property=LoadState,ActiveState,SubState,Result,NRestarts",
      "--no-pager",
    ],
    { encoding: "utf8", timeout: 1500 },
  );

  if (out.error || (out.status ?? 1) !== 0) {
    const err = out.error ? asString((out.error as Error).message) : String(out.stderr || "").trim();
    return {
      loadState: "",
      activeState: "",
      subState: "",
      result: "",
      restarts: 0,
      error: err || `systemctl rc=${out.status ?? "?"}`,
    };
  }

  const props = new Map<string, string>();
  for (const line of String(out.stdout || "").split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    props.set(line.slice(0, i), line.slice(i + 1));
  }

  const restartsRaw = Number(props.get("NRestarts") || 0);

  return {
    loadState: asString(props.get("LoadState") || "").trim(),
    activeState: asString(props.get("ActiveState") || "").trim(),
    subState: asString(props.get("SubState") || "").trim(),
    result: asString(props.get("Result") || "").trim(),
    restarts: Number.isFinite(restartsRaw) ? restartsRaw : 0,
    error: "",
  };
}

export function discordBadge(snap: UnitSnapshot): string {
  const restartsSuffix = snap.restarts > 0 ? ` (restarts: ${snap.restarts})` : "";

  if (snap.error) return `| 󰙯 Unknown${restartsSuffix}`;
  if (snap.loadState === "not-found") return `| 󰙯 Missing${restartsSuffix}`;
  if (snap.activeState === "active") return `| 󰙯 Online${restartsSuffix}`;
  if (snap.activeState === "inactive") return `| 󰙯 Offline${restartsSuffix}`;
  if (snap.activeState === "failed") {
    const detail = snap.result && snap.result !== "success" ? ` (${snap.result})` : "";
    return `| 󰙯 Failed${detail}${restartsSuffix}`;
  }
  if (snap.activeState === "activating" || snap.activeState === "deactivating" || snap.activeState === "reloading") {
    const label = snap.activeState[0].toUpperCase() + snap.activeState.slice(1);
    const detail = snap.subState ? ` (${snap.subState})` : "";
    return `| 󰙯 ${label}${detail}${restartsSuffix}`;
  }
  const label = snap.activeState ? snap.activeState[0].toUpperCase() + snap.activeState.slice(1) : "Unknown";
  return `| 󰙯 ${label}${restartsSuffix}`;
}

export function renderDiscordServiceStatus(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("pi-services", discordBadge(readUnitSnapshot("pi-discord-bot.service")));
}

export function clearDiscordServiceStatus(ctx: ExtensionContext | null) {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus("pi-services", undefined);
}

export function startDiscordServiceStatusRefresh(ctx: ExtensionContext, intervalMs = 15_000): () => void {
  if (!ctx.hasUI) return () => {};

  renderDiscordServiceStatus(ctx);

  const timer = setInterval(() => {
    try {
      renderDiscordServiceStatus(ctx);
    } catch {
      // ignore status refresh errors
    }
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    clearDiscordServiceStatus(ctx);
  };
}

export function createDiscordServiceStatusController() {
  let stopRefresh: (() => void) | null = null;
  let lastUiCtx: ExtensionContext | null = null;

  function stop(ctx: ExtensionContext | null = null) {
    const clearCtx = ctx?.hasUI ? ctx : lastUiCtx;
    if (stopRefresh) {
      stopRefresh();
      stopRefresh = null;
    } else {
      clearDiscordServiceStatus(clearCtx);
    }
    lastUiCtx = null;
  }

  function start(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    stop(ctx);
    lastUiCtx = ctx;
    stopRefresh = startDiscordServiceStatusRefresh(ctx);
  }

  return { start, stop };
}
