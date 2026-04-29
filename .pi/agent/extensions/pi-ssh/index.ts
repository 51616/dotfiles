import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { createBashTool, type BashOperations } from "@mariozechner/pi-coding-agent";
import {
  clearPublishedPiSshSession,
  createPiSshSession,
  createRemoteEditOps,
  createRemoteReadOps,
  createRemoteWriteOps,
  mapLocalPathToRemote,
  publishActivePiSshSession,
  resolveActivePiSshRepoIdentity,
  type PiSshConnection,
} from "./lib/pi-ssh-session-runtime.ts";
import {
  PROMPT_CONTEXT_END_MARKER,
  PROMPT_CONTEXT_STATUS_MARKER,
  injectPromptContextFile,
  parsePromptContextProbeOutput,
  resolvePreferredPromptContextFile,
  type PromptContextFile,
} from "./lib/remote-context.ts";
import {
  isTuiBrokerInstalled,
  registerTuiBrokerFooterPathProvider,
  requestTuiBrokerFooterRefresh,
} from "../tui-broker/lib/runtime.ts";
import {
  buildPiSshFooterLabel,
  clearPiSshFooterSnapshot,
  getPiSshFooterSnapshot,
  setPiSshFooterSnapshot,
} from "./lib/pi-ssh-footer-runtime.ts";

interface SshConnection extends PiSshConnection {
  remoteDisplayTarget: string;
}

type SshEffectiveTarget = {
  user: string | null;
  hostname: string | null;
  port: string | null;
};

type SshDisplayTargetDeps = {
  readConfigText?: () => string | null;
  resolveEffectiveTarget?: (remote: string, port: number) => Promise<SshEffectiveTarget | null>;
};

interface SshCaptureOptions {
  stdin?: string | Buffer;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

interface SshCaptureResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

interface RemotePromptContextState {
  file: PromptContextFile | null;
  warning?: string;
}

type StartupNoticeTone = "info" | "warning";

type StartupNoticeEntry = {
  tone: StartupNoticeTone;
  title: string;
  body: string[];
  titleIndent?: number;
  bodyIndent?: number;
  separateFromPrevious?: boolean;
};

interface StartupNoticeMessageDetails {
  entries: StartupNoticeEntry[];
}

const PI_SSH_STARTUP_NOTICE_TYPE = "pi-ssh-startup-notice";

interface RunningCommand {
  startMarker: string;
  endMarker: string;
  timeout?: number;
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  aborted: boolean;
  timedOut: boolean;
  timeoutHandle?: NodeJS.Timeout;
  abortHandler?: () => void;
  completionGuardHandle?: NodeJS.Timeout;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  resolve: (value: { exitCode: number | null }) => void;
  reject: (error: Error) => void;
}

interface PersistentRemoteShellOptions {
  launcher?: () => ChildProcessWithoutNullStreams;
  startupCommands?: string[];
  abortGraceMs?: number;
}

const PI_SSH_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.PI_SSH_DEBUG ?? "");

function logPiSshDebug(event: string, details: Record<string, unknown>): void {
  if (!PI_SSH_DEBUG_ENABLED) {
    return;
  }
  console.error(`[pi-ssh] ${event} ${JSON.stringify(details)}`);
}

