import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { shouldEnableWithinVaultScope } from "../../lib/shared/pi-vault-scope.ts";
import { parseBool } from "../../lib/shared/pi-bool.ts";
import { asString } from "../../lib/shared/pi-string.ts";

export { asString };

export type ManagerLock = {
  sessionId?: string;
  token?: string;
  owner?: string;
  acquiredAt?: number;
  expiresAt?: number;
  lastRenewedAt?: number;
  renewCount?: number;
};

export type ManagerTurnItem = {
  ticketId?: string;
  sessionId?: string;
  owner?: string;
  state?: "queued" | "granted";
  createdAt?: number;
  grantedAt?: number;
  lastSeenAt?: number;
  preview?: string;
};

export type ManagerTurnQueue = {
  sessionId?: string;
  total?: number;
  queued?: number;
  activeTicketId?: string;
  activeOwner?: string;
  items?: ManagerTurnItem[];
};

export type ManagerState = {
  compacting?: boolean;
  activeCompactions?: Array<{ sessionId?: string; id?: string }>;
  activeLocks?: ManagerLock[];
  queuedTurnRequests?: number;
  turnQueues?: ManagerTurnQueue[];
};

export type ManagerStateProbe = {
  state: ManagerState | null;
  errorMessage: string;
  errorCode: string;
  socketPath: string;
  socketPresent: boolean;
};

type ManagerResponse = { id?: string; ok?: boolean; data?: any; error?: string };

export const TURN_LOCK_LEASE_MS = 25_000;
export const TURN_LOCK_RENEW_MS = 8_000;
export const LOCK_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

function isVaultRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, "AGENTS.md")) && fs.existsSync(path.join(dir, "agents"));
}

export function shouldEnable(cwd: string): boolean {
  const disabled = parseBool(process.env.PI_INSTANCE_MANAGER_DISABLE, false);
  if (disabled) return false;

  const forced = parseBool(process.env.PI_INSTANCE_MANAGER_ENABLE, false);
  if (forced) return true;

  return shouldEnableWithinVaultScope(cwd, {
    envRoot: asString(process.env.PI_VAULT_ROOT),
    isVaultRoot,
  });
}

function stateDir(): string {
  const direct = asString(process.env.PI_INSTANCE_MANAGER_STATE_DIR).trim();
  if (direct) return direct;
  return path.join(os.homedir(), ".pi", "agent", "state", "pi-instance-manager");
}

function socketPath(): string {
  const direct = asString(process.env.PI_INSTANCE_MANAGER_SOCKET).trim();
  if (direct) return direct;
  return path.join(stateDir(), "manager.sock");
}

function classifyManagerError(error: unknown): { code: string; message: string } {
  const maybe = error as { code?: unknown; message?: unknown };
  const rawCode = asString(maybe?.code).trim();
  const rawMessage = asString(maybe?.message).trim() || String(error || "manager error");
  const lower = rawMessage.toLowerCase();

  if (rawCode) return { code: rawCode, message: rawMessage };
  if (lower.includes("connection refused")) return { code: "ECONNREFUSED", message: rawMessage };
  if (lower.includes("no such file") || lower.includes("enoent")) return { code: "ENOENT", message: rawMessage };
  if (lower.includes("socket closed")) return { code: "SOCKET_CLOSED", message: rawMessage };
  if (lower.includes("timeout")) return { code: "TIMEOUT", message: rawMessage };
  return { code: "UNKNOWN", message: rawMessage };
}

export async function managerRequest(op: string, payload: Record<string, unknown>, timeoutMs = 800): Promise<any> {
  const sockPath = socketPath();
  const id = `pi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const req = { id, op, ...payload };

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      reject(new Error("timeout"));
    }, Math.max(50, timeoutMs));

    const sock = net.createConnection(sockPath);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.end();
      } catch {
        // ignore
      }
      fn();
    };

    sock.on("connect", () => {
      try {
        sock.write(`${JSON.stringify(req)}\n`);
      } catch (e) {
        finish(() => reject(e));
      }
    });

    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();

      let parsed: ManagerResponse;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        finish(() => reject(e));
        return;
      }

      if (parsed.id && parsed.id !== id) return;

      if (!parsed.ok) {
        finish(() => reject(new Error(asString(parsed.error) || "manager error")));
        return;
      }

      finish(() => resolve(parsed.data ?? null));
    });

    sock.on("error", (e) => finish(() => reject(e)));
    sock.on("close", () => {
      if (settled) return;
      finish(() => reject(new Error("socket closed")));
    });
  });
}

export async function probeManagerState(timeoutMs = 600): Promise<ManagerStateProbe> {
  const sockPath = socketPath();

  try {
    const data = await managerRequest("state.get", {}, timeoutMs);
    const state = data?.state;
    if (!state || typeof state !== "object") {
      return {
        state: null,
        errorMessage: "state.get returned empty state",
        errorCode: "EMPTY_STATE",
        socketPath: sockPath,
        socketPresent: fs.existsSync(sockPath),
      };
    }

    return {
      state: state as ManagerState,
      errorMessage: "",
      errorCode: "",
      socketPath: sockPath,
      socketPresent: fs.existsSync(sockPath),
    };
  } catch (error) {
    const classified = classifyManagerError(error);
    return {
      state: null,
      errorMessage: classified.message,
      errorCode: classified.code,
      socketPath: sockPath,
      socketPresent: fs.existsSync(sockPath),
    };
  }
}

export async function getManagerState(timeoutMs = 600): Promise<ManagerState | null> {
  const probe = await probeManagerState(timeoutMs);
  return probe.state;
}
