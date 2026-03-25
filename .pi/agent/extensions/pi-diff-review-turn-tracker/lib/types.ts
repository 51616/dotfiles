export const MAX_FILE_BYTES_FOR_CONTENT = 1_048_576;
export const MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO = 20_971_520;
export const MAX_TOUCHED_PATHS_PER_REPO = 500;

export type OmitReason = "too_large" | "binary" | "read_error_pre" | "read_error_post" | "total_cap_exceeded";

export interface MissingImage {
  kind: "missing";
  exists: false;
}

export interface ContentImage {
  kind: "content";
  exists: true;
  text: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

export interface OmittedImage {
  kind: "omitted";
  exists: boolean;
  reason: OmitReason;
  sizeBytes?: number;
  mtimeMs?: number;
  sha256?: string;
}

export type FileImage = MissingImage | ContentImage | OmittedImage;

export interface OmittedPathInfo {
  reason: OmitReason;
  size_bytes?: number;
}

export interface TrackedPathState {
  repoRelPath: string;
  absolutePath: string;
  baseline: FileImage;
  final?: FileImage;
}

export interface RepoTurnState {
  repoRoot: string;
  repoKey: string;
  touchedPaths: Map<string, TrackedPathState>;
  capturedBytes: number;
}

export interface RepoTurnArtifactMetadata {
  saved_at: string;
  session_id: string;
  turn_id: string;
  source: "last_turn_agent_touched";
  review_source: "last turn (agent-touched)";
  repo_root: string;
  repo_key: string;
  touched_paths: string[];
  has_bash_calls: boolean;
  note?: string;
  omitted_paths?: Record<string, OmittedPathInfo>;
  workspace?: false;
  repos?: undefined;
}

export interface WorkspaceRepoSummary {
  repo_key: string;
  repo_root: string;
  touched_paths: string[];
  omitted_paths?: Record<string, OmittedPathInfo>;
}

export interface WorkspaceTurnArtifactMetadata {
  saved_at: string;
  session_id: string;
  turn_id: string;
  source: "last_turn_agent_touched";
  review_source: "last turn (agent-touched)";
  repo_root: "workspace";
  repo_key: "workspace";
  touched_paths: string[];
  has_bash_calls: boolean;
  note?: string;
  omitted_paths?: Record<string, OmittedPathInfo>;
  workspace: true;
  repos: WorkspaceRepoSummary[];
}

export type TurnArtifactMetadata = RepoTurnArtifactMetadata | WorkspaceTurnArtifactMetadata;

export interface RepoTurnArtifact {
  repoRoot: string;
  repoKey: string;
  patchText: string;
  metadata: RepoTurnArtifactMetadata;
}

export interface TurnState {
  sessionId: string;
  turnId: string;
  startedAt: string;
  cwdRepoRoot: string | null;
  hasBashCalls: boolean;
  repos: Map<string, RepoTurnState>;
}
