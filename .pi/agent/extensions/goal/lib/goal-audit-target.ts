import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { posix as posixPath } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getActivePiSshSession, type PiSshConnectionInfo, type PiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

export type GoalAuditSshTarget = {
  remote: string;
  port: number;
  remoteCwd: string;
};

export type GoalAuditTarget = {
  promptCwd: string;
  promptSessionFile?: string;
  promptCheckpointDir?: string;
  promptConductorDir?: string;
  ssh?: GoalAuditSshTarget;
};

const REMOTE_SESSION_SNAPSHOT_DIR = ".cache/pi/goal/session-snapshots";
const REMOTE_CHECKPOINT_DIR = "/tmp/pi-work/checkpoints";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sanitizeRemoteSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "session";
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function getSessionCwd(ctx: ExtensionContext): string {
  const raw =
    typeof (ctx as unknown as { sessionManager?: { getCwd?: () => unknown } }).sessionManager?.getCwd === "function"
      ? (ctx as unknown as { sessionManager: { getCwd: () => unknown } }).sessionManager.getCwd()
      : ctx.cwd;
  const value = String(raw ?? "").trim();
  return value || ctx.cwd;
}

function getSessionId(ctx: ExtensionContext): string {
  const raw =
    typeof (ctx as unknown as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager?.getSessionId === "function"
      ? (ctx as unknown as { sessionManager: { getSessionId: () => unknown } }).sessionManager.getSessionId()
      : "";
  return String(raw ?? "").trim();
}

function getSessionFile(ctx: ExtensionContext): string | undefined {
  const raw =
    typeof (ctx as unknown as { sessionManager?: { getSessionFile?: () => unknown } }).sessionManager?.getSessionFile ===
    "function"
      ? (ctx as unknown as { sessionManager: { getSessionFile: () => unknown } }).sessionManager.getSessionFile()
      : undefined;
  const value = String(raw ?? "").trim();
  return value || undefined;
}

async function remotePathExists(session: PiSshSession, remotePath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return await session.exists(remotePath, signal);
  } catch {
    return false;
  }
}

function buildRemoteSessionSnapshotPath(session: PiSshSession, ctx: ExtensionContext, localSessionFile: string): string {
  const remoteHome = normalizeRemotePath(session.getRemoteContext(ctx.signal).remoteHome);
  const sessionComponent = sanitizeRemoteSessionName(getSessionId(ctx) || basename(localSessionFile));
  return posixPath.join(remoteHome, REMOTE_SESSION_SNAPSHOT_DIR, `${sessionComponent}.jsonl`);
}

async function syncSessionFileToRemote(session: PiSshSession, ctx: ExtensionContext, localSessionFile: string): Promise<string> {
  const remoteSessionFile = buildRemoteSessionSnapshotPath(session, ctx, localSessionFile);
  const remoteSessionDir = posixPath.dirname(remoteSessionFile);
  const sessionBytes = readFileSync(localSessionFile);
  const mkdirResult = await session.execCapture(`mkdir -p -- ${shellQuote(remoteSessionDir)}`, {
    signal: ctx.signal,
    timeoutSeconds: 15,
  });
  if (mkdirResult.aborted) {
    throw new Error("remote session snapshot directory creation was aborted");
  }
  if (mkdirResult.timedOut) {
    throw new Error("remote session snapshot directory creation timed out");
  }
  if (mkdirResult.exitCode !== 0) {
    const stderr = mkdirResult.stderr.toString("utf-8").trim();
    throw new Error(`remote session snapshot directory creation failed: ${stderr || `exit ${mkdirResult.exitCode}`}`);
  }

  await session.getRemoteContext(ctx.signal).transport.writeFile(remoteSessionFile, sessionBytes, ctx.signal);
  return remoteSessionFile;
}

function buildSshTarget(connection: PiSshConnectionInfo, remoteCwd: string): GoalAuditSshTarget {
  return {
    remote: connection.remote,
    port: connection.port,
    remoteCwd,
  };
}

function resolveRemoteCwdForContext(session: PiSshSession, ctx: ExtensionContext, connection: PiSshConnectionInfo): string {
  const localCwd = getSessionCwd(ctx);
  const mapped = normalizeRemotePath(session.mapLocalPathToRemote(localCwd));
  const normalizedLocalCwd = normalizeRemotePath(localCwd);
  if (mapped && mapped !== normalizedLocalCwd && mapped.startsWith("/")) {
    return mapped;
  }
  return normalizeRemotePath(connection.remoteCwd);
}

async function buildSshAuditTarget(session: PiSshSession, ctx: ExtensionContext): Promise<GoalAuditTarget> {
  const connection = session.getConnectionInfo();
  const remoteCwd = resolveRemoteCwdForContext(session, ctx, connection);
  const localSessionFile = getSessionFile(ctx);
  const promptSessionFile = localSessionFile ? await syncSessionFileToRemote(session, ctx, localSessionFile) : undefined;
  const remoteConductorDir = posixPath.join(remoteCwd, "conductor", "tracks");

  return {
    promptCwd: remoteCwd,
    promptSessionFile,
    promptCheckpointDir: (await remotePathExists(session, REMOTE_CHECKPOINT_DIR, ctx.signal)) ? REMOTE_CHECKPOINT_DIR : undefined,
    promptConductorDir: (await remotePathExists(session, remoteConductorDir, ctx.signal)) ? remoteConductorDir : undefined,
    ssh: buildSshTarget(connection, remoteCwd),
  };
}

export async function resolveGoalAuditTarget(ctx: ExtensionContext): Promise<GoalAuditTarget> {
  const sshSession = getActivePiSshSession();
  if (sshSession) {
    return buildSshAuditTarget(sshSession, ctx);
  }

  const checkpointDir = REMOTE_CHECKPOINT_DIR;
  const conductorDir = join(ctx.cwd, "conductor", "tracks");
  return {
    promptCwd: ctx.cwd,
    promptSessionFile: getSessionFile(ctx),
    promptCheckpointDir: existsSync(checkpointDir) ? checkpointDir : undefined,
    promptConductorDir: existsSync(conductorDir) ? conductorDir : undefined,
  };
}
