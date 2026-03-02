import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveScopedVaultRoot, shouldEnableWithinVaultScope } from "../../lib/shared/pi-vault-scope.ts";
import { asString } from "../../lib/shared/pi-string.ts";

export { asString };

export type UnitSnapshot = {
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  restarts: number;
  error: string;
};

function isVaultRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, "AGENTS.md")) && fs.existsSync(path.join(dir, "agents", "scripts", "pi-router"));
}

export function shouldEnableMasterServices(cwd: string): boolean {
  return shouldEnableWithinVaultScope(cwd, {
    envRoot: asString(process.env.PI_VAULT_ROOT),
    isVaultRoot,
  });
}

export function resolveMasterVaultRoot(cwd: string): string {
  const envRoot = asString(process.env.PI_VAULT_ROOT).trim();
  if (envRoot && isVaultRoot(envRoot)) return envRoot;
  return resolveScopedVaultRoot(cwd, { envRoot: "", isVaultRoot });
}

function readEnvFileValue(filePath: string, key: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      if (k !== key) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch {
    // ignore
  }
  return "";
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(filePath: string): number {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const n = Number(fs.readFileSync(filePath, "utf8").trim());
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.trunc(n);
  } catch {
    return 0;
  }
}

function pidByPattern(patterns: RegExp[]): number {
  try {
    const out = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 1200 });
    if ((out.status ?? 1) !== 0) return 0;
    for (const lineRaw of String(out.stdout || "").split("\n")) {
      const line = lineRaw.trim();
      if (!line) continue;
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const args = m[2] || "";
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (patterns.some((re) => re.test(args))) return pid;
    }
  } catch {
    // ignore
  }
  return 0;
}

function fallbackUnit(unit: string): UnitSnapshot {
  const vaultRoot = resolveMasterVaultRoot(process.cwd());
  const discordEnv = vaultRoot ? path.join(vaultRoot, ".pi-discord-bot.env") : "";
  const hubEnv = vaultRoot ? path.join(vaultRoot, ".pi-router.env") : "";

  const discordStateDir =
    asString(process.env.DISCORD_PI_STATE_DIR).trim() ||
    readEnvFileValue(discordEnv, "DISCORD_PI_STATE_DIR") ||
    path.join(os.homedir(), ".pi", "agent", "state", "pi-discord-bot");

  const hubStateDir =
    asString(process.env.PI_ROUTER_STATE_DIR).trim() ||
    readEnvFileValue(hubEnv, "PI_ROUTER_STATE_DIR") ||
    path.join(os.homedir(), ".pi", "agent", "state", "pi-router");

  const base: UnitSnapshot = {
    loadState: "loaded",
    activeState: "inactive",
    subState: "dead",
    result: "unknown",
    restarts: 0,
    error: "fallback",
  };

  if (unit === "pi-router.service") {
    let pid = readPidFile(path.join(hubStateDir, "platform.pid"));
    if (!pidAlive(pid)) {
      pid = pidByPattern([/pi-router[\/].*dist[\/]main\.mjs/, /pi-router[\/].*supervisor\.loop\.sh/]);
    }
    if (pidAlive(pid)) {
      return { ...base, activeState: "active", subState: "running", result: "success", error: "" };
    }
    return { ...base, result: "exit-code" };
  }

  if (unit === "pi-discord-bot.service") {
    let pid = readPidFile(path.join(discordStateDir, "platform.pid"));
    if (!pidAlive(pid)) {
      pid = pidByPattern([/pi-discord-bot[\/].*dist[\/]main\.mjs/, /pi-discord-bot[\/].*supervisor\.loop\.sh/]);
    }
    if (pidAlive(pid)) {
      return { ...base, activeState: "active", subState: "running", result: "success", error: "" };
    }
    return { ...base, result: "exit-code" };
  }

  return base;
}

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
    const fallback = fallbackUnit(unit);
    if (fallback.activeState === "active" || fallback.result !== "unknown") return fallback;

    const err = out.error ? asString((out.error as Error).message) : String(out.stderr || "").trim();
    return {
      loadState: "",
      activeState: "",
      subState: "",
      result: "",
      restarts: 0,
      error: err || "systemctl unavailable",
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

export function unitBadge(label: string, snap: UnitSnapshot): string {
  const restartsSuffix = snap.restarts > 0 ? ` r=${snap.restarts}` : "";

  if (snap.error && snap.error !== "fallback") return `${label} ⚪?`;
  if (snap.loadState === "not-found") return `${label} ⚪missing`;

  if (snap.activeState === "active") return `${label} 🟢${restartsSuffix}`;
  if (snap.activeState === "inactive") return `${label} ⚪${restartsSuffix}`;
  if (snap.activeState === "failed") {
    const detail = snap.result && snap.result !== "success" ? `(${snap.result})` : "";
    return `${label} 🔴failed${detail ? " " + detail : ""}${restartsSuffix}`;
  }
  if (snap.activeState === "activating" || snap.activeState === "deactivating" || snap.activeState === "reloading") {
    const detail = snap.subState ? `(${snap.subState})` : "";
    return `${label} 🟡${snap.activeState}${detail ? " " + detail : ""}${restartsSuffix}`;
  }

  return `${label} ⚪${snap.activeState || "?"}${restartsSuffix}`;
}
