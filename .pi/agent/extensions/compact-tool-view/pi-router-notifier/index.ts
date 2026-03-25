import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { shouldEnableWithinVaultScope } from "../lib/shared/pi-vault-scope.ts";
import { parseBool } from "../lib/shared/pi-bool.ts";
import { asString } from "../lib/shared/pi-string.ts";
import { readCursor, writeCursorAtomic } from "./cursor.ts";

function expandHome(p: string): string {
  if (!p) return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultHubEventsPath(): string {
  const stateDir =
    asString(process.env.PI_ROUTER_STATE_DIR).trim() || path.join(os.homedir(), ".pi", "agent", "state", "pi-router");
  return path.join(stateDir, "router-events.jsonl");
}

function getHubEventsPath(): string {
  const direct = asString(process.env.PI_ROUTER_EVENTS_LOG).trim();
  if (direct) return expandHome(direct);
  return defaultHubEventsPath();
}

function isVaultRoot(dir: string): boolean {
  const hasAgents = fs.existsSync(path.join(dir, "AGENTS.md"));
  const hasHub = fs.existsSync(path.join(dir, ".pi", "scripts", "pi-router"));
  return hasAgents && hasHub;
}

function shouldEnableForCwd(cwd: string): boolean {
  const force = parseBool(process.env.PI_ROUTER_NOTIFY_ENABLE, false);
  if (force) return true;

  return shouldEnableWithinVaultScope(cwd, {
    envRoot: asString(process.env.PI_VAULT_ROOT),
    isVaultRoot,
  });
}

function isAsyncController(rec: any): boolean {
  const name = asString(rec?.controller?.name).trim();
  // Marked by instances.mjs send-async
  return name === "pi-router-async";
}

function summarize(rec: any): { title: string; body: string } {
  const kind = asString(rec?.kind);
  const jobId = asString(rec?.job_id);
  const targetName = asString(rec?.target?.name) || asString(rec?.target?.id) || "";

  const head = kind === "reply_error" ? "async worker job failed" : "async worker job finished";
  const title = `pi-router: ${head}`;

  let text = "";
  if (kind === "reply_error") {
    text = asString(rec?.error) || "";
    if (text && !text.startsWith("[ERROR]")) text = `[ERROR] ${text}`;
  } else {
    text = asString(rec?.text) || "";
  }

  const body = [
    targetName ? `worker: ${targetName}` : "",
    jobId ? `hub_job: ${jobId}` : "",
    "---",
    String(text || "").trim(),
  ]
    .filter(Boolean)
    .join("\n");

  return { title, body };
}

export default function piRouterNotifier(pi: ExtensionAPI) {
  let timer: NodeJS.Timeout | null = null;
  let fd: number | null = null;
  let offset = 0;
  let buffer = "";
  let lastCtx: ExtensionContext | null = null;

  const cursorPath = path.join(os.homedir(), ".pi", "agent", "state", "pi-router-notifier", "cursor.json");

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      fd = null;
    }
    if (lastCtx?.hasUI) {
      lastCtx.ui.setStatus("pi-router-2-notify", undefined);
    }
  }

  function start(ctx: ExtensionContext) {
    lastCtx = ctx;
    const eventsPath = getHubEventsPath();

    // init cursor
    const cursor = readCursor(cursorPath);
    offset = cursor.offset || 0;

    // reset offset if file shrank
    try {
      const st = fs.statSync(eventsPath);
      if (Number(st.size || 0) < offset) offset = 0;
    } catch {
      offset = 0;
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-router-2-notify", "| Notify 🟢");
    }

    timer = setInterval(() => {
      try {
        tick(ctx, eventsPath);
      } catch {
        // ignore
      }
    }, 500);
    timer.unref?.();
  }

  function tick(ctx: ExtensionContext, eventsPath: string) {
    if (!fs.existsSync(eventsPath)) return;

    if (fd === null) {
      try {
        fd = fs.openSync(eventsPath, "r");
      } catch {
        return;
      }
    }

    let st;
    try {
      st = fs.fstatSync(fd);
    } catch {
      return;
    }

    const size = Number(st.size || 0);
    if (size <= offset) return;

    const toRead = Math.min(1_000_000, size - offset);
    const buf = Buffer.alloc(toRead);

    let read = 0;
    try {
      read = fs.readSync(fd, buf, 0, toRead, offset);
    } catch {
      return;
    }

    if (read <= 0) return;

    offset += read;
    buffer += buf.slice(0, read).toString("utf8");

    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;

      let rec: any;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const kind = asString(rec?.kind);
      if (kind !== "reply" && kind !== "reply_error") continue;
      if (!isAsyncController(rec)) continue;

      if (ctx.hasUI) {
        const { title, body } = summarize(rec);
        ctx.ui.notify(title + "\n\n" + body, kind === "reply_error" ? "error" : "info");
      }
    }

    writeCursorAtomic(cursorPath, { offset, updated_at: new Date().toISOString() });
  }

  pi.on("session_start", async (_event, ctx) => {
    stop();

    const cwd = asString(ctx?.cwd).trim() || process.cwd();
    if (!shouldEnableForCwd(cwd)) return;

    start(ctx);
  });

  pi.on("session_end", async () => {
    stop();
    lastCtx = null;
  });
}
