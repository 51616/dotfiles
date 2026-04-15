import path from "node:path";

import { captureFileImage, captureFileImageRemote } from "./files.ts";
import { buildRepoPatch, writeEmptyLatestArtifact, writeRepoArtifacts } from "./artifacts.ts";
import { buildPersistedAgentChangeReport, summarizeAgentChangeArtifact } from "./agent-change-report.ts";
import { findCwdRepoRoot, listRepoWorkspacePaths, repoKeyForRoot } from "./repo.ts";
import type { AgentChangeReport, FileImage, RepoTurnArtifact, RepoTurnState, TurnArtifactMetadata, TurnState } from "./types.ts";
import { listRemoteWorkspacePaths } from "../../lib/pi-diff-review-ssh.ts";
import type { PiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

function noteForTurn(changedPaths: number): string | undefined {
  if (changedPaths === 0) return "No repo changes were observed during the last turn.";
  return undefined;
}

function logAgentChangeFailure(turnId: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[pi-diff-review-turn-tracker] turn_id=${turnId} agent_change_report=exception: ${detail}`);
}

type SummarizeArtifact = (input: {
  metadata: TurnArtifactMetadata;
  patchText: string;
}) => Promise<Partial<AgentChangeReport> | null>;

type SshTurnContext = {
  session: PiSshSession;
  repoRoot: string;
  scopeKey: string;
};

function missingImage(): FileImage {
  return { kind: "missing", exists: false };
}

function fileImageEquals(left: FileImage, right: FileImage): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" && right.kind === "missing") return true;
  if (left.kind === "content" && right.kind === "content") {
    return left.sha256 === right.sha256;
  }
  if (left.kind === "omitted" && right.kind === "omitted") {
    return left.exists === right.exists
      && left.reason === right.reason
      && left.sizeBytes === right.sizeBytes
      && left.sha256 === right.sha256
      && left.mtimeMs === right.mtimeMs;
  }
  return false;
}

function changedTrackedPaths(repo: RepoTurnState): Map<string, (typeof repo.touchedPaths extends Map<string, infer V> ? V : never)> {
  const changed = new Map<string, (typeof repo.touchedPaths extends Map<string, infer V> ? V : never)>();
  for (const [repoRelPath, tracked] of repo.touchedPaths.entries()) {
    if (!fileImageEquals(tracked.baseline, tracked.final ?? missingImage())) {
      changed.set(repoRelPath, tracked);
    }
  }
  return changed;
}

export class DiffReviewTurnTracker {
  private current: TurnState | null = null;
  private readonly summarizeArtifact: SummarizeArtifact;
  private readonly enableAgentChangeReport: boolean;

  private ssh: SshTurnContext | null = null;
  private scopeKey: string | undefined;
  private allowRepoRootWrites = true;

  constructor(options?: { summarizeArtifact?: SummarizeArtifact; enableAgentChangeReport?: boolean }) {
    this.summarizeArtifact = options?.summarizeArtifact ?? summarizeAgentChangeArtifact;
    this.enableAgentChangeReport = options?.enableAgentChangeReport ?? true;
  }

  async startTurn({
    sessionId,
    turnId,
    cwd,
    ssh,
  }: {
    sessionId: string;
    turnId: string;
    cwd: string;
    ssh?: SshTurnContext;
  }): Promise<void> {
    this.reset();
    this.ssh = ssh ?? null;
    this.scopeKey = ssh?.scopeKey;
    this.allowRepoRootWrites = !ssh;

    try {
      const cwdRepoRoot = ssh?.repoRoot ?? findCwdRepoRoot(cwd);
      const repos = new Map<string, RepoTurnState>();

      if (cwdRepoRoot) {
        const repoState: RepoTurnState = {
          repoRoot: cwdRepoRoot,
          repoKey: repoKeyForRoot(cwdRepoRoot),
          touchedPaths: new Map(),
          capturedBytes: 0,
          baselineCapturedBytes: 0,
        };
        repos.set(cwdRepoRoot, repoState);
        await this.captureBaselineSnapshot(repoState);
      }

      this.current = {
        sessionId,
        turnId,
        startedAt: new Date().toISOString(),
        cwdRepoRoot,
        repos,
      };
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  reset(): void {
    this.current = null;
    this.ssh = null;
    this.scopeKey = undefined;
    this.allowRepoRootWrites = true;
  }

  private async captureBaselineSnapshot(repo: RepoTurnState): Promise<void> {
    const ssh = this.ssh;
    if (ssh) {
      for (const repoRelPath of await listRemoteWorkspacePaths(ssh.session, ssh.repoRoot)) {
        repo.touchedPaths.set(repoRelPath, {
          repoRelPath,
          absolutePath: path.posix.join(ssh.repoRoot, repoRelPath),
          baseline: await captureFileImageRemote(repo, ssh.session, ssh.repoRoot, repoRelPath, "pre"),
        });
      }
      repo.baselineCapturedBytes = repo.capturedBytes;
      return;
    }

    for (const repoRelPath of listRepoWorkspacePaths(repo.repoRoot)) {
      const absolutePath = path.join(repo.repoRoot, repoRelPath);
      repo.touchedPaths.set(repoRelPath, {
        repoRelPath,
        absolutePath,
        baseline: captureFileImage(repo, absolutePath, "pre"),
      });
    }
    repo.baselineCapturedBytes = repo.capturedBytes;
  }

  private async captureFinalSnapshot(repo: RepoTurnState): Promise<void> {
    repo.capturedBytes = repo.baselineCapturedBytes;
    const ssh = this.ssh;
    if (ssh) {
      const currentPaths = new Set(await listRemoteWorkspacePaths(ssh.session, ssh.repoRoot));
      for (const repoRelPath of currentPaths) {
        if (!repo.touchedPaths.has(repoRelPath)) {
          repo.touchedPaths.set(repoRelPath, {
            repoRelPath,
            absolutePath: path.posix.join(ssh.repoRoot, repoRelPath),
            baseline: missingImage(),
          });
        }
      }

      for (const tracked of repo.touchedPaths.values()) {
        const existedAtBaseline = tracked.baseline.kind !== "missing";
        const baselineWasCapOmitted = tracked.baseline.kind === "omitted" && tracked.baseline.reason === "total_cap_exceeded";
        tracked.final = currentPaths.has(tracked.repoRelPath)
          ? await captureFileImageRemote(repo, ssh.session, ssh.repoRoot, tracked.repoRelPath, "post", {
            allowContentCapture: !baselineWasCapOmitted,
            enforceTotalCap: !existedAtBaseline,
          })
          : missingImage();
      }
      return;
    }

    const currentPaths = new Set(listRepoWorkspacePaths(repo.repoRoot));
    for (const repoRelPath of currentPaths) {
      if (!repo.touchedPaths.has(repoRelPath)) {
        const absolutePath = path.join(repo.repoRoot, repoRelPath);
        repo.touchedPaths.set(repoRelPath, {
          repoRelPath,
          absolutePath,
          baseline: missingImage(),
        });
      }
    }

    for (const tracked of repo.touchedPaths.values()) {
      const existedAtBaseline = tracked.baseline.kind !== "missing";
      const baselineWasCapOmitted = tracked.baseline.kind === "omitted" && tracked.baseline.reason === "total_cap_exceeded";
      tracked.final = currentPaths.has(tracked.repoRelPath)
        ? captureFileImage(repo, tracked.absolutePath, "post", {
          allowContentCapture: !baselineWasCapOmitted,
          enforceTotalCap: !existedAtBaseline,
        })
        : missingImage();
    }
  }

  private async attachAgentChangeReport<T extends TurnArtifactMetadata>(
    metadata: T,
    patchText: string,
  ): Promise<T> {
    if (!this.enableAgentChangeReport) return metadata;
    try {
      const draft = await this.summarizeArtifact({ metadata, patchText });
      if (!draft) return metadata;

      const generatedAt = typeof draft.generated_at === "string" && draft.generated_at.trim()
        ? draft.generated_at
        : new Date().toISOString();
      const agentChangeReport = buildPersistedAgentChangeReport({
        draft: {
          generator: typeof draft.generator === "string" ? draft.generator : "",
          files: draft.files,
        },
        metadata,
        generatedAt,
      });
      if (!agentChangeReport) return metadata;
      return { ...metadata, agent_change_report: agentChangeReport };
    } catch (error) {
      logAgentChangeFailure(metadata.turn_id, error);
      return metadata;
    }
  }

  async finalize(cwd: string): Promise<void> {
    const turn = this.current;
    if (!turn) {
      this.ssh = null;
      return;
    }

    const repoArtifacts: RepoTurnArtifact[] = [];
    for (const repo of turn.repos.values()) {
      if (turn.cwdRepoRoot && repo.repoRoot !== turn.cwdRepoRoot) continue;

      await this.captureFinalSnapshot(repo);
      repo.touchedPaths = changedTrackedPaths(repo);

      const built = buildRepoPatch(repo);
      const changedPaths = [...repo.touchedPaths.keys()].sort();
      const metadata = await this.attachAgentChangeReport({
        saved_at: new Date().toISOString(),
        session_id: turn.sessionId,
        turn_id: turn.turnId,
        source: "last_turn_repo_snapshot",
        review_source: "last turn (repo snapshot)",
        repo_root: repo.repoRoot,
        repo_key: repo.repoKey,
        touched_paths: changedPaths,
        observed_changed_paths: built.observedChangedPaths,
        has_bash_calls: false,
        note: noteForTurn(changedPaths.length),
        omitted_paths: built.omittedPaths,
        workspace: false as const,
      }, built.patchText);

      repoArtifacts.push({
        repoRoot: repo.repoRoot,
        repoKey: repo.repoKey,
        patchText: built.patchText,
        metadata,
      });
    }

    for (const artifact of repoArtifacts) {
      writeRepoArtifacts({
        repoArtifact: artifact,
        scopeKey: this.scopeKey,
        allowRepoRoot: this.allowRepoRootWrites,
      });
    }

    const cwdRepoRoot = turn.cwdRepoRoot ?? findCwdRepoRoot(cwd);
    if (cwdRepoRoot && !turn.repos.has(cwdRepoRoot)) {
      const emptyMetadata = await this.attachAgentChangeReport({
        saved_at: new Date().toISOString(),
        session_id: turn.sessionId,
        turn_id: turn.turnId,
        source: "last_turn_repo_snapshot",
        review_source: "last turn (repo snapshot)",
        repo_root: cwdRepoRoot,
        repo_key: repoKeyForRoot(cwdRepoRoot),
        touched_paths: [],
        observed_changed_paths: [],
        has_bash_calls: false,
        note: noteForTurn(0),
        workspace: false as const,
      }, "");

      writeEmptyLatestArtifact({
        repoRoot: cwdRepoRoot,
        repoKey: repoKeyForRoot(cwdRepoRoot),
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        note: emptyMetadata.note,
        hasBashCalls: false,
        agentChangeReport: emptyMetadata.agent_change_report,
        scopeKey: this.scopeKey,
        allowRepoRoot: this.allowRepoRootWrites,
      });
    }

    this.current = null;
    this.ssh = null;
    this.scopeKey = undefined;
    this.allowRepoRootWrites = true;
  }
}
