import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  withFileMutationQueue,
  type EditToolInput,
  type ReadToolInput,
  type WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import type { PiSshSession, PiSshWorkspaceTextReadResult } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

// @lat: [[extensions#Persistent SSH file worker]]
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

type ReadExecuteArguments = Parameters<ReturnType<typeof createReadTool>["execute"]>;
type ToolSignal = ReadExecuteArguments[2];
type ToolUpdate = ReadExecuteArguments[3];
type ToolContext = ReadExecuteArguments[4];

function normalizeToolPath(filePath: string): string {
  const withoutAtPrefix = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  return withoutAtPrefix.replace(UNICODE_SPACES, " ");
}

export function resolveRemoteWorkspaceToolPath(filePath: string, localCwd: string, localHome = homedir()): string {
  const normalized = normalizeToolPath(filePath);
  const expanded = normalized === "~"
    ? localHome
    : normalized.startsWith("~/")
      ? `${localHome}${normalized.slice(1)}`
      : normalized;
  return isAbsolute(expanded) ? expanded : resolvePath(localCwd, expanded);
}

function abortedError(): Error {
  return new Error("aborted");
}

async function withAbortableFileMutationQueue<T>(
  filePath: string,
  signal: ToolSignal,
  mutation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw abortedError();
  const queued = withFileMutationQueue(filePath, async () => {
    if (signal?.aborted) throw abortedError();
    return mutation();
  });
  if (!signal) return queued;

  let abortHandler: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(abortedError());
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });
  try {
    return await Promise.race([queued, aborted]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function validateReadInput(input: ReadToolInput): void {
  if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 1)) {
    throw new Error("read offset must be a positive integer");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new Error("read limit must be a positive integer");
  }
}

function formatRemoteTextRead(input: ReadToolInput, result: PiSshWorkspaceTextReadResult) {
  const truncation = { ...result.truncation, content: result.content };
  let outputText: string;
  let details: { truncation: typeof truncation } | undefined;

  if (truncation.firstLineExceedsLimit) {
    outputText = `[Line ${result.startLineDisplay} is ${formatSize(result.firstLineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${result.startLineDisplay}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = result.startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${result.startLineDisplay}-${endLineDisplay} of ${result.totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${result.startLineDisplay}-${endLineDisplay} of ${result.totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (result.userLimitedLines !== null && result.hasMoreAfterUserLimit) {
    const consumedLines = result.startLineDisplay - 1 + result.userLimitedLines;
    const remaining = result.totalFileLines - consumedLines;
    const nextOffset = consumedLines + 1;
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }

  return {
    content: [{ type: "text" as const, text: outputText }],
    details,
  };
}

export async function executeRemoteReadTool(
  session: PiSshSession,
  localCwd: string,
  toolCallId: ReadExecuteArguments[0],
  input: ReadToolInput,
  signal: ToolSignal,
  onUpdate: ToolUpdate,
  context?: ToolContext,
) {
  validateReadInput(input);
  const localPath = resolveRemoteWorkspaceToolPath(input.path, localCwd);
  const result = await session.readWorkspaceFile(
    localPath,
    {
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    },
    signal,
  );

  if (result.kind === "text") {
    return formatRemoteTextRead(input, result);
  }

  // Reuse pi's image resizing and model-attachment behavior after the worker has
  // fetched the image in the same single request used for text metadata.
  const imageTool = createReadTool(localCwd, {
    operations: {
      access: async () => {},
      detectImageMimeType: async () => result.mimeType,
      readFile: async () => result.content,
    },
  });
  return imageTool.execute(toolCallId, input, signal, onUpdate, context);
}

export async function executeRemoteWriteTool(
  session: PiSshSession,
  localCwd: string,
  input: WriteToolInput,
  signal: ToolSignal,
) {
  const localPath = resolveRemoteWorkspaceToolPath(input.path, localCwd);
  return withAbortableFileMutationQueue(localPath, signal, async () => {
    await session.writeWorkspaceFile(localPath, Buffer.from(input.content, "utf8"), signal);
    return {
      content: [
        { type: "text" as const, text: `Successfully wrote ${input.content.length} bytes to ${input.path}` },
      ],
      details: undefined,
    };
  });
}

function validateEdits(input: EditToolInput): void {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  for (const [index, edit] of input.edits.entries()) {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error(`Edit tool input is invalid. edits[${index}] must contain string oldText and newText.`);
    }
  }
}

export async function executeRemoteEditTool(
  session: PiSshSession,
  localCwd: string,
  input: EditToolInput,
  signal: ToolSignal,
) {
  validateEdits(input);
  const localPath = resolveRemoteWorkspaceToolPath(input.path, localCwd);
  return withAbortableFileMutationQueue(localPath, signal, async () => {
    const result = await session.editWorkspaceFile(localPath, input.path, input.edits, signal);
    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.`,
        },
      ],
      details: {
        diff: result.diff,
        ...(result.firstChangedLine === undefined ? {} : { firstChangedLine: result.firstChangedLine }),
      },
    };
  });
}
