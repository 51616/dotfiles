import { createHash } from "node:crypto";
import path from "node:path";
import { buildFileKey, parseSingleFilePatch, splitPatchIntoFileSections } from "../pi-diff-review-tui/lib/diff-parser.ts";
import { getActivePiSshSession, type PiSshConnectionInfo, type PiSshSession } from "../pi-ssh/lib/pi-ssh-session-runtime.ts";

export type DiffReviewSshIdentity = {
  session: PiSshSession;
  connection: PiSshConnectionInfo;
  remoteCwd: string;
  repoRoot: string;
  scopeKey: string;
  repoLabel: string;
};

export type RemoteWorkspaceDiff = {
  head: string | null;
  patchText: string;
  nameStatus: string;
};

export type RemoteApplyReverseResult = {
  ok: boolean;
  strategyUsed: "direct" | "3way" | null;
  output: string;
};

export type RemoteCompareAndWriteResult = {
  ok: boolean;
  conflict: boolean;
  missing: boolean;
  symlink: boolean;
  hardlink: boolean;
};

const REMOTE_REPO_PATH_INSPECT_SCRIPT = String.raw`import json, os, stat, sys
path = sys.argv[1]
if not os.path.lexists(path):
    print(json.dumps({"exists": False, "isFile": False, "isSymlink": False, "linkCount": None, "sizeBytes": None}, separators=(",", ":")))
    raise SystemExit(0)
lstat_info = os.lstat(path)
is_symlink = stat.S_ISLNK(lstat_info.st_mode)
if is_symlink:
    print(json.dumps({"exists": True, "isFile": False, "isSymlink": True, "linkCount": None, "sizeBytes": None}, separators=(",", ":")))
    raise SystemExit(0)
print(json.dumps({
    "exists": True,
    "isFile": stat.S_ISREG(lstat_info.st_mode),
    "isSymlink": False,
    "linkCount": int(lstat_info.st_nlink),
    "sizeBytes": int(lstat_info.st_size),
}, separators=(",", ":")))`;

const REMOTE_COMPARE_AND_WRITE_SCRIPT = String.raw`import hashlib, json, os, sys, tempfile
path = sys.argv[1]
expected_hash = sys.argv[2]
payload = sys.stdin.buffer.read()
try:
    original_lstat = os.lstat(path)
    if os.path.islink(path):
        print(json.dumps({"ok": False, "conflict": False, "missing": False, "symlink": True, "hardlink": False}, separators=(",", ":")))
        raise SystemExit(0)
    original_stat = os.stat(path)
    if original_stat.st_nlink > 1:
        print(json.dumps({"ok": False, "conflict": False, "missing": False, "symlink": False, "hardlink": True}, separators=(",", ":")))
        raise SystemExit(0)
    with open(path, "rb") as fh:
        current = fh.read()
except FileNotFoundError:
    print(json.dumps({"ok": False, "conflict": True, "missing": True, "symlink": False, "hardlink": False}, separators=(",", ":")))
    raise SystemExit(0)
current_hash = hashlib.sha256(current).hexdigest()
if current_hash != expected_hash:
    print(json.dumps({"ok": False, "conflict": True, "missing": False, "symlink": False, "hardlink": False}, separators=(",", ":")))
    raise SystemExit(0)
dir_name = os.path.dirname(path) or "."
fd, tmp_path = tempfile.mkstemp(prefix=".pi-diff-review-write-", dir=dir_name)
try:
    with os.fdopen(fd, "wb") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp_path, original_stat.st_mode & 0o7777)
    os.replace(tmp_path, path)
except Exception:
    try:
        os.unlink(tmp_path)
    except FileNotFoundError:
        pass
    raise
print(json.dumps({"ok": True, "conflict": False, "missing": False, "symlink": False, "hardlink": False}, separators=(",", ":")))`;

function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellJoin(argv: string[]): string {
  return argv.map((value) => shellQuote(value)).join(" ");
}

