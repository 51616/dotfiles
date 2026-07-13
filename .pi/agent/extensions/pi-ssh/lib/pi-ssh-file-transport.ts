import type { TruncationResult } from "@mariozechner/pi-coding-agent";
import type {
  PiSshWorkspaceEdit,
  PiSshWorkspaceEditResult,
  PiSshWorkspaceReadOptions,
  PiSshWorkspaceReadResult,
} from "./pi-ssh-session-runtime.ts";
import {
  PiSshFileWorkerClient,
  type PiSshFileWorkerRequestOptions,
  type PiSshFileWorkerResponseHeader,
} from "./pi-ssh-file-protocol.ts";

interface FileWorkerRequester {
  request(
    operation: string,
    fields?: Record<string, unknown>,
    payload?: Buffer,
    options?: PiSshFileWorkerRequestOptions,
  ): ReturnType<PiSshFileWorkerClient["request"]>;
  invalidate(error: Error): void;
  dispose(): Promise<void>;
}

function protocolError(message: string): Error {
  return new Error(`Invalid SSH file worker response: ${message}`);
}

function expectInteger(
  header: PiSshFileWorkerResponseHeader,
  name: string,
  minimum = 0,
): number {
  const value = header[name];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw protocolError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function expectOptionalInteger(
  header: PiSshFileWorkerResponseHeader,
  name: string,
  minimum = 0,
): number | undefined {
  const value = header[name];
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw protocolError(`${name} must be null or an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function expectBoolean(header: PiSshFileWorkerResponseHeader, name: string): boolean {
  const value = header[name];
  if (typeof value !== "boolean") {
    throw protocolError(`${name} must be boolean`);
  }
  return value;
}

function expectString(header: PiSshFileWorkerResponseHeader, name: string): string {
  const value = header[name];
  if (typeof value !== "string") {
    throw protocolError(`${name} must be a string`);
  }
  return value;
}

function parseTruncation(header: PiSshFileWorkerResponseHeader): TruncationResult {
  const raw = header.truncation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw protocolError("truncation must be an object");
  }
  const value = raw as Record<string, unknown>;
  const numberField = (name: string, minimum = 0): number => {
    const field = value[name];
    if (!Number.isSafeInteger(field) || (field as number) < minimum) {
      throw protocolError(`truncation.${name} must be an integer greater than or equal to ${minimum}`);
    }
    return field as number;
  };
  const booleanField = (name: string): boolean => {
    const field = value[name];
    if (typeof field !== "boolean") {
      throw protocolError(`truncation.${name} must be boolean`);
    }
    return field;
  };
  const truncatedBy = value.truncatedBy;
  if (truncatedBy !== null && truncatedBy !== "lines" && truncatedBy !== "bytes") {
    throw protocolError("truncation.truncatedBy must be lines, bytes, or null");
  }
  const result: TruncationResult = {
    content: "",
    truncated: booleanField("truncated"),
    truncatedBy,
    totalLines: numberField("totalLines", 1),
    totalBytes: numberField("totalBytes"),
    outputLines: numberField("outputLines"),
    outputBytes: numberField("outputBytes"),
    lastLinePartial: booleanField("lastLinePartial"),
    firstLineExceedsLimit: booleanField("firstLineExceedsLimit"),
    maxLines: numberField("maxLines", 1),
    maxBytes: numberField("maxBytes", 1),
  };
  if (result.outputLines > result.totalLines || result.outputBytes > result.totalBytes) {
    throw protocolError("truncation output counts must not exceed total counts");
  }
  if (result.truncated !== (result.truncatedBy !== null)) {
    throw protocolError("truncation.truncated and truncation.truncatedBy are inconsistent");
  }
  if (result.firstLineExceedsLimit && (result.outputLines !== 0 || result.outputBytes !== 0)) {
    throw protocolError("firstLineExceedsLimit requires zero output lines and bytes");
  }
  return result;
}

export class PiSshRemoteFileTransport {
  private readonly worker: FileWorkerRequester;

  constructor(worker: FileWorkerRequester) {
    this.worker = worker;
  }

  async dispose(): Promise<void> {
    await this.worker.dispose();
  }

  async readFile(remotePath: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.worker.request("read_file", { path: remotePath }, Buffer.alloc(0), { signal });
    return this.validateResponse(() => {
      if (response.header.fileKind !== "binary") {
        throw protocolError(`read_file fileKind must be binary, got ${String(response.header.fileKind)}`);
      }
      const sourceBytes = expectInteger(response.header, "sourceBytes");
      if (sourceBytes !== response.payload.length) {
        throw protocolError(`read_file sourceBytes ${sourceBytes} does not match payload ${response.payload.length}`);
      }
      return response.payload;
    });
  }

  async writeFile(remotePath: string, content: Buffer, signal?: AbortSignal): Promise<void> {
    const response = await this.worker.request("write_file", { path: remotePath }, content, { signal });
    this.validateResponse(() => {
      if (response.payload.length !== 0) {
        throw protocolError("write_file response must not contain a payload");
      }
      const writtenBytes = expectInteger(response.header, "writtenBytes");
      if (writtenBytes !== content.length) {
        throw protocolError(`write_file writtenBytes ${writtenBytes} does not match request payload ${content.length}`);
      }
    });
  }

  async readWorkspaceFile(
    remotePath: string,
    options: PiSshWorkspaceReadOptions,
    signal?: AbortSignal,
  ): Promise<PiSshWorkspaceReadResult> {
    const response = await this.worker.request(
      "read_workspace",
      {
        path: remotePath,
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
      },
      Buffer.alloc(0),
      { signal },
    );
    return this.validateResponse(() => {
      const { header, payload } = response;
      const fileKind = header.fileKind;
      if (fileKind === "image") {
        const mimeType = expectString(header, "mimeType");
        if (!(["image/jpeg", "image/png", "image/gif", "image/webp"] as const).includes(
          mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        )) {
          throw protocolError(`unsupported image MIME type ${mimeType}`);
        }
        const sourceBytes = expectInteger(header, "sourceBytes");
        if (sourceBytes !== payload.length) {
          throw protocolError(`image sourceBytes ${sourceBytes} does not match payload ${payload.length}`);
        }
        return {
          kind: "image" as const,
          content: payload,
          sourceBytes,
          mimeType: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        };
      }
      if (fileKind !== "text") {
        throw protocolError(`fileKind must be text or image, got ${String(fileKind)}`);
      }
      const sourceBytes = expectInteger(header, "sourceBytes");
      const totalFileLines = expectInteger(header, "totalFileLines", 1);
      const startLineDisplay = expectInteger(header, "startLineDisplay", 1);
      const expectedStartLine = options.offset ?? 1;
      if (startLineDisplay !== expectedStartLine || startLineDisplay > totalFileLines) {
        throw protocolError(`startLineDisplay ${startLineDisplay} does not match requested offset ${expectedStartLine}`);
      }
      const expectedSelectedLines = options.limit === undefined
        ? totalFileLines - startLineDisplay + 1
        : Math.min(options.limit, totalFileLines - startLineDisplay + 1);
      const userLimitedLines = expectOptionalInteger(header, "userLimitedLines", 1) ?? null;
      const expectedUserLimitedLines = options.limit === undefined ? null : expectedSelectedLines;
      if (userLimitedLines !== expectedUserLimitedLines) {
        throw protocolError(
          `userLimitedLines ${String(userLimitedLines)} does not match request selection ${String(expectedUserLimitedLines)}`,
        );
      }
      const hasMoreAfterUserLimit = expectBoolean(header, "hasMoreAfterUserLimit");
      const expectedHasMore = options.limit !== undefined
        && startLineDisplay - 1 + expectedSelectedLines < totalFileLines;
      if (hasMoreAfterUserLimit !== expectedHasMore) {
        throw protocolError("hasMoreAfterUserLimit is inconsistent with the requested range");
      }

      const truncation = parseTruncation(header);
      if (truncation.lastLinePartial) {
        throw protocolError("lastLinePartial must be false for whole-line head truncation");
      }
      if (truncation.totalLines !== expectedSelectedLines) {
        throw protocolError(
          `truncation.totalLines ${truncation.totalLines} does not match selected lines ${expectedSelectedLines}`,
        );
      }
      if (truncation.outputBytes !== payload.length) {
        throw protocolError(`truncation.outputBytes ${truncation.outputBytes} does not match payload ${payload.length}`);
      }
      if (truncation.maxLines !== options.maxLines || truncation.maxBytes !== options.maxBytes) {
        throw protocolError("truncation limits do not match the request");
      }
      const expectedTruncated = truncation.totalLines > options.maxLines || truncation.totalBytes > options.maxBytes;
      if (truncation.truncated !== expectedTruncated) {
        throw protocolError("truncation status is inconsistent with total counts and requested limits");
      }
      if (truncation.outputLines > options.maxLines || truncation.outputBytes > options.maxBytes) {
        throw protocolError("truncation output exceeds requested limits");
      }
      if (truncation.truncatedBy === "lines") {
        if (truncation.totalLines <= options.maxLines) {
          throw protocolError("line-truncated output requires totalLines above maxLines");
        }
        if (truncation.outputLines !== options.maxLines) {
          throw protocolError("line-truncated output must contain exactly maxLines lines");
        }
      }
      if (truncation.truncatedBy === "bytes" && truncation.totalBytes <= options.maxBytes) {
        throw protocolError("byte-truncated output requires totalBytes above maxBytes");
      }
      if (truncation.outputLines === truncation.totalLines
        && truncation.outputBytes !== truncation.totalBytes) {
        throw protocolError("complete-line output cannot hide bytes when every selected line is visible");
      }

      const content = payload.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(payload)) {
        throw protocolError("text payload must be valid UTF-8");
      }
      const payloadLines = truncation.firstLineExceedsLimit ? 0 : content.split("\n").length;
      if (truncation.outputLines !== payloadLines) {
        throw protocolError(
          `truncation.outputLines ${truncation.outputLines} does not match payload lines ${payloadLines}`,
        );
      }
      if (!truncation.truncated
        && (truncation.totalBytes !== payload.length || truncation.totalLines !== truncation.outputLines)) {
        throw protocolError("untruncated total counts must match the complete payload");
      }
      const firstLineBytes = expectInteger(header, "firstLineBytes");
      if (truncation.firstLineExceedsLimit) {
        if (firstLineBytes <= options.maxBytes) {
          throw protocolError("firstLineExceedsLimit requires firstLineBytes above maxBytes");
        }
      } else if (firstLineBytes !== Buffer.byteLength(content.split("\n", 1)[0], "utf8")) {
        throw protocolError("firstLineBytes does not match the payload's first line");
      }
      return {
        kind: "text" as const,
        content,
        sourceBytes,
        totalFileLines,
        startLineDisplay,
        userLimitedLines,
        hasMoreAfterUserLimit,
        firstLineBytes,
        truncation,
      };
    });
  }

  async editWorkspaceFile(
    remotePath: string,
    displayPath: string,
    edits: PiSshWorkspaceEdit[],
    signal?: AbortSignal,
  ): Promise<PiSshWorkspaceEditResult> {
    const response = await this.worker.request(
      "edit_workspace",
      { path: remotePath, displayPath, edits },
      Buffer.alloc(0),
      { signal },
    );
    return this.validateResponse(() => {
      if (response.payload.length !== 0) {
        throw protocolError("edit_workspace response must not contain a payload");
      }
      const firstChangedLine = expectOptionalInteger(response.header, "firstChangedLine", 1);
      if (firstChangedLine === undefined) {
        throw protocolError("edit_workspace firstChangedLine must be a positive integer");
      }
      return {
        diff: expectString(response.header, "diff"),
        firstChangedLine,
        diffTruncated: expectBoolean(response.header, "diffTruncated"),
        sourceBytes: expectInteger(response.header, "sourceBytes"),
        writtenBytes: expectInteger(response.header, "writtenBytes"),
      };
    });
  }

  private validateResponse<T>(validate: () => T): T {
    try {
      return validate();
    } catch (error) {
      const protocolFailure = error instanceof Error ? error : protocolError(String(error));
      this.worker.invalidate(protocolFailure);
      throw protocolFailure;
    }
  }
}
