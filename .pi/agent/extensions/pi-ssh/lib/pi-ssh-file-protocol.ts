import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// @lat: [[extensions#Persistent SSH file worker]]
export const PI_SSH_FILE_PROTOCOL_VERSION = 1;
export const DEFAULT_FILE_WORKER_MAX_HEADER_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FILE_WORKER_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_IGNORED_RESPONSE_IDS = 1_024;
const MAX_STDERR_LINE_CHARACTERS = 2_000;
const MAX_STDERR_LINES = 8;
const REQUIRED_FILE_WORKER_CAPABILITIES = ["edit_workspace", "read_file", "read_workspace", "write_file"] as const;

type DebugDetails = Record<string, unknown>;

export interface PiSshFileWorkerResponseHeader {
  version: number;
  kind: "response";
  id: number;
  ok: boolean;
  payloadLength: number;
  error?: {
    code?: string;
    message?: string;
  };
  [key: string]: unknown;
}

interface PiSshFileWorkerHelloHeader {
  version: number;
  kind: "hello";
  id: 0;
  ok: boolean;
  payloadLength: 0;
  capabilities?: unknown;
}

interface PendingRequest {
  operation: string;
  resolve: (value: PiSshFileWorkerResponse) => void;
  reject: (error: Error) => void;
  writeState: "queued" | "writing" | "sent";
  timeoutHandle?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface StartWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface PiSshFileWorkerResponse {
  header: PiSshFileWorkerResponseHeader;
  payload: Buffer;
}

export interface PiSshFileWorkerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PiSshFileWorkerClientOptions {
  launcher: () => ChildProcessWithoutNullStreams;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxHeaderBytes?: number;
  maxPayloadBytes?: number;
  onDebug?: (event: string, details: DebugDetails) => void;
}

export class PiSshFileWorkerError extends Error {
  readonly code: string | null;
  readonly details: PiSshFileWorkerResponseHeader | null;

  constructor(message: string, options: { code?: string | null; details?: PiSshFileWorkerResponseHeader | null } = {}) {
    super(message);
    this.name = "PiSshFileWorkerError";
    this.code = options.code ?? null;
    this.details = options.details ?? null;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

class BufferQueue {
  private chunks: Buffer[] = [];
  private headIndex = 0;
  private firstChunkOffset = 0;
  private availableBytes = 0;

  get length(): number {
    return this.availableBytes;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.availableBytes += chunk.length;
  }

  clear(): void {
    this.chunks = [];
    this.headIndex = 0;
    this.firstChunkOffset = 0;
    this.availableBytes = 0;
  }

  read(length: number): Buffer | null {
    if (length < 0 || this.availableBytes < length) return null;
    if (length === 0) return Buffer.alloc(0);
    const first = this.chunks[this.headIndex];
    const firstAvailable = first.length - this.firstChunkOffset;
    if (length <= firstAvailable) {
      const output = first.subarray(this.firstChunkOffset, this.firstChunkOffset + length);
      this.firstChunkOffset += length;
      this.availableBytes -= length;
      if (this.firstChunkOffset === first.length) {
        this.advanceChunk();
      }
      return output;
    }

    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.headIndex];
      const take = Math.min(length - written, chunk.length - this.firstChunkOffset);
      chunk.copy(output, written, this.firstChunkOffset, this.firstChunkOffset + take);
      written += take;
      this.firstChunkOffset += take;
      this.availableBytes -= take;
      if (this.firstChunkOffset === chunk.length) {
        this.advanceChunk();
      }
    }
    return output;
  }

  private advanceChunk(): void {
    this.headIndex += 1;
    this.firstChunkOffset = 0;
    if (this.availableBytes === 0) {
      this.chunks = [];
      this.headIndex = 0;
    } else if (this.headIndex >= 1_024 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}

function parseObjectHeader(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SSH file worker returned invalid JSON header: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SSH file worker returned a non-object header");
  }
  return parsed as Record<string, unknown>;
}

function readBoundedLength(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`SSH file worker returned invalid ${name}`);
  }
  const length = value as number;
  if (length > maximum) {
    throw new Error(`SSH file worker ${name} ${length} exceeds limit ${maximum}`);
  }
  return length;
}

