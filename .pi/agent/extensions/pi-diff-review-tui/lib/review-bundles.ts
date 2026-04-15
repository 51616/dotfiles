import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildBundleFromPatchText } from "./git.ts";
import { getLatestTurnBundle } from "./turn-bundle.ts";
import type { DiffBundle, ReviewMode } from "./types.ts";
import type { DiffReviewRepoIdentity } from "./backend.ts";
import { getTurnBundleWithAgentReport, getWorkspaceBundle } from "./backend.ts";

export function noTurnDiffMessage(): string {
  return "No last-turn repo snapshot diff was found for this session; falling back to workspace vs HEAD.";
}

function localIdentityFromRepoRoot(repoRoot: string): DiffReviewRepoIdentity {
  return {
    backend: "local",
    repoRoot,
    scopeKey: repoRoot,
    allowRepoRootWrites: true,
    repoLabel: repoRoot,
  };
}

export async function getDiffBundle(
  pi: ExtensionAPI,
  identityOrRepoRoot: DiffReviewRepoIdentity | string,
  mode: ReviewMode,
  options?: { sessionId?: string },
): Promise<DiffBundle> {
  const identity = typeof identityOrRepoRoot === "string" ? localIdentityFromRepoRoot(identityOrRepoRoot) : identityOrRepoRoot;
  if (mode === "t") {
    const bundle = await getLatestTurnBundle(pi, identity.repoRoot, options?.sessionId ?? "", {
      scopeKey: identity.scopeKey,
      allowRepoRoot: identity.allowRepoRootWrites,
    });
    if (bundle) return getTurnBundleWithAgentReport(pi, identity, bundle);
    return buildBundleFromPatchText({
      scope: "t",
      repoRoot: identity.repoRoot,
      head: null,
      patchTextRaw: "",
      sourceKind: "turn",
      turnMetadata: null,
    });
  }

  return getWorkspaceBundle(pi, identity);
}

export async function resolveInitialBundleSelection(
  pi: ExtensionAPI,
  identityOrRepoRoot: DiffReviewRepoIdentity | string,
  sessionId: string,
): Promise<{ initialMode: ReviewMode; initialBundle: DiffBundle; notification?: string }> {
  const identity = typeof identityOrRepoRoot === "string" ? localIdentityFromRepoRoot(identityOrRepoRoot) : identityOrRepoRoot;
  const turnBundle = await getLatestTurnBundle(pi, identity.repoRoot, sessionId, {
    scopeKey: identity.scopeKey,
    allowRepoRoot: identity.allowRepoRootWrites,
  });
  if (turnBundle?.files.length) {
    return { initialMode: "t", initialBundle: await getTurnBundleWithAgentReport(pi, identity, turnBundle) };
  }

  const workspaceBundle = await getWorkspaceBundle(pi, identity);
  if (workspaceBundle.files.length) {
    return {
      initialMode: "a",
      initialBundle: workspaceBundle,
      notification: turnBundle?.turnMetadata?.note || noTurnDiffMessage(),
    };
  }

  return {
    initialMode: "a",
    initialBundle: workspaceBundle,
    notification: turnBundle?.turnMetadata?.note || "No diff to review in last turn or workspace vs HEAD.",
  };
}
