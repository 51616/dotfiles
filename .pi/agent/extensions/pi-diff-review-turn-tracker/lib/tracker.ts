import path from "node:path";

import { captureFileImage, captureFileImageRemote } from "./files.ts";
import { buildRepoPatch, writeEmptyLatestArtifact, writeRepoArtifacts } from "./artifacts.ts";
import { buildPersistedAgentChangeReport, summarizeAgentChangeArtifact } from "./agent-change-report.ts";
import { snoopedBashPaths } from "./bash-snoop.ts";
import { findCwdRepoRoot, repoKeyForRoot, resolveRepoPath } from "./repo.ts";
import type { AgentChangeReport, RepoTurnArtifact, RepoTurnState, TurnArtifactMetadata, TurnState } from "./types.ts";
import { resolveRemoteRepoPathFromLocalInput } from "../../lib/pi-diff-review-ssh.ts";
import type { PiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

function noteForTurn(hasBashCalls: boolean, touchedPaths: number, patchText: string): string | undefined {
  const notes: string[] = [];
  if (hasBashCalls) notes.push("bash calls occurred; non-edit/write file changes may not be fully attributed.");
  if (touchedPaths === 0) notes.push("No agent-touched repo paths were recorded for the last turn.");
  else if (!patchText.trim()) notes.push("Agent-touched paths had no net diff at turn end.");
  return notes.length ? notes.join(" ") : undefined;
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

  startTurn({
    sessionId,
    turnId,
    cwd,
    ssh,
  }: {
    sessionId: string;
    turnId: string;
    cwd: string;
    ssh?: SshTurnContext;
  }): void {
    this.ssh = ssh ?? null;
    this.scopeKey = ssh?.scopeKey;
    this.allowRepoRootWrites = !ssh;

    const cwdRepoRoot = ssh?.repoRoot ?? findCwdRepoRoot(cwd);

    this.current = {
      sessionId,
      turnId,
      startedAt: new Date().toISOString(),
      cwdRepoRoot,
      hasBashCalls: false,
      repos: new Map(),
    };
  }

  reset(): void {
    this.current = null;
    this.ssh = null;
    this.scopeKey = undefined;
    this.allowRepoRootWrites = true;
  }

  private ensureTurn(cwd: string, sessionId = "", turnId = `turn-${Date.now()}`): TurnState {
    if (!this.current) this.startTurn({ sessionId, turnId, cwd });
    return this.current as TurnState;
  }

  private ensureRepo(repoRoot: string, repoKey: string): RepoTurnState {
    const turn = this.current as TurnState;
    const existing = turn.repos.get(repoRoot);
    if (existing) return existing;

    // Enforce single-repo semantics: only allow the cwd repo root.
    if (turn.cwdRepoRoot && repoRoot !== turn.cwdRepoRoot) {
      return {
        repoRoot,
        repoKey,
        touchedPaths: new Map(),
        capturedBytes: 0,
      };
    }

    const repoState: RepoTurnState = {
      repoRoot,
      repoKey,
      touchedPaths: new Map(),
      capturedBytes: 0,
    };
    turn.repos.set(repoRoot, repoState);
    return repoState;
  }

  async touchPath(rawPath: string, cwd: string): Promise<void> {
    const turn = this.ensureTurn(cwd);
    if (!turn.cwdRepoRoot) return;

    if (this.ssh) {
      const resolved = resolveRemoteRepoPathFromLocalInput(this.ssh.session, this.ssh.repoRoot, cwd, rawPath);
      if (!resolved) return;
      if (turn.cwdRepoRoot !== this.ssh.repoRoot) return;

      const repoKey = repoKeyForRoot(this.ssh.repoRoot);
      const repo = this.ensureRepo(this.ssh.repoRoot, repoKey);
      if (!turn.repos.has(this.ssh.repoRoot)) return;

      if (repo.touchedPaths.has(resolved.repoRelPath)) return;
      const baseline = await captureFileImageRemote(repo, this.ssh.session, this.ssh.repoRoot, resolved.repoRelPath, "pre");
      repo.touchedPaths.set(resolved.repoRelPath, {
        repoRelPath: resolved.repoRelPath,
        absolutePath: resolved.absolutePath,
        baseline,
      });
      return;
    }

    const resolved = resolveRepoPath(rawPath, cwd);
    if (!resolved) return;
    if (turn.cwdRepoRoot !== resolved.repoRoot) return;

    const repo = this.ensureRepo(resolved.repoRoot, resolved.repoKey);
    if (!turn.repos.has(resolved.repoRoot)) return;

    if (repo.touchedPaths.has(resolved.repoRelPath)) return;
    const baseline = captureFileImage(repo, resolved.absolutePath, "pre");
    repo.touchedPaths.set(resolved.repoRelPath, {
      repoRelPath: resolved.repoRelPath,
      absolutePath: resolved.absolutePath,
      baseline,
    });
  }

  async recordBash(command: string, cwd: string): Promise<void> {
    const turn = this.ensureTurn(cwd);
    turn.hasBashCalls = true;
    for (const absolutePath of snoopedBashPaths(command, cwd)) {
      await this.touchPath(absolutePath, cwd);
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
    const ssh = this.ssh;
    this.current = null;
    this.ssh = null;
    if (!turn) return;

    const repoArtifacts: RepoTurnArtifact[] = [];
    for (const repo of turn.repos.values()) {
      if (turn.cwdRepoRoot && repo.repoRoot !== turn.cwdRepoRoot) continue;

      for (const tracked of repo.touchedPaths.values()) {
        if (ssh) {
          tracked.final = await captureFileImageRemote(repo, ssh.session, ssh.repoRoot, tracked.repoRelPath, "post");
        } else {
          tracked.final = captureFileImage(repo, tracked.absolutePath, "post");
        }
      }

      const built = buildRepoPatch(repo);
      const metadata = await this.attachAgentChangeReport({
        saved_at: new Date().toISOString(),
        session_id: turn.sessionId,
        turn_id: turn.turnId,
        source: "last_turn_agent_touched",
        review_source: "last turn (agent-touched)",
        repo_root: repo.repoRoot,
        repo_key: repo.repoKey,
        touched_paths: [...repo.touchedPaths.keys()].sort(),
        observed_changed_paths: built.observedChangedPaths,
        has_bash_calls: turn.hasBashCalls,
        note: noteForTurn(turn.hasBashCalls, repo.touchedPaths.size, built.patchText),
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
        source: "last_turn_agent_touched",
        review_source: "last turn (agent-touched)",
        repo_root: cwdRepoRoot,
        repo_key: repoKeyForRoot(cwdRepoRoot),
        touched_paths: [],
        observed_changed_paths: [],
        has_bash_calls: turn.hasBashCalls,
        note: noteForTurn(turn.hasBashCalls, 0, ""),
        workspace: false as const,
      }, "");

      writeEmptyLatestArtifact({
        repoRoot: cwdRepoRoot,
        repoKey: repoKeyForRoot(cwdRepoRoot),
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        note: emptyMetadata.note,
        hasBashCalls: turn.hasBashCalls,
        agentChangeReport: emptyMetadata.agent_change_report,
        scopeKey: this.scopeKey,
        allowRepoRoot: this.allowRepoRootWrites,
      });
    }

    this.scopeKey = undefined;
    this.allowRepoRootWrites = true;
  }
}