function responseError(header: PiSshFileWorkerResponseHeader, operation: string): PiSshFileWorkerError {
  const code = typeof header.error?.code === "string" ? header.error.code : null;
  const message = typeof header.error?.message === "string" && header.error.message.trim()
    ? header.error.message
    : `Remote SSH file operation failed: ${operation}`;
  return new PiSshFileWorkerError(message, { code, details: header });
}

export function encodePiSshFileFrame(
  header: Record<string, unknown>,
  payload: Buffer,
  limits: { maxHeaderBytes: number; maxPayloadBytes: number },
): Buffer {
  if (payload.length > limits.maxPayloadBytes) {
    throw new Error(`SSH file worker request payload ${payload.length} exceeds limit ${limits.maxPayloadBytes}`);
  }
  const headerBytes = Buffer.from(JSON.stringify({ ...header, payloadLength: payload.length }), "utf8");
  if (headerBytes.length > limits.maxHeaderBytes) {
    throw new Error(`SSH file worker request header ${headerBytes.length} exceeds limit ${limits.maxHeaderBytes}`);
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([prefix, headerBytes, payload]);
}

export class PiSshFileWorkerClient {
  private readonly options: Required<Pick<
    PiSshFileWorkerClientOptions,
    "startupTimeoutMs" | "requestTimeoutMs" | "maxHeaderBytes" | "maxPayloadBytes"
  >> & Pick<PiSshFileWorkerClientOptions, "launcher" | "onDebug">;
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private startWaiter: StartWaiter | null = null;
  private inputQueue = new BufferQueue();
  private frameHeaderLength: number | null = null;
  private frameHeader: Record<string, unknown> | null = null;
  private framePayloadLength = 0;
  private stderrDecoder = new StringDecoder("utf8");
  private stderrBuffer = "";
  private stderrTail: string[] = [];
  private pending = new Map<number, PendingRequest>();
  private ignoredResponseIds = new Set<number>();
  private nextRequestId = 1;
  private writeTail: Promise<void> = Promise.resolve();
  private writingRequestId: number | null = null;
  private disposed = false;

  constructor(options: PiSshFileWorkerClientOptions) {
    const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_FILE_WORKER_MAX_HEADER_BYTES;
    const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_FILE_WORKER_MAX_PAYLOAD_BYTES;
    assertPositiveInteger(maxHeaderBytes, "maxHeaderBytes");
    assertPositiveInteger(maxPayloadBytes, "maxPayloadBytes");
    this.options = {
      launcher: options.launcher,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxHeaderBytes,
      maxPayloadBytes,
      onDebug: options.onDebug,
    };
  }

  async request(
    operation: string,
    fields: Record<string, unknown> = {},
    payload: Buffer = Buffer.alloc(0),
    requestOptions: PiSshFileWorkerRequestOptions = {},
  ): Promise<PiSshFileWorkerResponse> {
    if (!operation.trim()) {
      throw new Error("SSH file worker operation must not be empty");
    }
    if (requestOptions.signal?.aborted) {
      throw new Error("aborted");
    }

    // Encode before launching so invalid/oversized requests fail without touching SSH.
    const id = this.nextRequestId++;
    const frame = encodePiSshFileFrame(
      {
        ...fields,
        version: PI_SSH_FILE_PROTOCOL_VERSION,
        kind: "request",
        id,
        operation,
      },
      payload,
      this.options,
    );

    await this.waitForStartup(requestOptions.signal);
    if (requestOptions.signal?.aborted) {
      throw new Error("aborted");
    }
    const child = this.child;
    if (!child || child.killed) {
      throw new Error("SSH file worker is not running");
    }

    return new Promise<PiSshFileWorkerResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        operation,
        resolve,
        reject,
        writeState: "queued",
        signal: requestOptions.signal,
      };
      const timeoutMs = requestOptions.timeoutMs ?? this.options.requestTimeoutMs;
      if (timeoutMs > 0) {
        pending.timeoutHandle = setTimeout(() => {
          this.cancelRequest(
            child,
            id,
            new Error(`SSH file worker request timed out after ${timeoutMs}ms: ${operation}`),
            "timeout",
          );
        }, timeoutMs);
      }
      if (requestOptions.signal) {
        pending.abortHandler = () => this.cancelRequest(child, id, new Error("aborted"), "abort");
        requestOptions.signal.addEventListener("abort", pending.abortHandler, { once: true });
      }
      this.pending.set(id, pending);
      this.debug("request.begin", { id, operation, headerBytes: frame.readUInt32BE(0), payloadBytes: payload.length });

      const queuedWrite = this.writeTail.then(
        () => this.writeRequestFrame(child, id, frame),
        () => this.writeRequestFrame(child, id, frame),
      );
      this.writeTail = queuedWrite.catch((error) => {
        this.handleProcessFailure(child, error instanceof Error ? error : new Error(String(error)), true);
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.resetFrameParser();
    this.ignoredResponseIds.clear();
    this.rejectStart(new Error("SSH file worker disposed"));
    this.rejectAll(new Error("SSH file worker disposed"));
    if (child) {
      this.terminateChild(child);
    }
  }

  invalidate(error: Error): void {
    const child = this.child;
    if (child) {
      this.handleProcessFailure(child, error, true);
      return;
    }
    this.rejectAll(error);
  }

  private waitForStartup(signal?: AbortSignal): Promise<void> {
    const startup = this.ensureStarted();
    if (!signal) return startup;
    if (signal.aborted) {
      void startup.catch(() => {});
      return Promise.reject(new Error("aborted"));
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      startup.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("SSH file worker is disposed");
    }
    if (this.child && !this.child.killed && !this.startPromise) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const child = this.options.launcher();
    this.child = child;
    this.resetFrameParser();
    this.ignoredResponseIds.clear();
    this.stderrDecoder = new StringDecoder("utf8");
    this.stderrBuffer = "";
    this.stderrTail = [];
    this.debug("worker.start", { pid: child.pid ?? null });

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(child, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(child, chunk));
    child.stdin.on("error", (error) => this.handleProcessFailure(child, error, true));
    child.stdout.on("error", (error) => this.handleProcessFailure(child, error, true));
    child.stderr.on("error", (error) => this.handleProcessFailure(child, error, true));
    child.on("error", (error) => this.handleProcessFailure(child, error, true));
    child.on("close", (code, signal) => {
      this.handleProcessFailure(
        child,
        new Error(`SSH file worker closed unexpectedly (exit=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });

    this.startPromise = new Promise<void>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.handleProcessFailure(
          child,
          new Error(`SSH file worker startup timed out after ${this.options.startupTimeoutMs}ms`),
          true,
        );
      }, this.options.startupTimeoutMs);
      this.startWaiter = { resolve, reject, timeoutHandle };
    });

    try {
      await this.startPromise;
    } finally {
      if (this.child === child) {
        this.startPromise = null;
      }
    }
  }

  private handleStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    this.inputQueue.push(chunk);
    try {
      this.parseFrames();
    } catch (error) {
      this.handleProcessFailure(child, error instanceof Error ? error : new Error(String(error)), true);
    }
  }

  private parseFrames(): void {
    while (true) {
      if (this.frameHeaderLength === null) {
        const prefix = this.inputQueue.read(4);
        if (!prefix) return;
        const headerLength = prefix.readUInt32BE(0);
        if (headerLength < 2 || headerLength > this.options.maxHeaderBytes) {
          throw new Error(
            `SSH file worker response header length ${headerLength} exceeds limit ${this.options.maxHeaderBytes}`,
          );
        }
        this.frameHeaderLength = headerLength;
      }

      if (this.frameHeader === null) {
        const headerBytes = this.inputQueue.read(this.frameHeaderLength);
        if (!headerBytes) return;
        const header = parseObjectHeader(headerBytes);
        this.framePayloadLength = readBoundedLength(
          header.payloadLength,
          "response payload length",
          this.options.maxPayloadBytes,
        );
        this.frameHeader = header;
      }

      const payload = this.inputQueue.read(this.framePayloadLength);
      if (!payload) return;
      const header = this.frameHeader;
      this.frameHeaderLength = null;
      this.frameHeader = null;
      this.framePayloadLength = 0;
      this.handleFrame(header, payload);
    }
  }

  private resetFrameParser(): void {
    this.inputQueue.clear();
    this.frameHeaderLength = null;
    this.frameHeader = null;
    this.framePayloadLength = 0;
  }

  private handleFrame(rawHeader: Record<string, unknown>, payload: Buffer): void {
    if (rawHeader.kind === "hello") {
      this.handleHello(rawHeader, payload);
      return;
    }
    if (rawHeader.kind !== "response") {
      throw new Error(`SSH file worker returned unknown frame kind: ${String(rawHeader.kind)}`);
    }
    if (rawHeader.version !== PI_SSH_FILE_PROTOCOL_VERSION) {
      throw new Error(
        `SSH file worker protocol version mismatch: expected ${PI_SSH_FILE_PROTOCOL_VERSION}, got ${String(rawHeader.version)}`,
      );
    }
    if (!Number.isSafeInteger(rawHeader.id) || (rawHeader.id as number) < 1) {
      throw new Error("SSH file worker returned invalid response id");
    }
    if (typeof rawHeader.ok !== "boolean") {
      throw new Error("SSH file worker response is missing boolean ok status");
    }

    const id = rawHeader.id as number;
    const pending = this.pending.get(id);
    if (!pending) {
      if (this.ignoredResponseIds.delete(id)) {
        this.debug("response.ignored", { id, reason: "canceled-or-timed-out" });
        return;
      }
      throw new Error(`SSH file worker returned unsolicited or duplicate response id ${id}`);
    }
    const header = rawHeader as PiSshFileWorkerResponseHeader;
    if (!header.ok && payload.length !== 0) {
      throw new Error(`SSH file worker error response ${id} must not contain a payload`);
    }
    this.pending.delete(id);
    this.cleanupPending(pending);
    this.debug("request.end", {
      id,
      operation: pending.operation,
      ok: header.ok,
      payloadBytes: payload.length,
    });
    if (!header.ok) {
      pending.reject(responseError(header, pending.operation));
      return;
    }
    pending.resolve({ header, payload });
  }

  private handleHello(rawHeader: Record<string, unknown>, payload: Buffer): void {
    if (!this.startWaiter) {
      throw new Error("SSH file worker sent an unexpected hello frame");
    }
    if (payload.length !== 0) {
      throw new Error("SSH file worker hello frame must not contain a payload");
    }
    const header = rawHeader as unknown as PiSshFileWorkerHelloHeader;
    if (header.version !== PI_SSH_FILE_PROTOCOL_VERSION) {
      throw new Error(
        `SSH file worker protocol version mismatch: expected ${PI_SSH_FILE_PROTOCOL_VERSION}, got ${String(header.version)}`,
      );
    }
    if (header.id !== 0 || header.ok !== true) {
      throw new Error("SSH file worker returned an invalid hello frame");
    }
    if (!Array.isArray(header.capabilities) || !header.capabilities.every((value) => typeof value === "string")) {
      throw new Error("SSH file worker hello frame must contain string capabilities");
    }
    const missingCapabilities = REQUIRED_FILE_WORKER_CAPABILITIES.filter(
      (capability) => !(header.capabilities as string[]).includes(capability),
    );
    if (missingCapabilities.length > 0) {
      throw new Error(`SSH file worker is missing required capabilities: ${missingCapabilities.join(", ")}`);
    }
    const waiter = this.startWaiter;
    this.startWaiter = null;
    clearTimeout(waiter.timeoutHandle);
    this.debug("worker.ready", { capabilities: header.capabilities ?? [] });
    waiter.resolve();
  }

  private handleStderr(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    this.stderrBuffer += this.stderrDecoder.write(chunk);
    while (true) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line) {
        this.rememberStderr(line);
        this.debug("worker.stderr", { line: line.slice(0, MAX_STDERR_LINE_CHARACTERS) });
      }
    }
    if (this.stderrBuffer.length > MAX_STDERR_LINE_CHARACTERS) {
      this.stderrBuffer = this.stderrBuffer.slice(-MAX_STDERR_LINE_CHARACTERS);
    }
  }

  private rememberStderr(line: string): void {
    this.stderrTail.push(line.slice(0, MAX_STDERR_LINE_CHARACTERS));
    if (this.stderrTail.length > MAX_STDERR_LINES) this.stderrTail.shift();
  }

  private withStderrContext(error: Error): Error {
    const partialLine = this.stderrBuffer.replace(/\r$/, "").trim();
    const lines = partialLine ? [...this.stderrTail, partialLine.slice(0, 2_000)] : this.stderrTail;
    if (lines.length === 0) return error;
    return new Error(`${error.message}\nRemote worker stderr:\n${lines.join("\n")}`, { cause: error });
  }

  private handleProcessFailure(child: ChildProcessWithoutNullStreams, error: Error, kill = false): void {
    if (this.child !== child) return;
    const decoderTail = this.stderrDecoder.end();
    if (decoderTail) {
      this.stderrBuffer = `${this.stderrBuffer}${decoderTail}`.slice(-MAX_STDERR_LINE_CHARACTERS);
    }
    const contextualError = this.withStderrContext(error);
    this.child = null;
    this.startPromise = null;
    this.resetFrameParser();
    this.ignoredResponseIds.clear();
    this.writingRequestId = null;
    this.writeTail = Promise.resolve();
    this.debug("worker.failed", { message: contextualError.message });
    this.rejectStart(contextualError);
    this.rejectAll(contextualError);
    if (kill) this.terminateChild(child);
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1_000);
    forceKill.unref();
    child.once("close", () => clearTimeout(forceKill));
  }

  private rejectStart(error: Error): void {
    const waiter = this.startWaiter;
    if (!waiter) return;
    this.startWaiter = null;
    clearTimeout(waiter.timeoutHandle);
    waiter.reject(error);
  }

  private cancelRequest(
    child: ChildProcessWithoutNullStreams,
    id: number,
    error: Error,
    reason: "abort" | "timeout",
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const writeState = pending.writeState;
    this.debug("request.canceled", { id, operation: pending.operation, writeState, message: error.message });
    if (writeState === "writing") {
      this.handleProcessFailure(
        child,
        new Error(`${error.message}; SSH file worker channel reset during a partial request write`, { cause: error }),
        true,
      );
      return;
    }
    if (reason === "timeout" && writeState === "sent") {
      this.handleProcessFailure(child, error, true);
      return;
    }
    this.rejectPending(id, error, writeState === "sent");
  }

  private rememberIgnoredResponse(id: number): void {
    this.ignoredResponseIds.add(id);
    if (this.ignoredResponseIds.size > MAX_IGNORED_RESPONSE_IDS) {
      const oldest = this.ignoredResponseIds.values().next().value as number | undefined;
      if (oldest !== undefined) this.ignoredResponseIds.delete(oldest);
    }
  }

  private rejectPending(id: number, error: Error, ignoreLateResponse = false): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (ignoreLateResponse) this.rememberIgnoredResponse(id);
    this.cleanupPending(pending);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of Array.from(this.pending.keys())) {
      this.rejectPending(id, error);
    }
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
  }

  private async writeRequestFrame(
    child: ChildProcessWithoutNullStreams,
    id: number,
    frame: Buffer,
  ): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) {
      this.debug("request.write.skipped", { id, reason: "no-pending-request" });
      return;
    }
    pending.writeState = "writing";
    this.writingRequestId = id;
    try {
      await this.writeFrame(child, frame);
      const stillPending = this.pending.get(id);
      if (stillPending) stillPending.writeState = "sent";
    } finally {
      if (this.writingRequestId === id) this.writingRequestId = null;
    }
  }

  private writeFrame(child: ChildProcessWithoutNullStreams, frame: Buffer): Promise<void> {
    if (this.child !== child || child.killed || child.stdin.destroyed) {
      return Promise.reject(new Error("SSH file worker closed before request write"));
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(frame, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private debug(event: string, details: DebugDetails): void {
    this.options.onDebug?.(event, details);
  }
}