function normalizeText(buffer: Buffer): string {
  return buffer.toString("utf-8").replace(/\r\n/g, "\n");
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function validateRepoRelPath(value: string): string | null {
  const v = normalizeRemotePath(String(value ?? "")).trim();
  if (!v) return null;
  if (v.startsWith("/")) return null;
  if (v.includes("\u0000")) return null;
  const parts = v.split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function throwExecFailure(prefix: string, result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean }): never {
  if (result.aborted) throw new Error(`${prefix}: aborted`);
  if (result.timedOut) throw new Error(`${prefix}: timed out`);
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
  throw new Error(`${prefix}: ${detail}`);
}

async function runRemoteCommand(
  session: PiSshSession,
  command: string,
  options: { stdin?: string | Buffer; timeoutSeconds?: number; allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (options.stdin == null) {
    const result = await session.execText(command, {
      timeoutSeconds: options.timeoutSeconds ?? 60,
    });
    const normalized = normalizeText(Buffer.from(result.output, "utf-8"));
    const response = {
      stdout: normalized,
      stderr: "",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
    if (response.aborted || response.timedOut) {
      throwExecFailure(`remote command failed`, response);
    }
    if (!options.allowFailure && response.exitCode !== 0) {
      throwExecFailure(`remote command failed`, response);
    }
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
    };
  }

  const result = await session.execCapture(command, {
    stdin: options.stdin,
    timeoutSeconds: options.timeoutSeconds ?? 60,
  });
  const response = {
    stdout: normalizeText(result.stdout),
    stderr: normalizeText(result.stderr),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
  };
  if (response.aborted || response.timedOut) {
    throwExecFailure(`remote command failed`, response);
  }
  if (!options.allowFailure && response.exitCode !== 0) {
    throwExecFailure(`remote command failed`, response);
  }
  return {
    stdout: response.stdout,
    stderr: response.stderr,
    exitCode: response.exitCode,
  };
}

function buildRemoteGitCommand(repoRoot: string, args: string[], options: { suppressStderr?: boolean } = {}): string {
  const gitCommand = `env GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true ${shellJoin(["git", ...args])}`;
  return [
    `cd -- ${shellQuote(repoRoot)}`,
    options.suppressStderr ? `${gitCommand} 2>/dev/null` : gitCommand,
  ].join(" && ");
}

async function runRemoteGit(
  session: PiSshSession,
  repoRoot: string,
  args: string[],
  options: { stdin?: string | Buffer; timeoutSeconds?: number; allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runRemoteCommand(session, buildRemoteGitCommand(repoRoot, args, { suppressStderr: options.stdin == null }), options);
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function mergePatchTexts(primary: string, supplement: string): string {
  const sections: string[] = [];
  const seen = new Set<string>();

  for (const patchText of [primary, supplement]) {
    for (const section of splitPatchIntoFileSections(patchText)) {
      const fileKey = parseSingleFilePatch({ rawPatch: section }).fileKey;
      if (seen.has(fileKey)) continue;
      seen.add(fileKey);
      sections.push(section.trim());
    }
  }

  return sections.filter(Boolean).join("\n");
}

function mergeNameStatusOutputs(primaryOutput: string, supplementOutput: string): string {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const line of [primaryOutput, supplementOutput].flatMap((value) => splitLines(value))) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "M";
    const code = rawStatus[0] ?? "M";
    const oldPath = code === "R" ? (parts[1] ?? null) : (code === "A" ? null : (parts[1] ?? null));
    const newPath = code === "R" ? (parts[2] ?? null) : (code === "D" ? null : (parts[1] ?? null));
    const fileKey = buildFileKey(code === "A" || code === "D" || code === "R" ? code : "M", oldPath, newPath);
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);
    merged.push(line);
  }

  return merged.join("\n");
}

async function getRemoteHeadHash(session: PiSshSession, repoRoot: string): Promise<string | null> {
  const result = await runRemoteGit(session, repoRoot, ["rev-parse", "--verify", "HEAD"], {
    allowFailure: true,
    timeoutSeconds: 15,
  });
  if (result.exitCode !== 0) return null;
  const head = result.stdout.trim();
  return head || null;
}

async function getRemoteUntrackedPaths(session: PiSshSession, repoRoot: string, repoRelPath?: string): Promise<string[]> {
  const args = ["ls-files", "--others", "--exclude-standard"];
  if (repoRelPath) args.push("--", repoRelPath);
  const output = await runRemoteGit(session, repoRoot, args, { allowFailure: true, timeoutSeconds: 30 });
  if (output.exitCode !== 0) return [];
  return splitLines(output.stdout);
}

async function getRemoteNoIndexPatch(session: PiSshSession, repoRoot: string, repoRelPath: string): Promise<string> {
  const result = await runRemoteGit(session, repoRoot, ["diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", repoRelPath], {
    allowFailure: true,
    timeoutSeconds: 60,
  });
  return result.stdout.trim();
}

async function getRemoteWorkspacePaths(session: PiSshSession, repoRoot: string): Promise<string[]> {
  const output = await runRemoteGit(session, repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard"], {
    allowFailure: true,
    timeoutSeconds: 30,
  });
  const candidates = [...new Set(splitLines(output.stdout))].sort((left, right) => left.localeCompare(right));
  const existing: string[] = [];
  for (const repoRelPath of candidates) {
    const absolutePath = path.posix.join(repoRoot, repoRelPath);
    if (await session.exists(absolutePath)) {
      existing.push(repoRelPath);
    }
  }
  return existing;
}

