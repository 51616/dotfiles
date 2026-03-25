import { captureFileImage } from "./files.ts";
import { buildRepoPatch, buildWorkspaceArtifact, writeEmptyLatestArtifact, writeRepoArtifacts } from "./artifacts.ts";
import { snoopedBashPaths } from "./bash-snoop.ts";
import { findCwdRepoRoot, repoKeyForRoot, resolveRepoPath } from "./repo.ts";
import type { RepoTurnArtifact, RepoTurnState, TurnState } from "./types.ts";

function noteForTurn(hasBashCalls: boolean, touchedPaths: number, patchText: string): string | undefined {
  const notes: string[] = [];
  if (hasBashCalls) notes.push("bash calls occurred; non-edit/write file changes may not be fully attributed.");
  if (touchedPaths === 0) notes.push("No agent-touched repo paths were recorded for the last turn.");
  else if (!patchText.trim()) notes.push("Agent-touched paths had no net diff at turn end.");
  return notes.length ? notes.join(" ") : undefined;
}

export class DiffReviewTurnTracker {
  private current: TurnState | null = null;

  startTurn({ sessionId, turnId, cwd }: { sessionId: string; turnId: string; cwd: string }): void {
    this.current = {
      sessionId,
      turnId,
      startedAt: new Date().toISOString(),
      cwdRepoRoot: findCwdRepoRoot(cwd),
      hasBashCalls: false,
      repos: new Map(),
    };
  }

  reset(): void {
    this.current = null;
  }

  private ensureTurn(cwd: string, sessionId = "", turnId = `turn-${Date.now()}`): TurnState {
    if (!this.current) this.startTurn({ sessionId, turnId, cwd });
    return this.current as TurnState;
  }

  private ensureRepo(repoRoot: string, repoKey: string): RepoTurnState {
    const turn = this.current as TurnState;
    const existing = turn.repos.get(repoRoot);
    if (existing) return existing;
    const repoState: RepoTurnState = {
      repoRoot,
      repoKey,
      touchedPaths: new Map(),
      capturedBytes: 0,
    };
    turn.repos.set(repoRoot, repoState);
    return repoState;
  }

  touchPath(rawPath: string, cwd: string): void {
    const turn = this.ensureTurn(cwd);
    const resolved = resolveRepoPath(rawPath, cwd);
    if (!resolved) return;
    const repo = this.ensureRepo(resolved.repoRoot, resolved.repoKey);
    if (repo.touchedPaths.has(resolved.repoRelPath)) return;
    const baseline = captureFileImage(repo, resolved.absolutePath, "pre");
    repo.touchedPaths.set(resolved.repoRelPath, {
      repoRelPath: resolved.repoRelPath,
      absolutePath: resolved.absolutePath,
      baseline,
    });
  }

  recordBash(command: string, cwd: string): void {
    const turn = this.ensureTurn(cwd);
    turn.hasBashCalls = true;
    for (const absolutePath of snoopedBashPaths(command, cwd)) {
      this.touchPath(absolutePath, "/");
    }
  }

  finalize(cwd: string): void {
    const turn = this.current;
    this.current = null;
    if (!turn) return;

    const repoArtifacts: RepoTurnArtifact[] = [];
    for (const repo of turn.repos.values()) {
      for (const tracked of repo.touchedPaths.values()) {
        tracked.final = captureFileImage(repo, tracked.absolutePath, "post");
      }
      const built = buildRepoPatch(repo);
      repoArtifacts.push({
        repoRoot: repo.repoRoot,
        repoKey: repo.repoKey,
        patchText: built.patchText,
        metadata: {
          saved_at: new Date().toISOString(),
          session_id: turn.sessionId,
          turn_id: turn.turnId,
          source: "last_turn_agent_touched",
          review_source: "last turn (agent-touched)",
          repo_root: repo.repoRoot,
          repo_key: repo.repoKey,
          touched_paths: [...repo.touchedPaths.keys()].sort(),
          has_bash_calls: turn.hasBashCalls,
          note: noteForTurn(turn.hasBashCalls, repo.touchedPaths.size, built.patchText),
          omitted_paths: built.omittedPaths,
          workspace: false,
        },
      });
    }

    const workspace = repoArtifacts.length > 1
      ? buildWorkspaceArtifact({
        repoArtifacts,
        savedAt: new Date().toISOString(),
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        hasBashCalls: turn.hasBashCalls,
      })
      : null;

    for (const artifact of repoArtifacts) {
      writeRepoArtifacts({ repoArtifact: artifact, workspace });
    }

    const cwdRepoRoot = turn.cwdRepoRoot ?? findCwdRepoRoot(cwd);
    if (cwdRepoRoot && !turn.repos.has(cwdRepoRoot)) {
      writeEmptyLatestArtifact({
        repoRoot: cwdRepoRoot,
        repoKey: repoKeyForRoot(cwdRepoRoot),
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        note: noteForTurn(turn.hasBashCalls, 0, ""),
        hasBashCalls: turn.hasBashCalls,
      });
    }
  }
}
