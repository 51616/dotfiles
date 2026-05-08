import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fallbackAuditResult, parseAuditResult } from "./do-not-stop-audit.ts";
import type { DoNotStopAuditResult } from "./do-not-stop.ts";

export type AuditExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
};

export type AuditExec = (
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<AuditExecResult>;

export type AuditRunnerOptions = {
  exec: AuditExec;
  prompt: string;
  cwd: string;
  model?: { provider?: string; id?: string };
  signal?: AbortSignal;
  nowMs?: () => number;
  auditSessionPath?: string;
  maxTotalMs?: number;
  perAttemptMaxMs?: number;
  retryDelayMs?: number;
  waitMs?: (ms: number) => Promise<void>;
};

export type AuditRunnerOutcome = {
  ok: boolean;
  audit: DoNotStopAuditResult;
  failureReason?: string;
  attempts: number;
  auditSessionPath: string;
  commands: string[][];
};

const DEFAULT_MAX_TOTAL_MS = 60 * 60 * 1000;
const DEFAULT_PER_ATTEMPT_MAX_MS = 20 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 250;

function defaultNowMs(): number {
  return Date.now();
}

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeGoalSessionComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "audit";
}

export function defaultAuditSessionPath(goalId: string, nowMs = Date.now()): string {
  return join("/tmp/pi-work/do-not-stop-audits", `${nowMs}-${sanitizeGoalSessionComponent(goalId)}.jsonl`);
}

export function buildAuditCommandArgs(options: {
  prompt: string;
  model?: { provider?: string; id?: string };
  auditSessionPath: string;
}): string[] {
  const args = ["-p"];
  const provider = options.model?.provider?.trim();
  const id = options.model?.id?.trim();
  if (provider && id) {
    args.push("--model", `${provider}/${id}`);
  } else if (id) {
    args.push("--model", id);
  }
  args.push("--thinking", "medium", "--session", options.auditSessionPath, options.prompt);
  return args;
}

function classifyFailure(result: AuditExecResult): string {
  if (result.killed) return "audit timed out";
  if (result.code !== 0) return `audit process exited ${result.code}: ${result.stderr || result.stdout || "no output"}`;
  return "audit did not produce a usable result";
}

export async function runDoNotStopAudit(options: AuditRunnerOptions): Promise<AuditRunnerOutcome> {
  const nowMs = options.nowMs ?? defaultNowMs;
  const waitMs = options.waitMs ?? defaultWaitMs;
  const maxTotalMs = options.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const perAttemptMaxMs = options.perAttemptMaxMs ?? DEFAULT_PER_ATTEMPT_MAX_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const startedAtMs = nowMs();
  const auditSessionPath = options.auditSessionPath ?? defaultAuditSessionPath("goal", startedAtMs);
  const commands: string[][] = [];
  let attempts = 0;
  let failureReason = "audit did not run";

  if (auditSessionPath.includes("/") || auditSessionPath.includes("\\")) {
    mkdirSync(dirname(auditSessionPath), { recursive: true });
  }

  while (nowMs() - startedAtMs < maxTotalMs) {
    const remainingMs = Math.max(1, maxTotalMs - (nowMs() - startedAtMs));
    const timeout = Math.max(1, Math.min(perAttemptMaxMs, remainingMs));
    const args = buildAuditCommandArgs({ prompt: options.prompt, model: options.model, auditSessionPath });
    commands.push(args);
    attempts += 1;

    let result: AuditExecResult;
    try {
      result = await options.exec("pi", args, { cwd: options.cwd, timeout, signal: options.signal });
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
      if (nowMs() - startedAtMs >= maxTotalMs) break;
      await waitMs(Math.min(retryDelayMs, Math.max(0, maxTotalMs - (nowMs() - startedAtMs))));
      continue;
    }

    if (result.code === 0 && !result.killed) {
      try {
        const audit = parseAuditResult(result.stdout);
        return { ok: true, audit, attempts, auditSessionPath, commands };
      } catch (error) {
        failureReason = error instanceof Error ? error.message : String(error);
      }
    } else {
      failureReason = classifyFailure(result);
    }

    if (nowMs() - startedAtMs >= maxTotalMs) break;
    await waitMs(Math.min(retryDelayMs, Math.max(0, maxTotalMs - (nowMs() - startedAtMs))));
  }

  return {
    ok: false,
    audit: fallbackAuditResult(failureReason),
    failureReason,
    attempts,
    auditSessionPath,
    commands,
  };
}