function resolveRemoteCwdForLocalPath(session: PiSshSession, localCwd: string): string {
  const mapped = normalizeRemotePath(session.mapLocalPathToRemote(localCwd));
  if (mapped && mapped !== normalizeRemotePath(localCwd) && mapped.startsWith("/")) {
    return mapped;
  }
  return session.getConnectionInfo().remoteCwd;
}

async function tryResolveRepoRoot(session: PiSshSession, remoteCwd: string): Promise<string | null> {
  try {
    return await session.repoRoot(remoteCwd);
  } catch {
    return null;
  }
}

export function makeSshScopeKey(connection: Pick<PiSshConnectionInfo, "remote" | "port">, repoRoot: string): string {
  const remote = connection.port && connection.port !== 22 ? `${connection.remote}:${connection.port}` : connection.remote;
  return `ssh:${remote}:${repoRoot}`;
}

export async function resolveDiffReviewSshIdentity(localCwd: string): Promise<DiffReviewSshIdentity | null> {
  const session = getActivePiSshSession();
  if (!session) return null;

  const connection = session.getConnectionInfo();
  const remoteCwd = resolveRemoteCwdForLocalPath(session, localCwd);
  const repoRoot = await tryResolveRepoRoot(session, remoteCwd) ?? await tryResolveRepoRoot(session, connection.remoteCwd);
  if (!repoRoot) {
    throw new Error("Remote SSH workspace is not inside a git repository.");
  }

  const portSuffix = connection.port && connection.port !== 22 ? `:${connection.port}` : "";
  return {
    session,
    connection,
    remoteCwd,
    repoRoot,
    scopeKey: makeSshScopeKey(connection, repoRoot),
    repoLabel: `SSH ${connection.remote}${portSuffix} ${repoRoot}`,
  };
}

export function resolveRemoteRepoPathFromLocalInput(
  session: PiSshSession,
  repoRoot: string,
  localCwd: string,
  rawPath: string,
): { absolutePath: string; repoRelPath: string } | null {
  const raw = normalizeRemotePath(String(rawPath ?? "")).trim();
  if (!raw) return null;

  const remoteCwd = resolveRemoteCwdForLocalPath(session, localCwd);
  const absolutePath = raw.startsWith("/")
    ? path.posix.normalize(session.mapLocalPathToRemote(raw))
    : path.posix.resolve(remoteCwd, raw);

  const rel = path.posix.relative(normalizeRemotePath(repoRoot), absolutePath);
  if (!rel || rel === ".") return null;
  const repoRelPath = validateRepoRelPath(rel);
  if (!repoRelPath || repoRelPath.startsWith("../")) return null;
  return { absolutePath, repoRelPath };
}

