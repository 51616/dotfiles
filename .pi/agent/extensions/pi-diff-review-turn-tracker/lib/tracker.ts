// @lat: [[pi-diff-review-turn-tracker#Turn lifecycle and artifact contract]]

import { buildPersistedAgentChangeReport, summarizeAgentChangeArtifact } from "./agent-change-report.ts";
import { writeEmptyLatestArtifact, writeRepoArtifacts } from "./artifacts.ts";
import { findCwdRepoRoot, repoKeyForRoot } from "./repo.ts";
import {
  captureLocalWorkspaceTree,
  captureRemoteWorkspaceTree,
  diffLocalWorkspaceTrees,
  diffRemoteWorkspaceTrees,
} from "./workspace-tree.ts";
import type { AgentChangeReport, RepoTurnArtifact, TurnArtifactMetadata } from "./types.ts";
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

type TurnState = {
  sessionId: string;
  turnId: string;
  startedAt: string;
  cwdRepoRoot: string | null;
  repoKey: string | null;
  startTree: string | null;
  prepError: Error | null;
  prepPromise: Promise<void>;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

  startTurn({
    sessionId,
    turnId,
    cwd,
    ssh,
    sshResolver,
    requireSsh,
  }: {
    sessionId: string;
    turnId: string;
    cwd: string;
    ssh?: SshTurnContext;
    sshResolver?: () => Promise<SshTurnContext | null>;
    requireSsh?: boolean;
  }): void {
    this.reset();
    const turn: TurnState = {
      sessionId,
      turnId,
      startedAt: new Date().toISOString(),
      cwdRepoRoot: null,
      repoKey: null,
      startTree: null,
      prepError: null,
      prepPromise: Promise.resolve(),
    };
    this.current = turn;
    turn.prepPromise = this.prepareTurn(turn, {
      cwd,
      ssh,
      sshResolver,
      requireSsh: requireSsh ?? false,
    });
  }

  private async prepareTurn(
    turn: TurnState,
    options: {
      cwd: string;
      ssh?: SshTurnContext;
      sshResolver?: () => Promise<SshTurnContext | null>;
      requireSsh: boolean;
    },
  ): Promise<void> {
    try {
      const resolvedSsh = options.sshResolver
        ? await options.sshResolver()
        : (options.ssh ?? null);
      if (this.current !== turn) return;
      if (options.requireSsh && !resolvedSsh) {
        turn.prepError = new Error("SSH diff-review tracking could not resolve the remote repo.");
        return;
      }

      this.ssh = resolvedSsh;
      this.scopeKey = resolvedSsh?.scopeKey;
      this.allowRepoRootWrites = !resolvedSsh;

      const cwdRepoRoot = resolvedSsh?.repoRoot ?? findCwdRepoRoot(options.cwd);
      const repoKey = cwdRepoRoot ? repoKeyForRoot(cwdRepoRoot) : null;
      const startTree = cwdRepoRoot
        ? (resolvedSsh
          ? await captureRemoteWorkspaceTree(resolvedSsh.session, cwdRepoRoot)
          : captureLocalWorkspaceTree(cwdRepoRoot))
        : null;
      if (this.current !== turn) return;

      turn.cwdRepoRoot = cwdRepoRoot;
      turn.repoKey = repoKey;
      turn.startTree = startTree;
    } catch (error) {
      if (this.current !== turn) return;
      turn.prepError = asError(error);
    }
  }

  reset(): void {
    this.current = null;
    this.ssh = null;
    this.scopeKey = undefined;
    this.allowRepoRootWrites = true;
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

    try {
      await turn.prepPromise;
      if (turn.prepError) {
        console.warn(`[pi-diff-review-turn-tracker] startTurn failed: ${turn.prepError.message}`);
        return;
      }

      if (turn.cwdRepoRoot && turn.repoKey && turn.startTree) {
        const diff = this.ssh
          ? await diffRemoteWorkspaceTrees(this.ssh.session, turn.cwdRepoRoot, turn.startTree, await captureRemoteWorkspaceTree(this.ssh.session, turn.cwdRepoRoot))
          : diffLocalWorkspaceTrees(turn.cwdRepoRoot, turn.startTree, captureLocalWorkspaceTree(turn.cwdRepoRoot));

        const metadata = await this.attachAgentChangeReport({
          saved_at: new Date().toISOString(),
          session_id: turn.sessionId,
          turn_id: turn.turnId,
          source: "last_turn_repo_snapshot",
          review_source: "last turn (repo snapshot)",
          repo_root: turn.cwdRepoRoot,
          repo_key: turn.repoKey,
          touched_paths: diff.touchedPaths,
          observed_changed_paths: diff.touchedPaths,
          has_bash_calls: false,
          note: noteForTurn(diff.touchedPaths.length),
          workspace: false as const,
        }, diff.patchText);

        const artifact: RepoTurnArtifact = {
          repoRoot: turn.cwdRepoRoot,
          repoKey: turn.repoKey,
          patchText: diff.patchText,
          metadata,
        };

        writeRepoArtifacts({
          repoArtifact: artifact,
          scopeKey: this.scopeKey,
          allowRepoRoot: this.allowRepoRootWrites,
        });
        return;
      }

      const cwdRepoRoot = turn.cwdRepoRoot ?? findCwdRepoRoot(cwd);
      if (!cwdRepoRoot) return;

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
    } finally {
      this.current = null;
      this.ssh = null;
      this.scopeKey = undefined;
      this.allowRepoRootWrites = true;
    }
  }
}