function isSkillStagePath(path: string): boolean {
  return path.includes("/.cache/pi/skill-stage/");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTagLikeSequences(content: string): string {
  // Prevent remote prompt-context from injecting skill catalog XML blocks that could confuse models.
  // This does not try to fully sanitize HTML/XML; it only neutralizes the exact tags pi uses.
  return content
    .replace(/<available_skills>/g, "&lt;available_skills&gt;")
    .replace(/<\/available_skills>/g, "&lt;/available_skills&gt;")
    .replace(/<skill>/g, "&lt;skill&gt;")
    .replace(/<\/skill>/g, "&lt;/skill&gt;")
    .replace(/<name>/g, "&lt;name&gt;")
    .replace(/<\/name>/g, "&lt;/name&gt;")
    .replace(/<description>/g, "&lt;description&gt;")
    .replace(/<\/description>/g, "&lt;/description&gt;")
    .replace(/<location>/g, "&lt;location&gt;")
    .replace(/<\/location>/g, "&lt;/location&gt;");
}

function buildShellBootstrapCommand(): string {
  return [
    "stty -echo 2>/dev/null || true",
    "unset PROMPT_COMMAND 2>/dev/null || true",
    "PS1=''",
    "PS2=''",
    "PROMPT=''",
    "RPROMPT=''",
    "export PAGER=cat",
    "export GIT_PAGER=cat",
    "export GIT_TERMINAL_PROMPT=0",
    // Keep pi-managed SSH traffic out of the user's interactive shell history.
    // Remote audit logs should come from the pi-agent SSH logger instead.
    "export HISTFILE=/dev/null HISTSIZE=0 HISTFILESIZE=0 SAVEHIST=0",
    "history -c 2>/dev/null || true",
    "set +o history 2>/dev/null || true",
    "fc -p /dev/null 0 2>/dev/null || fc -p /dev/null 0 0 2>/dev/null || true",
    "if [ -n \"${ZSH_VERSION-}\" ]; then precmd_functions=(); preexec_functions=(); chpwd_functions=(); unset zle_bracketed_paste 2>/dev/null || true; unsetopt INC_APPEND_HISTORY SHARE_HISTORY APPEND_HISTORY EXTENDED_HISTORY HIST_SAVE_BY_COPY 2>/dev/null || true; fi",
    "if [ -n \"${BASH_VERSION-}\" ]; then bind 'set enable-bracketed-paste off' 2>/dev/null || true; fi",
  ].join("; ");
}

function parseDelimitedShellOutput(
  stdoutText: string,
  startMarker: string,
  endMarker: string,
): { output: string; exitCode: number | null } | null {
  const text = stdoutText.replace(/\r\n/g, "\n");

  const endRegex = new RegExp(`(^|\\n)${escapeRegex(endMarker)}:(-?\\d+)(?=\\n|$)`);
  const endMatch = endRegex.exec(text);
  if (!endMatch) {
    return null;
  }

  const endLineStart = endMatch.index + endMatch[1].length;

  const startRegex = new RegExp(`(^|\\n)${escapeRegex(startMarker)}(?=\\n|$)`, "g");
  let startLineEnd = 0;
  let foundStart = false;
  while (true) {
    const startMatch = startRegex.exec(text);
    if (!startMatch) break;

    const startLineStart = startMatch.index + startMatch[1].length;
    if (startLineStart >= endLineStart) break;

    foundStart = true;
    startLineEnd = startLineStart + startMarker.length;
    if (text[startLineEnd] === "\n") {
      startLineEnd += 1;
    }
  }

  if (!foundStart) {
    return null;
  }

  const output = text.slice(startLineEnd, endLineStart);
  const parsedExitCode = Number(endMatch[2]);
  const exitCode = Number.isNaN(parsedExitCode) ? null : parsedExitCode;
  return { output, exitCode };
}

class CommandQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function formatDisplayPath(path: string, home: string): string {
  if (path === home) {
    return "~";
  }
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

type FooterTheme = {
  fg: (color: "dim", text: string) => string;
};

type RemoteFooterRenderState = {
  pwd: string;
  modelId: string | undefined;
  modelProvider: string | undefined;
  reasoning: boolean | undefined;
  thinkingLevel: string | undefined;
  availableProviderCount: number;
  extensionStatuses: string[];
};

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

const MODEL_ICON = "󰚩";
const EFFORT_ICON = "󰧑";

function buildModelEffortLabel(modelId: string | undefined, reasoning: boolean | undefined, thinkingLevel: string | undefined): string {
  const normalizedModelId = modelId?.trim() || "no-model";
  const modelLabel = `${MODEL_ICON} ${normalizedModelId}`;
  if (!reasoning) return modelLabel;

  const normalizedThinkingLevel = thinkingLevel?.trim() || "off";
  return `${modelLabel} · ${EFFORT_ICON} ${normalizedThinkingLevel}`;
}

function buildSingleLineFooter(left: string, right: string, width: number): string {
  if (width <= 0) return "";

  const normalizedRight = stripAnsi(truncateToWidth(right, width, ""));
  const rightWidth = visibleWidth(normalizedRight);
  if (rightWidth >= width) {
    return normalizedRight;
  }

  const availableLeft = Math.max(0, width - rightWidth - 1);
  const normalizedLeft = availableLeft > 0 ? stripAnsi(truncateToWidth(left, availableLeft, "...")) : "";
  const leftWidth = visibleWidth(normalizedLeft);
  const paddingWidth = Math.max(1, width - leftWidth - rightWidth);
  const padding = " ".repeat(paddingWidth);

  return `${normalizedLeft}${padding}${normalizedRight}`;
}

function buildRemoteFooterLines(theme: FooterTheme, state: RemoteFooterRenderState, width: number): string[] {
  const modelLabel = buildModelEffortLabel(state.modelId, state.reasoning, state.thinkingLevel);
  const rightSide =
    state.availableProviderCount > 1 && state.modelProvider
      ? `(${state.modelProvider}) ${modelLabel}`
      : modelLabel;

  const lines = [theme.fg("dim", buildSingleLineFooter(state.pwd, rightSide, width))];

  if (state.extensionStatuses.length > 0) {
    lines.push(theme.fg("dim", truncateToWidth(state.extensionStatuses.join(" "), width, "...")));
  }

  return lines;
}

function buildFooterPathLabel(path: string, home: string, _branch: string | null, sessionName: string | undefined): string {
  let label = formatDisplayPath(path, home);
  if (sessionName) {
    label = `${label} • ${sessionName}`;
  }
  return ` ${label}`;
}

function buildRemoteFooterLabel(
  connection: SshConnection,
  remoteCwd: string,
  _branch: string | null,
  sessionName: string | undefined,
): string {
  return buildPiSshFooterLabel(
    {
      remoteDisplayTarget: connection.remoteDisplayTarget,
      remoteHome: connection.remoteHome,
      remoteCwd,
    },
    sessionName,
  );
}

function buildStartupNoticeEntries(
  connection: SshConnection,
  remoteCwd: string,
  remotePromptContext: RemotePromptContextState,
): StartupNoticeEntry[] {
  const entries: StartupNoticeEntry[] = [
    {
      tone: "info",
      title: "pi-ssh",
      body: [`${connection.remoteDisplayTarget}:${remoteCwd} (port ${connection.port})`],
      bodyIndent: 0,
    },
  ];

  if (remotePromptContext.file) {
    entries.push({
      tone: "info",
      title: "Remote Context",
      body: [formatDisplayPath(remotePromptContext.file.path, connection.remoteHome)],
      bodyIndent: 2,
      separateFromPrevious: true,
    });
  }

  if (remotePromptContext.warning) {
    entries.push({
      tone: "warning",
      title: "pi-ssh warning",
      body: [remotePromptContext.warning],
      separateFromPrevious: true,
    });
  }

  return entries;
}

function renderStartupNoticeLines(
  theme: ExtensionContext["ui"]["theme"],
  entries: StartupNoticeEntry[],
): string[] {
  const lines: string[] = [];

  for (const [index, entry] of entries.entries()) {
    if (index > 0 && entry.separateFromPrevious) {
      lines.push("");
    }
    const titleColor = entry.tone === "warning" ? "warning" : "mdHeading";
    const titleIndent = " ".repeat(entry.titleIndent ?? 0);
    const bodyIndent = " ".repeat(entry.bodyIndent ?? (entry.titleIndent ?? 0) + 2);
    lines.push(`${titleIndent}${theme.fg(titleColor, `[${entry.title}]`)}`);
    for (const bodyLine of entry.body) {
      lines.push(theme.fg("dim", `${bodyIndent}${bodyLine}`));
    }
  }

  while (lines[0] === "") {
    lines.shift();
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function shouldPublishStartupNotice(
  entries: Array<{ type: string; customType?: string; display?: boolean }>,
): boolean {
  return !entries.some((entry) => {
    if (entry.type === "message") {
      return true;
    }
    return entry.type === "custom_message" && entry.display === true;
  });
}

function filterStartupNoticeMessages<T extends { role: string; customType?: string }>(messages: T[]): T[] {
  return messages.filter((message) => !(message.role === "custom" && message.customType === PI_SSH_STARTUP_NOTICE_TYPE));
}

function findRemotePathSeparator(value: string): number {
  const colonIndex = value.lastIndexOf(":");
  if (colonIndex === -1) {
    return -1;
  }

  const remotePath = value.slice(colonIndex + 1).trim();
  if (remotePath.startsWith("/") || remotePath === "~" || remotePath.startsWith("~/")) {
    return colonIndex;
  }

  // Preserve host:relative-path for the common single-colon form, but avoid
  // mis-parsing IPv6 literals without an explicit remote path.
  if (value.indexOf(":") === colonIndex) {
    return colonIndex;
  }

  return -1;
}

function parseSshFlag(raw: string): { remote: string; remotePath?: string } {
  const value = raw.trim();
  if (!value) {
    throw new Error("--ssh requires a value like user@host or user@host:/remote/path");
  }

  const colonIndex = findRemotePathSeparator(value);
  if (colonIndex === -1) {
    return { remote: value };
  }

  const remote = value.slice(0, colonIndex).trim();
  const remotePath = value.slice(colonIndex + 1).trim();
  if (!remote) {
    throw new Error("Invalid --ssh value: missing remote host");
  }
  if (!remotePath) {
    throw new Error("Invalid --ssh value: empty remote path");
  }
  return { remote, remotePath };
}

function parseSshPort(raw: string | undefined): number {
  const value = (raw ?? "22").trim();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid SSH port: ${value}`);
  }
  return parsed;
}

function buildSshBaseArgs(port: number): string[] {
  return [
    "-p",
    String(port),
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=600",
    "-o",
    "ControlPath=/tmp/pi-ssh-%C",
  ];
}

function readSshConfigText(): string | null {
  try {
    return readFileSync(`${homedir()}/.ssh/config`, "utf-8");
  } catch {
    return null;
  }
}

function parseSshConfigHostAliases(configText: string | null): string[] {
  if (!configText) return [];

  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const match = /^Host\s+(.+)$/i.exec(line);
    if (!match) continue;

    for (const rawPattern of match[1].trim().split(/\s+/)) {
      const pattern = rawPattern.trim();
      if (!pattern || pattern.startsWith("!") || /[*?]/.test(pattern)) continue;
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      aliases.push(pattern);
    }
  }
  return aliases;
}

function parseSshEffectiveTarget(configText: string): SshEffectiveTarget {
  let user: string | null = null;
  let hostname: string | null = null;
  let resolvedPort: string | null = null;

  for (const line of configText.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.trim().split(/\s+/);
    const key = rawKey?.toLowerCase();
    if (!key || rest.length === 0) continue;
    const value = rest.join(" ");
    if (key === "user" && !user) user = value;
    if (key === "hostname" && !hostname) hostname = value;
    if (key === "port" && !resolvedPort) resolvedPort = value;
  }

  return { user, hostname, port: resolvedPort };
}

async function readSshEffectiveTarget(remote: string, port: number): Promise<SshEffectiveTarget | null> {
  return new Promise((resolve) => {
    const child = spawn("ssh", ["-G", "-p", String(port), remote], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const stdoutChunks: Buffer[] = [];
    const timeoutHandle = setTimeout(() => child.kill(), 15_000);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.on("error", () => {
      clearTimeout(timeoutHandle);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        resolve(null);
        return;
      }

      resolve(parseSshEffectiveTarget(Buffer.concat(stdoutChunks).toString("utf-8")));
    });
  });
}

function sameSshEffectiveTarget(left: SshEffectiveTarget, right: SshEffectiveTarget): boolean {
  return (
    (left.hostname ?? "").toLowerCase() === (right.hostname ?? "").toLowerCase() &&
    (left.user ?? "") === (right.user ?? "") &&
    (left.port ?? "") === (right.port ?? "")
  );
}

function formatSshEffectiveTargetFallback(remote: string, target: SshEffectiveTarget | null): string {
  if (target?.user && target.hostname) return `${target.user}@${target.hostname}`;
  if (target?.hostname) return target.hostname;
  return remote;
}

async function resolveSshConfigAliasForTarget(
  remote: string,
  port: number,
  target: SshEffectiveTarget,
  aliases: string[],
  resolveEffectiveTarget: (remote: string, port: number) => Promise<SshEffectiveTarget | null>,
): Promise<string | null> {
  for (const alias of aliases) {
    if (alias === remote) continue;
    const aliasTarget = await resolveEffectiveTarget(alias, port);
    if (aliasTarget && sameSshEffectiveTarget(aliasTarget, target)) return alias;
  }
  return null;
}

async function resolveSshDisplayTarget(
  remote: string,
  port: number,
  deps: SshDisplayTargetDeps = {},
): Promise<string> {
  const readConfig = deps.readConfigText ?? readSshConfigText;
  const resolveEffectiveTarget = deps.resolveEffectiveTarget ?? readSshEffectiveTarget;
  const aliases = parseSshConfigHostAliases(readConfig());

  if (aliases.includes(remote)) {
    return remote;
  }

  const target = await resolveEffectiveTarget(remote, port);
  const alias = target
    ? await resolveSshConfigAliasForTarget(remote, port, target, aliases, resolveEffectiveTarget)
    : null;
  if (alias) return alias;
  if (!remote.includes("@")) return remote;
  return formatSshEffectiveTargetFallback(remote, target);
}

function buildResolveRemotePathCommand(remotePath: string): string {
  if (remotePath === "~") {
    return 'cd -- "$HOME" && pwd';
  }
  if (remotePath.startsWith("~/")) {
    return `cd -- "$HOME"/${shellQuote(remotePath.slice(2))} && pwd`;
  }
  return `cd -- ${shellQuote(remotePath)} && pwd`;
}

async function sshCapture(
  remote: string,
  port: number,
  remoteCommand: string,
  options: SshCaptureOptions = {},
): Promise<SshCaptureResult> {
  if (options.signal?.aborted) {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      timedOut: false,
      aborted: true,
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...buildSshBaseArgs(port), remote, remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;

    const timeoutHandle =
      options.timeoutSeconds && options.timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutSeconds * 1000)
        : undefined;

    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("close", (exitCode) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode,
        timedOut,
        aborted,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function sshExec(remote: string, port: number, remoteCommand: string, options: SshCaptureOptions = {}): Promise<Buffer> {
  const result = await sshCapture(remote, port, remoteCommand, options);
  if (result.aborted) {
    throw new Error("aborted");
  }
  if (result.timedOut) {
    throw new Error(`SSH command timed out after ${options.timeoutSeconds ?? 0}s`);
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf-8").trim();
    const message = stderr || `SSH command failed with exit code ${result.exitCode}`;
    throw new Error(message);
  }
  return result.stdout;
}

// Default timeout (5 minutes) prevents a single hung command from blocking
// the entire SSH command queue forever.
const DEFAULT_EXEC_TIMEOUT_SECONDS = 300;
const DEFAULT_ABORT_GRACE_MS = 1500;

class PersistentRemoteShell {
  private connection: SshConnection;
  private readonly options: PersistentRemoteShellOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private running: RunningCommand | null = null;
  private disposed = false;
  // Incremental streaming state: tracks how many bytes of the normalized
  // (post-start-marker) output have already been sent via onData.
  private streamedBytes = 0;
  private seenStartMarker = false;
  // Position in the raw stdout text right after the start marker line.
  private startMarkerEnd = 0;

  constructor(connection: SshConnection, options: PersistentRemoteShellOptions = {}) {
    this.connection = connection;
    this.options = options;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.failRunning(new Error("Remote shell disposed"), { resetShell: true });
    this.resetShellProcess();
  }

  exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }): Promise<{ exitCode: number | null }> {
    return this.execOne(command, cwd, options);
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("Remote shell is disposed");
    }
    if (this.child && !this.child.killed) {
      return;
    }

    const child = this.options.launcher
      ? this.options.launcher()
      : spawn("ssh", [...buildSshBaseArgs(this.connection.port), "-tt", this.connection.remote], {
          stdio: ["pipe", "pipe", "pipe"],
        });

    child.on("error", (error) => {
      if (this.child !== child) {
        return;
      }
      this.failRunning(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", () => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.failRunning(new Error("SSH shell closed unexpectedly"));
    });

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));

    this.child = child;
    const startupCommands = this.options.startupCommands ?? [buildShellBootstrapCommand(), `cd -- ${shellQuote(this.connection.remoteCwd)}`];
    for (const startupCommand of startupCommands) {
      this.child.stdin.write(`${startupCommand}\n`);
    }
  }

  private handleStdout(chunk: Buffer): void {
    const running = this.running;
    if (!running) return;
    running.stdoutChunks.push(chunk);
    this.streamIncremental();
    this.tryCompleteRunning();
  }

  private handleStderr(chunk: Buffer): void {
    const running = this.running;
    if (!running) return;
    running.stderrChunks.push(chunk);
  }

  /**
   * Normalize raw PTY output the same way parseDelimitedShellOutput does:
   * replace \r\n with \n. Bare \r is left intact so byte counts match
   * the parsed output exactly.
   */
  private normalize(text: string): string {
    return text.replace(/\r\n/g, "\n");
  }

  /**
   * Stream output incrementally to onData as it arrives, rather than
   * waiting for the command to complete. This enables live progress
   * in the TUI (tool_execution_update events).
   *
   * Works on normalized text so the bytes sent match parseDelimitedShellOutput
   * output exactly, allowing correct "remaining" calculation at completion.
   */
  private streamIncremental(): void {
    const running = this.running;
    if (!running) return;

    const rawText = Buffer.concat(running.stdoutChunks).toString("utf-8");
    const text = this.normalize(rawText);

    // Wait until we've seen the start marker before streaming anything
    if (!this.seenStartMarker) {
      const startRegex = new RegExp(`(^|\\n)${escapeRegex(running.startMarker)}\\n`);
      const startMatch = startRegex.exec(text);
      if (!startMatch) return;
      this.seenStartMarker = true;
      this.startMarkerEnd = startMatch.index + startMatch[0].length;
      this.streamedBytes = 0;
    }

    // Extract the output region: everything after the start marker
    const outputSoFar = text.slice(this.startMarkerEnd);

    // Hold back the last 1-2 lines to avoid streaming partial end markers.
    // The end marker looks like: __PI_SSH_DONE_<id>__:<exitcode>
    // Find the last newline that's safe to stream up to.
    const endMarkerPrefix = "__PI_SSH_DONE_";
    let safeLen = outputSoFar.length;

    // Walk back from the end to find lines that might be (partial) end markers
    const lastNl = outputSoFar.lastIndexOf("\n");
    if (lastNl >= 0) {
      const tailLine = outputSoFar.slice(lastNl + 1);
      if (tailLine.length === 0 || tailLine.includes(endMarkerPrefix) || endMarkerPrefix.startsWith(tailLine.trimEnd())) {
        // The incomplete last line might be a marker; hold it back
        safeLen = lastNl + 1;
      }
      // Also check the last complete line
      if (safeLen === lastNl + 1) {
        const prevNl = outputSoFar.lastIndexOf("\n", lastNl - 1);
        const lastCompleteLine = outputSoFar.slice(prevNl + 1, lastNl);
        if (lastCompleteLine.includes(endMarkerPrefix)) {
          safeLen = Math.max(0, prevNl + 1);
        }
      }
    } else {
      // No newline at all yet — could be a partial marker, hold everything back
      if (outputSoFar.includes(endMarkerPrefix) || endMarkerPrefix.startsWith(outputSoFar.trimEnd())) {
        safeLen = 0;
      }
    }

    if (safeLen > this.streamedBytes) {
      const newData = outputSoFar.slice(this.streamedBytes, safeLen);
      if (newData.length > 0) {
        running.onData(Buffer.from(newData, "utf-8"));
        this.streamedBytes = safeLen;
      }
    }
  }

  private tryCompleteRunning(): void {
    const running = this.running;
    if (!running) return;

    const rawText = Buffer.concat(running.stdoutChunks).toString("utf-8");
    const parsed = parseDelimitedShellOutput(rawText, running.startMarker, running.endMarker);
    if (!parsed) return;

    // parsed.output is the normalized output between markers.
    // Send any bytes we haven't streamed yet (the held-back tail).
    const fullOutput = parsed.output;
    if (this.streamedBytes < fullOutput.length) {
      const remaining = fullOutput.slice(this.streamedBytes);
      running.onData(Buffer.from(remaining, "utf-8"));
    }

    // Also send stderr (merged at the end, matching original behavior)
    const stderr = Buffer.concat(running.stderrChunks);
    if (stderr.length > 0) {
      running.onData(stderr);
    }

    const exitCode = parsed.exitCode;
    const timedOut = running.timedOut;
    const aborted = running.aborted;
    const timeout = running.timeout;

    this.cleanupRunning();

    if (timedOut) {
      running.reject(new Error(`timeout:${timeout}`));
      return;
    }
    if (aborted) {
      running.reject(new Error("aborted"));
      return;
    }

    running.resolve({ exitCode });
  }

  private cleanupRunning(): void {
    if (!this.running) return;
    if (this.running.timeoutHandle) clearTimeout(this.running.timeoutHandle);
    if (this.running.completionGuardHandle) clearTimeout(this.running.completionGuardHandle);
    if (this.running.signal && this.running.abortHandler) {
      this.running.signal.removeEventListener("abort", this.running.abortHandler);
    }
    this.running = null;
  }

  private failRunning(error: Error, options: { resetShell?: boolean } = {}): void {
    const running = this.running;
    if (!running) {
      if (options.resetShell) {
        this.resetShellProcess();
      }
      return;
    }

    this.cleanupRunning();
    if (options.resetShell) {
      this.resetShellProcess();
    }
    running.reject(error);
  }

  private resetShellProcess(): void {
    const child = this.child;
    if (!child) {
      return;
    }

    this.child = null;
    if (!child.killed) {
      child.kill();
    }
  }

  private scheduleCompletionGuard(error: Error): void {
    const running = this.running;
    if (!running || running.completionGuardHandle) {
      return;
    }

    const abortGraceMs = this.options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    running.completionGuardHandle = setTimeout(() => {
      if (this.running !== running) {
        return;
      }
      this.failRunning(error, { resetShell: true });
    }, abortGraceMs);
  }

  private interruptCurrentCommand(): void {
    if (!this.child || this.child.killed) return;
    // Send Ctrl-C to remote TTY; this interrupts the foreground command
    // but keeps the SSH shell session alive.
    this.child.stdin.write("\x03");
  }

  private async execOne(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    await this.ensureStarted();
    if (!this.child || this.child.killed) {
      throw new Error("Failed to start persistent SSH shell");
    }

    const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const startMarker = `__PI_SSH_BEGIN_${unique}__`;
    const endMarker = `__PI_SSH_DONE_${unique}__`;
    const remoteCwd = mapLocalPathToRemote(cwd, this.connection);

    // Redirect stdin from /dev/null so commands that accidentally read from
    // stdin (e.g., bare `wc`, `read`, `cat` without args) get EOF immediately
    // instead of blocking forever on the PTY. Shell pipelines still work
    // because the pipe overrides stdin for downstream commands.
    //
    // If the command contains newlines (e.g. multi-line git commit -m "..."),
    // base64-encode it so the entire wrapper stays on a single PTY line.
    // Otherwise the PTY interprets embedded newlines as separate command
    // submissions and the end marker is never reached, hanging the session.
    const needsEncoding = command.includes("\n");
    const execPart = needsEncoding
      ? `eval "$(printf '%s' '${Buffer.from(command).toString("base64")}' | base64 -d)"`
      : `{ ${command}; }`;

    const wrappedCommand = [
      `printf '\\n${startMarker}\\n'`,
      `if cd -- ${shellQuote(remoteCwd)}; then ${execPart} </dev/null; __pi_ec=$?; else __pi_ec=$?; fi`,
      `printf '\\n${endMarker}:%s\\n' \"$__pi_ec\"`,
    ].join("; ");

    // Reset incremental streaming state for the new command
    this.streamedBytes = 0;
    this.seenStartMarker = false;
    this.startMarkerEnd = 0;

    // Apply default timeout if none specified, so a hung command can't
    // block the queue forever
    const effectiveTimeout = options.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS;

    return new Promise((resolve, reject) => {
      const running: RunningCommand = {
        startMarker,
        endMarker,
        timeout: effectiveTimeout,
        onData: options.onData,
        signal: options.signal,
        aborted: false,
        timedOut: false,
        stdoutChunks: [],
        stderrChunks: [],
        resolve,
        reject,
      };

      this.running = running;

      if (options.signal?.aborted) {
        this.failRunning(new Error("aborted"));
        return;
      }

      if (effectiveTimeout > 0) {
        running.timeoutHandle = setTimeout(() => {
          running.timedOut = true;
          this.interruptCurrentCommand();
          this.scheduleCompletionGuard(new Error(`timeout:${effectiveTimeout}`));
        }, effectiveTimeout * 1000);
      }

      if (options.signal) {
        running.abortHandler = () => {
          if (running.aborted) {
            return;
          }
          running.aborted = true;
          this.interruptCurrentCommand();
          this.scheduleCompletionGuard(new Error("aborted"));
        };

        options.signal.addEventListener("abort", running.abortHandler, { once: true });
      }

      this.child?.stdin.write(`${wrappedCommand}\n`);
    });
  }
}

const PERSISTENT_WRITE_MAX_BYTES = 256 * 1024;

interface RemoteTransport {
  dispose(): Promise<void>;
  exec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }>;
  execText(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<{ exitCode: number | null; output: string }>;
  readFile(remotePath: string, signal?: AbortSignal): Promise<Buffer>;
  ensureReadable(remotePath: string, signal?: AbortSignal): Promise<void>;
  ensureReadableWritable(remotePath: string, signal?: AbortSignal): Promise<void>;
  detectImageMimeType(remotePath: string, signal?: AbortSignal): Promise<string | null>;
  mkdir(remoteDir: string, signal?: AbortSignal): Promise<void>;
  writeFile(remotePath: string, content: Buffer, signal?: AbortSignal): Promise<void>;
}

function remoteDirname(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex <= 0) return "/";
  return path.slice(0, slashIndex);
}

interface SshTransportOptions {
  shell?: Pick<PersistentRemoteShell, "dispose" | "exec">;
  sshExecFn?: typeof sshExec;
}

class SshTransport implements RemoteTransport {
  private connection: SshConnection;
  private shell: Pick<PersistentRemoteShell, "dispose" | "exec">;
  private readonly sshExecFn: typeof sshExec;
  private queue = new CommandQueue();

  constructor(connection: SshConnection, options: SshTransportOptions = {}) {
    this.connection = connection;
    this.shell = options.shell ?? new PersistentRemoteShell(connection);
    this.sshExecFn = options.sshExecFn ?? sshExec;
  }

  async dispose(): Promise<void> {
    await this.shell.dispose();
  }

  exec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    return this.queue.enqueue(() => this.shell.exec(command, cwd, options));
  }

  async execText(command: string, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<{ exitCode: number | null; output: string }> {
    const result = await this.capture(command, options);
    return {
      exitCode: result.exitCode,
      output: result.output.toString("utf-8").replace(/\r\n/g, "\n"),
    };
  }

  async readFile(remotePath: string, signal?: AbortSignal): Promise<Buffer> {
    // Read files over a one-shot SSH exec so bytes are preserved exactly.
    // The persistent shell runs through a PTY and normalizes output for
    // streaming, which is fine for text commands but corrupts binary reads.
    if (isSkillStagePath(remotePath)) {
      logPiSshDebug("transport.read-file.begin", { remotePath });
    }
    return this.queue.enqueue(async () => {
      try {
        const result = await this.sshExecFn(this.connection.remote, this.connection.port, `cat -- ${shellQuote(remotePath)}`, {
          timeoutSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
          signal,
        });
        if (isSkillStagePath(remotePath)) {
          logPiSshDebug("transport.read-file.ok", { remotePath, bytes: result.length });
        }
        return result;
      } catch (error) {
        if (isSkillStagePath(remotePath)) {
          logPiSshDebug("transport.read-file.error", {
            remotePath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    });
  }

  async ensureReadable(remotePath: string, signal?: AbortSignal): Promise<void> {
    await this.runChecked(`test -r ${shellQuote(remotePath)}`, undefined, signal);
  }

  async ensureReadableWritable(remotePath: string, signal?: AbortSignal): Promise<void> {
    await this.runChecked(`test -r ${shellQuote(remotePath)} && test -w ${shellQuote(remotePath)}`, undefined, signal);
  }

  async detectImageMimeType(remotePath: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.capture(`file --mime-type -b -- ${shellQuote(remotePath)} 2>/dev/null || true`, { signal });
    const mime = result.output.toString("utf-8").trim();
    if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
      return mime;
    }
    return null;
  }

  async mkdir(remoteDir: string, signal?: AbortSignal): Promise<void> {
    await this.runChecked(`mkdir -p -- ${shellQuote(remoteDir)}`, undefined, signal);
  }

  async writeFile(remotePath: string, content: Buffer, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("aborted");
    }

    if (isSkillStagePath(remotePath)) {
      logPiSshDebug("transport.write-file.begin", { remotePath, bytes: content.length });
    }

    if (content.length <= PERSISTENT_WRITE_MAX_BYTES) {
      const remoteDir = remoteDirname(remotePath);
      const encodedContent = content.toString("base64");
      const command = [
        `mkdir -p -- ${shellQuote(remoteDir)}`,
        `printf '%s' ${shellQuote(encodedContent)} | base64 -d > ${shellQuote(remotePath)}`,
      ].join(" && ");

      try {
        await this.runChecked(command, undefined, signal);
        if (isSkillStagePath(remotePath)) {
          logPiSshDebug("transport.write-file.ok", { remotePath, bytes: content.length, mode: "persistent" });
        }
        return;
      } catch (error) {
        if (isSkillStagePath(remotePath)) {
          logPiSshDebug("transport.write-file.retry", {
            remotePath,
            bytes: content.length,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (signal?.aborted) {
          throw error;
        }
        if (error instanceof Error && (error.message === "aborted" || error.message.startsWith("timeout:"))) {
          throw error;
        }
        // fall through to one-shot streaming fallback
      }
    }

    await this.queue.enqueue(async () => {
      const remoteDir = remoteDirname(remotePath);
      const command = [`mkdir -p -- ${shellQuote(remoteDir)}`, `cat > ${shellQuote(remotePath)}`].join(" && ");
      try {
        await this.sshExecFn(this.connection.remote, this.connection.port, command, {
          stdin: content,
          signal,
        });
        if (isSkillStagePath(remotePath)) {
          logPiSshDebug("transport.write-file.ok", { remotePath, bytes: content.length, mode: "stream" });
        }
      } catch (error) {
        if (isSkillStagePath(remotePath)) {
          logPiSshDebug("transport.write-file.error", {
            remotePath,
            bytes: content.length,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    });
  }

  private async capture(
    command: string,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<{ exitCode: number | null; output: Buffer }> {
    return this.queue.enqueue(async () => {
      const outputChunks: Buffer[] = [];
      const result = await this.shell.exec(command, this.connection.localCwd, {
        timeout: options.timeout,
        signal: options.signal,
        onData: (data) => {
          outputChunks.push(data);
        },
      });
      return {
        exitCode: result.exitCode,
        output: Buffer.concat(outputChunks),
      };
    });
  }

  private async runChecked(command: string, timeout?: number, signal?: AbortSignal): Promise<Buffer> {
    const result = await this.capture(command, { timeout, signal });
    if (result.exitCode !== 0) {
      const stderr = result.output.toString("utf-8").trim();
      throw new Error(stderr || `SSH command failed with exit code ${result.exitCode}`);
    }
    return result.output;
  }
}

async function resolveSshConnection(rawFlag: string, localCwd: string, localHome: string, port: number): Promise<SshConnection> {
  const parsed = parseSshFlag(rawFlag);
  const remoteDisplayTarget = await resolveSshDisplayTarget(parsed.remote, port);

  const remoteHomeBuffer = await sshExec(parsed.remote, port, 'printf "%s" "$HOME"', {
    timeoutSeconds: 15,
  });
  const remoteHome = remoteHomeBuffer.toString("utf-8").trim();

  if (!remoteHome) {
    throw new Error("Failed to detect remote HOME");
  }

  if (!parsed.remotePath) {
    const remotePwd = await sshExec(parsed.remote, port, "pwd", { timeoutSeconds: 15 });
    const connection = {
      remote: parsed.remote,
      remoteDisplayTarget,
      port,
      remoteCwd: remotePwd.toString("utf-8").trim(),
      remoteHome,
      localCwd,
      localHome,
    };
    logPiSshDebug("resolve-ssh-connection", {
      remote: connection.remote,
      remoteDisplayTarget: connection.remoteDisplayTarget,
      port: connection.port,
      remoteHome: connection.remoteHome,
      remoteCwd: connection.remoteCwd,
      localCwd: connection.localCwd,
    });
    return connection;
  }

  const resolvedPath = await sshExec(parsed.remote, port, buildResolveRemotePathCommand(parsed.remotePath), {
    timeoutSeconds: 15,
  });

  const connection = {
    remote: parsed.remote,
    remoteDisplayTarget,
    port,
    remoteCwd: resolvedPath.toString("utf-8").trim(),
    remoteHome,
    localCwd,
    localHome,
  };
  logPiSshDebug("resolve-ssh-connection", {
    remote: connection.remote,
    remoteDisplayTarget: connection.remoteDisplayTarget,
    port: connection.port,
    remoteHome: connection.remoteHome,
    remoteCwd: connection.remoteCwd,
    localCwd: connection.localCwd,
  });
  return connection;
}

async function readRemoteTextFileIfExists(remote: string, port: number, remotePath: string): Promise<string | null> {
  const probeScript = [
    "set -eu",
    `remote_path=${shellQuote(remotePath)}`,
    `status_marker=${shellQuote(PROMPT_CONTEXT_STATUS_MARKER)}`,
    `end_marker=${shellQuote(PROMPT_CONTEXT_END_MARKER)}`,
    'if [ -e "$remote_path" ]; then',
    '  if [ -f "$remote_path" ] && [ -r "$remote_path" ]; then',
    '    printf "%s\\n" "${status_marker}ok"',
    '    if base64 --help 2>/dev/null | grep -q -- "-w"; then',
    '      base64 -w0 < "$remote_path"',
    "    else",
    '      base64 < "$remote_path" | tr -d "\\n\\r"',
    "    fi",
    '    printf "\\n%s\\n" "$end_marker"',
    "  else",
    '    printf "%s\\n" "${status_marker}unreadable"',
    "  fi",
    "else",
    '  printf "%s\\n" "${status_marker}missing"',
    "fi",
  ].join("\n");

  const encodedProbeScript = Buffer.from(probeScript, "utf-8").toString("base64");
  const probe = await sshCapture(
    remote,
    port,
    `sh -c \"$(printf '%s' ${shellQuote(encodedProbeScript)} | (base64 -d 2>/dev/null || base64 -D 2>/dev/null))\"`,
    { timeoutSeconds: 15 },
  );
  if (probe.timedOut) {
    throw new Error(`SSH command timed out after 15s while probing ${remotePath}`);
  }

  return parsePromptContextProbeOutput(
    probe.stdout.toString("utf-8"),
    probe.stderr.toString("utf-8"),
    remotePath,
  );
}

async function loadRemotePromptContext(connection: SshConnection): Promise<RemotePromptContextState> {
  const result = await resolvePreferredPromptContextFile(connection.remoteCwd, (remotePath) =>
    readRemoteTextFileIfExists(connection.remote, connection.port, remotePath),
  );

  const warning =
    result.warnings.length > 0
      ? `pi-ssh remote prompt context warning for ${connection.remote}:${connection.remoteCwd}: ${result.warnings.join("; ")}`
      : undefined;
  return {
    file: result.file ? { ...result.file, content: escapeTagLikeSequences(result.file.content) } : null,
    warning,
  };
}

export default function piSshExtension(pi: ExtensionAPI): void {
  pi.registerFlag("ssh", {
    description: "SSH target as user@host or user@host:/absolute/remote/path",
    type: "string",
  });
  pi.registerFlag("ssh-port", {
    description: "SSH port (default: 22)",
    type: "string",
    default: "22",
  });
  pi.registerFlag("port", {
    description: "Alias for --ssh-port",
    type: "string",
  });

  const localCwd = process.cwd();
  const localHome = homedir();
  const localBash = createBashTool(localCwd);

  pi.registerMessageRenderer<StartupNoticeMessageDetails>(PI_SSH_STARTUP_NOTICE_TYPE, (message, _options, theme) => {
    const lines = renderStartupNoticeLines(theme, message.details?.entries ?? []);
    return new Text(lines.join("\n"), 0, 0);
  });

  let connection: SshConnection | null = null;
  let transport: SshTransport | null = null;
  let activeSession: ReturnType<typeof createPiSshSession> | null = null;
  let remotePromptContext: RemotePromptContextState = { file: null };
  let remoteFooterCwd: string | null = null;
  let activeUiContext: ExtensionContext | null = null;
  const footerRenderListeners = new Set<() => void>();

  registerTuiBrokerFooterPathProvider("pi-ssh", ({ sessionName }) => {
    const snapshot = getPiSshFooterSnapshot();
    if (!snapshot) return null;
    return {
      text: buildPiSshFooterLabel(snapshot, sessionName),
      priority: 200,
    };
  });

  const getConnection = () => connection;
  const notifyFooterRenderListeners = () => {
    for (const listener of footerRenderListeners) {
      listener();
    }
  };
  const subscribeFooterRender = (listener: () => void): (() => void) => {
    footerRenderListeners.add(listener);
    return () => footerRenderListeners.delete(listener);
  };
  const resolveUiContext = (ctx?: ExtensionContext | null): ExtensionContext | null => {
    if (ctx?.hasUI) {
      activeUiContext = ctx;
      return ctx;
    }
    if (activeUiContext?.hasUI) {
      return activeUiContext;
    }
    return null;
  };
  const getEffectiveRemoteFooterCwd = (conn: SshConnection, ctx?: ExtensionContext | null): string => {
    if (remoteFooterCwd) {
      return remoteFooterCwd;
    }
    const sessionCwd = ctx?.sessionManager.getCwd() ?? activeUiContext?.sessionManager.getCwd() ?? conn.localCwd;
    return mapLocalPathToRemote(sessionCwd, conn);
  };
  const publishRemoteFooterState = (conn: SshConnection, ctx?: ExtensionContext | null): void => {
    const uiCtx = resolveUiContext(ctx);
    if (!uiCtx) {
      return;
    }
    setPiSshFooterSnapshot({
      remoteDisplayTarget: conn.remoteDisplayTarget,
      remoteHome: conn.remoteHome,
      remoteCwd: getEffectiveRemoteFooterCwd(conn, uiCtx),
    });
    uiCtx.ui.setStatus("pi-ssh", undefined);
    requestTuiBrokerFooterRefresh();
    notifyFooterRenderListeners();
  };
  const publishStartupNotice = (entries: StartupNoticeEntry[], ctx: ExtensionContext): void => {
    if (!ctx.hasUI || entries.length === 0) {
      return;
    }
    if (!shouldPublishStartupNotice(ctx.sessionManager.getEntries())) {
      return;
    }
    pi.sendMessage({
      customType: PI_SSH_STARTUP_NOTICE_TYPE,
      content: "pi-ssh startup notice",
      display: true,
      details: { entries } satisfies StartupNoticeMessageDetails,
    });
  };
  const setRemoteFooterCwd = (conn: SshConnection, nextRemoteCwd: string, ctx?: ExtensionContext | null): void => {
    if (connection !== conn) {
      return;
    }
    if (remoteFooterCwd === nextRemoteCwd) {
      return;
    }
    remoteFooterCwd = nextRemoteCwd;
    publishRemoteFooterState(conn, ctx);
  };
  const createTrackedRemoteBashOps = (): BashOperations => {
    if (!connection || !activeSession) {
      throw new Error("Remote SSH transport is not available");
    }
    return activeSession.createBashOps({
      onCommandComplete: (cwd) => {
        if (!connection) {
          return;
        }
        setRemoteFooterCwd(connection, mapLocalPathToRemote(cwd, connection));
      },
    });
  };

  const installRemoteFooter = (ctx: ExtensionContext, conn: SshConnection): void => {
    if (!ctx.hasUI || isTuiBrokerInstalled()) {
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribeFooterRender = subscribeFooterRender(() => tui.requestRender());

      return {
        dispose() {
          unsubscribeFooterRender();
        },
        invalidate() {},
        render(width: number): string[] {
          const effectiveRemoteCwd = getEffectiveRemoteFooterCwd(conn, ctx);
          const extensionStatuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatusText(text));

          return buildRemoteFooterLines(
            theme,
            {
              pwd: buildRemoteFooterLabel(
                conn,
                effectiveRemoteCwd,
                null,
                ctx.sessionManager.getSessionName(),
              ),
              modelId: ctx.model?.id,
              modelProvider: ctx.model?.provider,
              reasoning: ctx.model?.reasoning,
              thinkingLevel: pi.getThinkingLevel(),
              availableProviderCount: footerData.getAvailableProviderCount(),
              extensionStatuses,
            },
            width,
          );
        },
      };
    });
  };

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      if (!transport) {
        return localBash.execute(id, params, signal, onUpdate);
      }
      const tool = createBashTool(localCwd, { operations: createTrackedRemoteBashOps() });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("ssh") as string | undefined;
    if (!flag) return;

    try {
      const rawPort = (pi.getFlag("port") as string | undefined) ?? (pi.getFlag("ssh-port") as string | undefined);
      const port = parseSshPort(rawPort);
      connection = await resolveSshConnection(flag, localCwd, localHome, port);
      const sessionConnection = connection;
      transport = new SshTransport(sessionConnection);
      const sessionTransport = transport;
      activeSession = createPiSshSession({
        connection: sessionConnection,
        transport: sessionTransport,
        execCapture: (command, options) => sshCapture(sessionConnection.remote, sessionConnection.port, command, options),
        execText: async (command, options) => {
          try {
            const result = await sessionTransport.execText(command, {
              timeout: typeof options?.timeoutSeconds === "number" ? options.timeoutSeconds : undefined,
              signal: options?.signal,
            });
            return {
              ...result,
              timedOut: false,
              aborted: false,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "aborted") {
              return { output: "", exitCode: null, timedOut: false, aborted: true };
            }
            if (message.startsWith("timeout:")) {
              return { output: "", exitCode: null, timedOut: true, aborted: false };
            }
            throw error;
          }
        },
      });
      publishActivePiSshSession(activeSession);
      try {
        await resolveActivePiSshRepoIdentity(ctx.sessionManager.getCwd());
      } catch (error) {
        logPiSshDebug("repo-root-cache-warm.failed", {
          remoteCwd: sessionConnection.remoteCwd,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      activeUiContext = ctx.hasUI ? ctx : null;
      remoteFooterCwd = mapLocalPathToRemote(ctx.sessionManager.getCwd(), connection);
      installRemoteFooter(ctx, connection);
      publishRemoteFooterState(connection, ctx);
      remotePromptContext = await loadRemotePromptContext(connection);
      const enabledMessage = `pi-ssh enabled: ${connection.remote}:${remoteFooterCwd} (port ${connection.port})`;
      if (ctx.hasUI) {
        publishStartupNotice(buildStartupNoticeEntries(connection, remoteFooterCwd, remotePromptContext), ctx);
      } else {
        console.log(enabledMessage);
        if (remotePromptContext.file) {
          console.log(`pi-ssh loaded prompt context: ${remotePromptContext.file.path}`);
        }
        if (remotePromptContext.warning) {
          console.warn(remotePromptContext.warning);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connection = null;
      activeSession = null;
      clearPublishedPiSshSession();
      remotePromptContext = { file: null };
      remoteFooterCwd = null;
      activeUiContext = null;
      clearPiSshFooterSnapshot();
      requestTuiBrokerFooterRefresh();
      if (transport) {
        await transport.dispose();
        transport = null;
      }
      if (ctx.hasUI) {
        if (!isTuiBrokerInstalled()) {
          ctx.ui.setFooter(undefined);
        }
        ctx.ui.setStatus("pi-ssh", undefined);
        ctx.ui.notify(`pi-ssh failed to connect: ${message}`, "error");
      } else {
        console.error(`pi-ssh failed to connect: ${message}`);
      }
      throw error;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    connection = null;
    activeSession = null;
    clearPublishedPiSshSession();
    remotePromptContext = { file: null };
    remoteFooterCwd = null;
    activeUiContext = null;
    clearPiSshFooterSnapshot();
    requestTuiBrokerFooterRefresh();
    notifyFooterRenderListeners();
    if (ctx.hasUI) {
      if (!isTuiBrokerInstalled()) {
        ctx.ui.setFooter(undefined);
      }
      ctx.ui.setStatus("pi-ssh", undefined);
    }
    if (transport) {
      await transport.dispose();
      transport = null;
    }
  });

  pi.on("user_bash", () => {
    if (!transport) return;
    return { operations: createTrackedRemoteBashOps() };
  });

  pi.on("context", (event) => {
    const filtered = filterStartupNoticeMessages(event.messages);
    if (filtered.length !== event.messages.length) {
      return { messages: filtered };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const conn = getConnection();

    const localPrefix = `Current working directory: ${localCwd}`;
    const remotePrefix = conn
      ? `Current working directory: ${getEffectiveRemoteFooterCwd(conn, ctx)} (via SSH ${conn.remote}, port ${conn.port})`
      : null;

    let systemPrompt = event.systemPrompt;
    let changed = false;

    if (remotePrefix && systemPrompt.includes(localPrefix)) {
      systemPrompt = systemPrompt.replace(localPrefix, remotePrefix);
      changed = true;
    }

    if (conn && remotePromptContext.file) {
      const injectedPrompt = injectPromptContextFile(systemPrompt, remotePromptContext.file);
      if (injectedPrompt !== systemPrompt) {
        systemPrompt = injectedPrompt;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }
    return { systemPrompt };
  });
}

export const __testInternals = {
  PersistentRemoteShell,
  SshTransport,
  sshCapture,
  sshExec,
  createRemoteReadOps,
  createRemoteWriteOps,
  createRemoteEditOps,
  buildFooterPathLabel,
  buildRemoteFooterLabel,
  buildRemoteFooterLines,
  buildSingleLineFooter,
  buildStartupNoticeEntries,
  parseSshConfigHostAliases,
  renderStartupNoticeLines,
  resolveSshDisplayTarget,
  shouldPublishStartupNotice,
  filterStartupNoticeMessages,
  parseDelimitedShellOutput,
};