export async function diffWorkspace(session: PiSshSession, repoRoot: string): Promise<RemoteWorkspaceDiff> {
  const head = await getRemoteHeadHash(session, repoRoot);

  if (head) {
    const [headTracked, stagedOnlyTracked, headNameStatus, stagedNameStatus, untrackedPaths] = await Promise.all([
      runRemoteGit(session, repoRoot, ["diff", "--no-color", "--find-renames", "-M", "--binary", head, "--"], { allowFailure: true, timeoutSeconds: 60 }),
      runRemoteGit(session, repoRoot, ["diff", "--cached", "--no-color", "--find-renames", "-M", "--binary", head, "--"], { allowFailure: true, timeoutSeconds: 60 }),
      runRemoteGit(session, repoRoot, ["diff", "--name-status", "--find-renames", "-M", head, "--"], { allowFailure: true, timeoutSeconds: 30 }),
      runRemoteGit(session, repoRoot, ["diff", "--cached", "--name-status", "--find-renames", "-M", head, "--"], { allowFailure: true, timeoutSeconds: 30 }),
      getRemoteUntrackedPaths(session, repoRoot),
    ]);

    const untrackedPatches = await Promise.all(untrackedPaths.map((repoRelPath) => getRemoteNoIndexPatch(session, repoRoot, repoRelPath)));
    const patchText = [
      mergePatchTexts(headTracked.stdout, stagedOnlyTracked.stdout),
      ...untrackedPatches.map((value) => value.trim()).filter(Boolean),
    ].filter(Boolean).join("\n");
    const untrackedNameStatus = untrackedPaths.map((repoRelPath) => `A\t${repoRelPath}`).join("\n");
    const nameStatus = [
      mergeNameStatusOutputs(headNameStatus.stdout, stagedNameStatus.stdout),
      untrackedNameStatus,
    ].filter(Boolean).join("\n");

    return { head, patchText, nameStatus };
  }

  const workspacePaths = await getRemoteWorkspacePaths(session, repoRoot);
  const workspacePatches = await Promise.all(workspacePaths.map((repoRelPath) => getRemoteNoIndexPatch(session, repoRoot, repoRelPath)));
  return {
    head: null,
    patchText: workspacePatches.map((value) => value.trim()).filter(Boolean).join("\n"),
    nameStatus: workspacePaths.map((repoRelPath) => `A\t${repoRelPath}`).join("\n"),
  };
}

export async function patchForPath(session: PiSshSession, repoRoot: string, repoRelPathInput: string): Promise<string> {
  const repoRelPath = validateRepoRelPath(repoRelPathInput);
  if (!repoRelPath) throw new Error("Invalid repo_rel_path");

  const head = await getRemoteHeadHash(session, repoRoot);
  if (head) {
    const [headPatch, stagedPatch] = await Promise.all([
      runRemoteGit(session, repoRoot, ["diff", "--no-color", "--find-renames", "-M", "--binary", head, "--", repoRelPath], { allowFailure: true, timeoutSeconds: 60 }),
      runRemoteGit(session, repoRoot, ["diff", "--cached", "--no-color", "--find-renames", "-M", "--binary", head, "--", repoRelPath], { allowFailure: true, timeoutSeconds: 60 }),
    ]);
    const merged = mergePatchTexts(headPatch.stdout, stagedPatch.stdout).trim();
    if (merged) return merged;
  }

  const untracked = await getRemoteUntrackedPaths(session, repoRoot, repoRelPath);
  if (untracked.includes(repoRelPath)) {
    return getRemoteNoIndexPatch(session, repoRoot, repoRelPath);
  }

  return "";
}

