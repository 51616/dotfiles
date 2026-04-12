import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PI_DIFF_REVIEW_SSH_HELPER_PROTOCOL_VERSION, PI_DIFF_REVIEW_SSH_HELPER_PY } from "./helper-python.ts";

export type DiffReviewSshFlags = {
  ssh: string;
  port: number;
};

export type DiffReviewSshTarget = {
  remote: string;
  remotePath?: string;
  port: number;
};

export type HelperProbe = {
  protocol_version: number;
  helper_version: string;
  capabilities: string[];
  remote_home: string;
  remote_cwd: string;
};

export type HelperError = {
  code: string;
  message: string;
  details: Record<string, unknown>;
};

type HelperRequest = { id: string; method: string; params?: Record<string, unknown> };
type HelperResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string | null; ok: false; error: HelperError };

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'"`)}'`;
}

function parseSshFlag(raw: string): { remote: string; remotePath?: string } {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error("--ssh requires a value like user@host or user@host:/remote/path");

  const colonIndex = value.lastIndexOf(":");
  if (colonIndex === -1) return { remote: value };

  // Heuristic: treat the last colon as a path separator only when the suffix looks like a path.
  const suffix = value.slice(colonIndex + 1).trim();
  if (!(suffix.startsWith("/") || suffix === "~" || suffix.startsWith("~/"))) {
    return { remote: value };
  }

  const remote = value.slice(0, colonIndex).trim();
  const remotePath = suffix;
  if (!remote) throw new Error("Invalid --ssh value: missing remote host");
  if (!remotePath) throw new Error("Invalid --ssh value: empty remote path");
  return { remote, remotePath };
}

function parseSshPort(raw: unknown): number {
  const value = String(raw ?? "22").trim();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid SSH port: ${value}`);
  }
  return parsed;
}

export function readSshFlags(pi: ExtensionAPI): DiffReviewSshFlags | null {
  const getFlag = typeof (pi as unknown as { getFlag?: unknown }).getFlag === "function"
    ? (pi as unknown as { getFlag: (name: string) => unknown }).getFlag
    : null;

  if (!getFlag) return null;

  const ssh = String((getFlag("ssh") as string | undefined) ?? "").trim();
  if (!ssh) return null;
  const rawPort = (getFlag("p") as string | undefined) ?? (getFlag("ssh-port") as string | undefined);
  const port = parseSshPort(rawPort);
  return { ssh, port };
}

function helperBootstrapPython({ helperPy, remotePath }: { helperPy: string; remotePath?: string }): string {
  const helperB64 = Buffer.from(helperPy, "utf-8").toString("base64");
  const cwdB64 = Buffer.from(String(remotePath ?? ""), "utf-8").toString("base64");

  // Important: no single quotes in this string so we can wrap it in single quotes safely.
  // Use real newlines so we can use indentation safely (avoid one-line `if ...:` pitfalls).
  const code = [
    "import base64,os,os.path,sys",
    `target=base64.b64decode(\"${cwdB64}\").decode(\"utf-8\")`,
    "target=target.strip()",
    "if target:",
    "  os.chdir(os.path.expanduser(target))",
    `src=base64.b64decode(\"${helperB64}\").decode(\"utf-8\")`,
    "g={'__name__':'__main__'}",
    "exec(compile(src,\"<pi-diff-review-ssh-helper>\",\"exec\"),g)",
  ].join("\n");
  return code;
}

function buildSshArgs(port: number): string[] {
  return [
    "-p",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=600",
    "-o",
    "ControlPath=/tmp/pi-ssh-%C",
  ];
}

class LineDelimitedJsonRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout?: NodeJS.Timeout }>();
  private buffer = "";
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.on("exit", (code, signal) => {
      this.closed = true;
      const message = `helper process exited code=${code} signal=${signal ?? ""}`.trim();
      for (const entry of this.pending.values()) {
        entry.timeout && clearTimeout(entry.timeout);
        entry.reject(new Error(message));
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      const parsed = safeJsonParse(line) as HelperResponse | null;
      if (!parsed || typeof parsed !== "object") continue;
      const id = (parsed as { id?: unknown }).id;
      if (typeof id !== "string") continue;

      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      pending.timeout && clearTimeout(pending.timeout);

      if ((parsed as { ok?: unknown }).ok === true) {
        pending.resolve((parsed as { result: unknown }).result);
      } else {
        const err = (parsed as { error?: unknown }).error as HelperError | undefined;
        const msg = err?.message ? `remote helper error: ${err.message}` : "remote helper error";
        pending.reject(new Error(msg));
      }
    }
  }

  async request(method: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.closed) throw new Error("helper process is not running");

    const id = crypto.randomUUID();
    const req: HelperRequest = { id, method, params };

    return await new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 30_000;
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`remote helper request timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs)
        : undefined;

      const onAbort = () => {
        timeout && clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`remote helper request aborted: ${method}`));
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  dispose(): void {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
  }
}

export class DiffReviewSshHelperClient {
  private readonly rpc: LineDelimitedJsonRpc;
  readonly target: DiffReviewSshTarget;
  readonly probe: HelperProbe;

  private constructor({ rpc, target, probe }: { rpc: LineDelimitedJsonRpc; target: DiffReviewSshTarget; probe: HelperProbe }) {
    this.rpc = rpc;
    this.target = target;
    this.probe = probe;
  }

  static async startOverSsh(target: DiffReviewSshTarget): Promise<DiffReviewSshHelperClient> {
    const { remote, remotePath, port } = target;
    const bootstrap = helperBootstrapPython({ helperPy: PI_DIFF_REVIEW_SSH_HELPER_PY, remotePath });
    const remoteCmd = `python3 -u -c ${shellQuote(bootstrap)}`;

    const child = spawn("ssh", [...buildSshArgs(port), remote, remoteCmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Avoid spewing remote stderr into the local TUI by default.
    // Enable passthrough only for explicit debugging.
    const passthrough = process.env.PI_DIFF_REVIEW_SSH_HELPER_DEBUG === "1";
    child.stderr.on("data", (chunk) => {
      if (!passthrough) return;
      const text = normalizeNewlines(chunk.toString("utf-8"));
      if (text.trim()) process.stderr.write(text);
    });

    const rpc = new LineDelimitedJsonRpc(child);
    const probe = (await rpc.request("probe")) as HelperProbe;
    if (!probe || typeof probe.protocol_version !== "number") {
      rpc.dispose();
      throw new Error("remote helper probe failed: missing protocol_version");
    }
    if (probe.protocol_version !== PI_DIFF_REVIEW_SSH_HELPER_PROTOCOL_VERSION) {
      rpc.dispose();
      throw new Error(`remote helper protocol mismatch: expected ${PI_DIFF_REVIEW_SSH_HELPER_PROTOCOL_VERSION}, got ${probe.protocol_version}`);
    }

    return new DiffReviewSshHelperClient({ rpc, target, probe });
  }

  static async startLocalForTest(options: { cwd: string }): Promise<DiffReviewSshHelperClient> {
    const bootstrap = helperBootstrapPython({ helperPy: PI_DIFF_REVIEW_SSH_HELPER_PY, remotePath: options.cwd });
    const child = spawn("python3", ["-u", "-c", bootstrap], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      // Surface test failures.
      process.stderr.write(normalizeNewlines(chunk.toString("utf-8")));
    });

    const rpc = new LineDelimitedJsonRpc(child);
    const probe = (await rpc.request("probe")) as HelperProbe;
    if (probe.protocol_version !== PI_DIFF_REVIEW_SSH_HELPER_PROTOCOL_VERSION) {
      rpc.dispose();
      throw new Error(`helper protocol mismatch: expected ${PI_DIFF_REVIEW_SSH_HELPER_PROTOCOL_VERSION}, got ${probe.protocol_version}`);
    }

    return new DiffReviewSshHelperClient({
      rpc,
      target: { remote: "local", port: 0, remotePath: options.cwd },
      probe,
    });
  }

  async repoRoot(cwd?: string): Promise<string> {
    const res = (await this.rpc.request("repo.root", cwd ? { cwd } : {})) as { repo_root?: unknown };
    const repoRoot = typeof res?.repo_root === "string" ? res.repo_root.trim() : "";
    if (!repoRoot) throw new Error("remote helper repo.root returned empty repo_root");
    return repoRoot;
  }

  async diffWorkspace(options: { repoRoot: string; limits?: { max_patch_bytes_per_file?: number; max_total_patch_bytes?: number; max_files?: number } }): Promise<{ head: string | null; patchText: string; nameStatus: string; omittedPaths: Record<string, { reason: string; size_bytes?: number }> }> {
    const res = (await this.rpc.request("git.diff_workspace", {
      repo_root: options.repoRoot,
      limits: options.limits ?? {},
    })) as {
      head?: unknown;
      patch_text?: unknown;
      name_status?: unknown;
      omitted_paths?: unknown;
    };

    const head = typeof res?.head === "string" && res.head.trim() ? res.head.trim() : null;
    const patchText = typeof res?.patch_text === "string" ? res.patch_text : "";
    const nameStatus = typeof res?.name_status === "string" ? res.name_status : "";
    const omittedPaths = (res?.omitted_paths && typeof res.omitted_paths === "object") ? (res.omitted_paths as Record<string, { reason: string; size_bytes?: number }>) : {};

    return { head, patchText, nameStatus, omittedPaths };
  }

  async patchForPath(options: { repoRoot: string; repoRelPath: string }): Promise<string> {
    const res = (await this.rpc.request("git.patch_for_path", {
      repo_root: options.repoRoot,
      repo_rel_path: options.repoRelPath,
    })) as { patch_text?: unknown };
    return typeof res?.patch_text === "string" ? res.patch_text : "";
  }

  async applyReverse(options: { repoRoot: string; patchText: string; strategy?: "auto" | "direct" | "3way" }): Promise<{ ok: boolean; strategyUsed: "direct" | "3way" | null; output: string }> {
    const res = (await this.rpc.request("git.apply_reverse", {
      repo_root: options.repoRoot,
      patch_text: options.patchText,
      strategy: options.strategy ?? "auto",
    }, { timeoutMs: 60_000 })) as { ok?: unknown; strategy_used?: unknown; output?: unknown };

    return {
      ok: Boolean(res?.ok),
      strategyUsed: res?.strategy_used === "direct" || res?.strategy_used === "3way" ? res.strategy_used : null,
      output: typeof res?.output === "string" ? res.output : "",
    };
  }

  async stat(options: { repoRoot: string; repoRelPath: string }): Promise<{ exists: boolean; isFile: boolean; sizeBytes?: number; mtimeMs?: number }> {
    const res = (await this.rpc.request("file.stat", {
      repo_root: options.repoRoot,
      repo_rel_path: options.repoRelPath,
    })) as { exists?: unknown; is_file?: unknown; size_bytes?: unknown; mtime_ms?: unknown };

    return {
      exists: Boolean(res?.exists),
      isFile: Boolean(res?.is_file),
      sizeBytes: typeof res?.size_bytes === "number" ? res.size_bytes : undefined,
      mtimeMs: typeof res?.mtime_ms === "number" ? res.mtime_ms : undefined,
    };
  }

  async read(options: { repoRoot: string; repoRelPath: string; maxBytes: number }): Promise<{ exists: boolean; bytes: Buffer; truncated: boolean }> {
    const res = (await this.rpc.request("file.read", {
      repo_root: options.repoRoot,
      repo_rel_path: options.repoRelPath,
      max_bytes: options.maxBytes,
    })) as { exists?: unknown; bytes_base64?: unknown; truncated?: unknown };

    const b64 = typeof res?.bytes_base64 === "string" ? res.bytes_base64 : "";
    return {
      exists: Boolean(res?.exists),
      bytes: b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0),
      truncated: Boolean(res?.truncated),
    };
  }

  dispose(): void {
    this.rpc.dispose();
  }
}

let shared: { key: string; client: DiffReviewSshHelperClient } | null = null;

export async function getSharedSshHelperClient(pi: ExtensionAPI): Promise<DiffReviewSshHelperClient | null> {
  const flags = readSshFlags(pi);
  if (!flags) return null;

  const parsed = parseSshFlag(flags.ssh);
  const target: DiffReviewSshTarget = { remote: parsed.remote, remotePath: parsed.remotePath, port: flags.port };
  const key = `${target.remote}|${target.port}|${target.remotePath ?? ""}`;

  if (shared && shared.key === key) return shared.client;

  shared?.client.dispose();
  const client = await DiffReviewSshHelperClient.startOverSsh(target);
  shared = { key, client };
  return client;
}

export function disposeSharedSshHelperClient(): void {
  shared?.client.dispose();
  shared = null;
}

export function makeSshScopeKey(target: DiffReviewSshTarget, repoRoot: string): string {
  const remote = target.port && target.port !== 22 ? `${target.remote}:${target.port}` : target.remote;
  return `ssh:${remote}:${repoRoot}`;
}

export function localHome(): string {
  return os.homedir();
}

export function localCwd(): string {
  return process.cwd();
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
