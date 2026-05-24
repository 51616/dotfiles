import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface RemoteFffWorkerLaunchOptions {
  remote: string;
  port: number;
  remoteCwd: string;
  nodePath: string;
  nodeEntry: string;
  workerPath: string;
  cacheDir: string;
  idleTtlMs: number;
}

interface WorkerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): WorkerProcess;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): WorkerProcess;
}

export interface RemoteFffWorkerLauncher {
  launch(options: RemoteFffWorkerLaunchOptions): WorkerProcess;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

interface WorkerResponseOk {
  id: string;
  ok: true;
  result: unknown;
}

interface WorkerResponseError {
  id: string;
  ok: false;
  error: string;
}

type WorkerResponse = WorkerResponseOk | WorkerResponseError;

function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function trimTail(value: string, max = 12000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function isResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.ok !== "boolean") return false;
  if (input.ok === true) return Object.hasOwn(input, "result");
  return typeof input.error === "string";
}

export class SshRemoteFffWorkerLauncher implements RemoteFffWorkerLauncher {
  launch(options: RemoteFffWorkerLaunchOptions): ChildProcessWithoutNullStreams {
    const remoteCommand = [
      `cd -- ${shellQuote(options.remoteCwd)}`,
      [
        "exec env",
        `PI_REMOTE_FFF_NODE_ENTRY=${shellQuote(options.nodeEntry)}`,
        `PI_REMOTE_FFF_CACHE_DIR=${shellQuote(options.cacheDir)}`,
        `PI_REMOTE_FFF_IDLE_TTL_MS=${shellQuote(String(options.idleTtlMs))}`,
        shellQuote(options.nodePath),
        shellQuote(options.workerPath),
      ].join(" "),
    ].join(" && ");

    const args = [
      "-T",
      "-p",
      String(options.port),
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=600",
      "-o",
      "ControlPath=/tmp/pi-ssh-%C",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      options.remote,
      remoteCommand,
    ];

    return spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  }
}

export class RemoteFffWorkerClient {
  private readonly launcher: RemoteFffWorkerLauncher;
  private readonly launchOptions: RemoteFffWorkerLaunchOptions;
  private readonly requestTimeoutMs: number;
  private child: WorkerProcess | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private nextId = 0;
  private disposed = false;
  private readonly closedChildren = new WeakSet<WorkerProcess>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: RemoteFffWorkerLaunchOptions & {
    launcher?: RemoteFffWorkerLauncher;
    requestTimeoutMs?: number;
  }) {
    const { launcher, requestTimeoutMs, ...launchOptions } = options;
    this.launcher = launcher ?? new SshRemoteFffWorkerLauncher();
    this.launchOptions = launchOptions;
    this.requestTimeoutMs = requestTimeoutMs ?? 30000;
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  dispose(): void {
    this.disposed = true;
    this.stop(new Error("Remote FFF worker disposed"));
  }

  restart(): void {
    this.stop(new Error("Remote FFF worker restarting"));
    this.disposed = false;
  }

  async request<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) {
      throw new Error("Remote FFF worker client is disposed");
    }
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    const child = this.ensureStarted();
    const id = `rfff_${Date.now()}_${++this.nextId}`;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop(new Error(`Remote FFF worker request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        signal,
      };

      if (signal) {
        pending.abortHandler = () => {
          this.stop(new Error("aborted"));
        };
        signal.addEventListener("abort", pending.abortHandler, { once: true });
      }

      this.pending.set(id, pending);

      child.stdin.write(payload, (error) => {
        if (!error) return;
        this.finishRequest(id, undefined, error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private ensureStarted(): WorkerProcess {
    if (this.child && !this.child.killed) return this.child;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    const child = this.launcher.launch(this.launchOptions);
    this.child = child;

    child.stdout.on("data", (chunk: Buffer | string) => this.handleStdout(Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
      this.stderrTail = trimTail(`${this.stderrTail}${text}`);
    });
    child.on("error", (error) => this.handleClose(new Error(`Remote FFF worker spawn failed: ${error.message}`)));
    child.on("close", (code, signal) => {
      this.closedChildren.add(child);
      if (this.child !== child) return;
      const detail = this.stderrTail.trim();
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.handleClose(new Error(`Remote FFF worker closed with ${suffix}${detail ? `: ${detail}` : ""}`));
    });

    return child;
  }

  private handleStdout(text: string): void {
    this.stdoutBuffer += text;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.stop(new Error(`Remote FFF worker returned invalid JSON: ${message}; line=${line.slice(0, 500)}`));
        return;
      }
      if (!isResponse(parsed)) {
        this.stop(new Error(`Remote FFF worker returned invalid response shape: ${line.slice(0, 500)}`));
        return;
      }
      if (parsed.ok) {
        this.finishRequest(parsed.id, parsed.result, undefined);
      } else {
        this.finishRequest(parsed.id, undefined, new Error(parsed.error));
      }
    }
  }

  private finishRequest(id: string, value: unknown, error: Error | undefined): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
    if (error) {
      pending.reject(error);
      return;
    }
    pending.resolve(value);
  }

  private handleClose(error: Error): void {
    this.child = null;
    this.failPending(error);
  }

  private stop(error: Error): void {
    const child = this.child;
    this.child = null;
    this.failPending(error);
    if (!child || child.killed) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      // `child.killed` only means Node sent a signal; it does not prove the SSH
      // process exited. Check the close event instead before escalating.
      if (!this.closedChildren.has(child)) child.kill("SIGKILL");
    }, 1500).unref?.();
  }

  private failPending(error: Error): void {
    for (const id of Array.from(this.pending.keys())) {
      this.finishRequest(id, undefined, error);
    }
  }
}