export async function applyReverse(
  session: PiSshSession,
  repoRoot: string,
  patchText: string,
  strategy: "auto" | "direct" | "3way" = "auto",
): Promise<RemoteApplyReverseResult> {
  const patch = patchText.replace(/\r\n/g, "\n").trim();
  if (!patch) {
    return { ok: true, strategyUsed: "direct", output: "" };
  }

  const tryApply = async (args: string[]): Promise<{ ok: boolean; output: string }> => {
    const checkArgs = [...args, "--check", "-"];
    const check = await runRemoteGit(session, repoRoot, checkArgs, {
      stdin: `${patch}\n`,
      allowFailure: true,
      timeoutSeconds: 60,
    });
    const checkOutput = [check.stderr, check.stdout].filter(Boolean).join("\n").trim();
    if (check.exitCode !== 0) {
      return { ok: false, output: checkOutput };
    }

    const apply = await runRemoteGit(session, repoRoot, [...args, "-"], {
      stdin: `${patch}\n`,
      allowFailure: true,
      timeoutSeconds: 60,
    });
    return {
      ok: apply.exitCode === 0,
      output: [apply.stderr, apply.stdout].filter(Boolean).join("\n").trim(),
    };
  };

  if (strategy === "auto" || strategy === "direct") {
    const direct = await tryApply(["apply", "-R"]);
    if (direct.ok) {
      return { ok: true, strategyUsed: "direct", output: direct.output };
    }
    if (strategy === "direct") {
      return { ok: false, strategyUsed: null, output: direct.output };
    }
  }

  const threeWay = await tryApply(["apply", "-R", "-3"]);
  if (threeWay.ok) {
    return { ok: true, strategyUsed: "3way", output: threeWay.output };
  }
  return { ok: false, strategyUsed: null, output: threeWay.output };
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildCompareAndWriteCommand(absolutePath: string, expectedHash: string): string {
  return [
    'if command -v python3 >/dev/null 2>&1; then PI_PY=python3',
    'elif command -v python >/dev/null 2>&1; then PI_PY=python',
    'else echo "pi-diff-review compare-and-write requires python3 or python on the remote host" >&2; exit 127',
    'fi',
    `"$PI_PY" -c ${shellQuote(REMOTE_COMPARE_AND_WRITE_SCRIPT)} ${shellQuote(absolutePath)} ${shellQuote(expectedHash)}`,
  ].join("\n");
}

function parseCompareAndWriteResult(stdout: string): RemoteCompareAndWriteResult {
  const raw = stdout.trim();
  if (!raw) {
    throw new Error("Remote compare-and-write returned no output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Remote compare-and-write returned invalid JSON: ${error.message}`
        : "Remote compare-and-write returned invalid JSON",
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Remote compare-and-write returned a non-object payload");
  }

  const value = parsed as Record<string, unknown>;
  return {
    ok: value.ok === true,
    conflict: value.conflict === true,
    missing: value.missing === true,
    symlink: value.symlink === true,
    hardlink: value.hardlink === true,
  };
}

export async function compareAndWriteRepoPath(
  session: PiSshSession,
  repoRoot: string,
  repoRelPathInput: string,
  baselineBytes: Buffer,
  nextBytes: Buffer,
): Promise<RemoteCompareAndWriteResult> {
  const repoRelPath = validateRepoRelPath(repoRelPathInput);
  if (!repoRelPath) throw new Error("Invalid repo_rel_path");
  const absolutePath = path.posix.join(repoRoot, repoRelPath);
  const result = await runRemoteCommand(session, buildCompareAndWriteCommand(absolutePath, hashBytes(baselineBytes)), {
    stdin: nextBytes,
    timeoutSeconds: 60,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Remote compare-and-write failed");
  }
  return parseCompareAndWriteResult(result.stdout);
}

function buildInspectRepoPathCommand(absolutePath: string): string {
  return [
    'if command -v python3 >/dev/null 2>&1; then PI_PY=python3',
    'elif command -v python >/dev/null 2>&1; then PI_PY=python',
    'else echo "pi-diff-review repo-path inspect requires python3 or python on the remote host" >&2; exit 127',
    'fi',
    `"$PI_PY" -c ${shellQuote(REMOTE_REPO_PATH_INSPECT_SCRIPT)} ${shellQuote(absolutePath)}`,
  ].join("\n");
}

function parseInspectRepoPathResult(stdout: string): { exists: boolean; isFile: boolean; isSymlink: boolean; linkCount: number | null; sizeBytes: number | null } {
  const raw = stdout.trim();
  if (!raw) {
    throw new Error("Remote repo-path inspect returned no output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Remote repo-path inspect returned invalid JSON: ${error.message}`
        : "Remote repo-path inspect returned invalid JSON",
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Remote repo-path inspect returned a non-object payload");
  }

  const value = parsed as Record<string, unknown>;
  return {
    exists: value.exists === true,
    isFile: value.isFile === true,
    isSymlink: value.isSymlink === true,
    linkCount: typeof value.linkCount === "number" ? value.linkCount : null,
    sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : null,
  };
}

export async function inspectRepoPathForStage(
  session: PiSshSession,
  repoRoot: string,
  repoRelPathInput: string,
): Promise<{ exists: boolean; isFile: boolean; isSymlink: boolean; linkCount: number | null; sizeBytes: number | null }> {
  const repoRelPath = validateRepoRelPath(repoRelPathInput);
  if (!repoRelPath) throw new Error("Invalid repo_rel_path");
  const absolutePath = path.posix.join(repoRoot, repoRelPath);
  const result = await session.execCapture(buildInspectRepoPathCommand(absolutePath), {
    timeoutSeconds: 30,
  });
  const stdout = normalizeText(result.stdout);
  const stderr = normalizeText(result.stderr);
  if (result.aborted || result.timedOut) {
    throwExecFailure("remote repo-path inspect failed", {
      stdout,
      stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
    });
  }
  if (result.exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || "Remote repo-path inspect failed");
  }
  return parseInspectRepoPathResult(stdout);
}

export async function statRepoPath(
  session: PiSshSession,
  repoRoot: string,
  repoRelPathInput: string,
): Promise<{ exists: boolean; isFile: boolean; sizeBytes?: number; mtimeMs?: number }> {
  const repoRelPath = validateRepoRelPath(repoRelPathInput);
  if (!repoRelPath) throw new Error("Invalid repo_rel_path");
  const stat = await session.stat(path.posix.join(repoRoot, repoRelPath));
  return {
    exists: stat.exists,
    isFile: stat.kind === "file",
    sizeBytes: typeof stat.size === "number" ? stat.size : undefined,
    mtimeMs: typeof stat.mtimeMs === "number" ? stat.mtimeMs : undefined,
  };
}

export async function readRepoPath(
  session: PiSshSession,
  repoRoot: string,
  repoRelPathInput: string,
  maxBytes: number,
): Promise<{ exists: boolean; bytes: Buffer; truncated: boolean }> {
  const repoRelPath = validateRepoRelPath(repoRelPathInput);
  if (!repoRelPath) throw new Error("Invalid repo_rel_path");
  const absolutePath = path.posix.join(repoRoot, repoRelPath);
  try {
    const bytes = await session.getRemoteContext().transport.readFile(absolutePath);
    if (bytes.length > maxBytes) {
      return { exists: true, bytes: bytes.subarray(0, maxBytes), truncated: true };
    }
    return { exists: true, bytes, truncated: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No such file or directory/i.test(message)) {
      return { exists: false, bytes: Buffer.alloc(0), truncated: false };
    }
    throw error;
  }
}

export async function writeRepoPath(
  session: PiSshSession,
  repoRoot: string,
  repoRelPathInput: string,
  bytes: Buffer,
): Promise<void> {
  const repoRelPath = validateRepoRelPath(repoRelPathInput);
  if (!repoRelPath) throw new Error("Invalid repo_rel_path");
  const absolutePath = path.posix.join(repoRoot, repoRelPath);
  const transport = session.getRemoteContext().transport;
  await transport.writeFile(absolutePath, bytes);
}
