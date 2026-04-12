import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRepoRoot as getLocalRepoRoot, parseNameStatus, buildBundleFromPatchText } from "./git.ts";
import { getWorkspaceReviewBundle as getLocalWorkspaceBundle } from "./live-repo-bundle.ts";
import type { DiffBundle } from "./types.ts";
import { enrichTurnBundleWithAgentReport } from "./turn-agent-report.ts";
import { DiffReviewSshHelperClient, disposeSharedSshHelperClient, getSharedSshHelperClient, makeSshScopeKey } from "../../lib/diff-review-ssh-helper/client.ts";

export type DiffReviewBackendKind = "local" | "ssh";

export type DiffReviewRepoIdentity = {
  backend: DiffReviewBackendKind;
  /** Actual repo root (local path or remote path) used for display and git operations. */
  repoRoot: string;
  /** Stable identifier used only for local storage paths. */
  scopeKey: string;
  /** Whether repo-local writes (repoRoot/.pi/diff-review) are allowed. */
  allowRepoRootWrites: boolean;
  /** Optional label to show in the diff-review header. */
  repoLabel: string;
  helper?: DiffReviewSshHelperClient;
};

export const DEFAULT_DIFF_LIMITS = {
  maxPatchBytesPerFile: 512 * 1024,
  maxTotalPatchBytes: 10 * 1024 * 1024,
  maxFiles: 800,
} as const;

async function withReconnectedSshHelper<T>(
  pi: ExtensionAPI,
  identity: { helper?: DiffReviewSshHelperClient } | null,
  action: (helper: DiffReviewSshHelperClient) => Promise<T>,
  options?: { retryOnce?: boolean },
): Promise<{ helper: DiffReviewSshHelperClient; value: T }> {
  const primary = identity?.helper ?? (await getSharedSshHelperClient(pi));
  if (!primary) throw new Error("SSH backend unavailable: missing --ssh flags");

  try {
    return { helper: primary, value: await action(primary) };
  } catch (error) {
    if (options?.retryOnce === false) throw error;

    // One-shot reconnect attempt.
    disposeSharedSshHelperClient();
    const secondary = await getSharedSshHelperClient(pi);
    if (!secondary) throw error;

    if (identity) identity.helper = secondary;
    return { helper: secondary, value: await action(secondary) };
  }
}

export async function resolveRepoIdentity(pi: ExtensionAPI, localCwd: string): Promise<DiffReviewRepoIdentity> {
  const flagsHelper = await getSharedSshHelperClient(pi);
  if (flagsHelper) {
    const { helper, value: repoRoot } = await withReconnectedSshHelper(pi, { helper: flagsHelper }, (h) => h.repoRoot(h.probe.remote_cwd));
    const scopeKey = makeSshScopeKey(helper.target, repoRoot);
    const portSuffix = helper.target.port && helper.target.port !== 22 ? `:${helper.target.port}` : "";
    const repoLabel = `SSH ${helper.target.remote}${portSuffix} ${repoRoot}`;
    return {
      backend: "ssh",
      repoRoot,
      scopeKey,
      allowRepoRootWrites: false,
      repoLabel,
      helper,
    };
  }

  const repoRoot = await getLocalRepoRoot(pi, localCwd);
  return {
    backend: "local",
    repoRoot,
    scopeKey: repoRoot,
    allowRepoRootWrites: true,
    repoLabel: repoRoot,
  };
}

export async function getWorkspaceBundle(pi: ExtensionAPI, identity: DiffReviewRepoIdentity): Promise<DiffBundle> {
  if (identity.backend === "local") {
    const bundle = await getLocalWorkspaceBundle(pi, identity.repoRoot);
    return bundle;
  }

  const { value: result } = await withReconnectedSshHelper(pi, identity, (helper) =>
    helper.diffWorkspace({
      repoRoot: identity.repoRoot,
      limits: {
        max_patch_bytes_per_file: DEFAULT_DIFF_LIMITS.maxPatchBytesPerFile,
        max_total_patch_bytes: DEFAULT_DIFF_LIMITS.maxTotalPatchBytes,
        max_files: DEFAULT_DIFF_LIMITS.maxFiles,
      },
    }),
  );

  const nameStatusEntries = parseNameStatus(result.nameStatus);
  const bundle = buildBundleFromPatchText({
    scope: "a",
    repoRoot: identity.repoRoot,
    head: result.head,
    patchTextRaw: result.patchText,
    nameStatusEntries,
    sourceKind: "git",
  });

  const omittedCount = Object.keys(result.omittedPaths ?? {}).length;
  if (omittedCount > 0) {
    (bundle as DiffBundle & { warnings?: string[] }).warnings = [
      `Diff omitted for ${omittedCount} file${omittedCount === 1 ? "" : "s"} due to per-file/total size limits.`,
    ];
  }

  return bundle;
}

export async function getTurnBundleWithAgentReport(
  pi: ExtensionAPI,
  identity: DiffReviewRepoIdentity,
  bundle: DiffBundle,
): Promise<DiffBundle> {
  if (identity.backend === "ssh") {
    return enrichTurnBundleWithAgentReport(pi, bundle, {
      currentRepoPatchForPath: async ({ repoRoot, repoRelPath }) => {
        try {
          const { value } = await withReconnectedSshHelper(pi, identity, (helper) =>
            helper.patchForPath({ repoRoot, repoRelPath }),
          );
          return value;
        } catch {
          return "";
        }
      },
    });
  }

  return enrichTurnBundleWithAgentReport(pi, bundle);
}

export async function applyReversePatch(
  pi: ExtensionAPI,
  identity: DiffReviewRepoIdentity,
  patchText: string,
): Promise<{ ok: boolean; strategyUsed: "direct" | "3way" | null; output: string }> {
  if (identity.backend === "ssh") {
    // WARNING: This call mutates the remote working tree.
    // Do not auto-retry on reconnect; it is not safe/idempotent.
    const helper = await getSharedSshHelperClient(pi);
    if (!helper) throw new Error("SSH backend unavailable: missing --ssh flags");
    return helper.applyReverse({ repoRoot: identity.repoRoot, patchText, strategy: "auto" });
  }

  // Local backend uses existing git apply implementation in rejected-hunks.ts.
  // This method is unused in local mode; call sites should keep using the local path.
  const result = await pi.exec("git", ["status"], { cwd: identity.repoRoot });
  if (result.code !== 0) {
    return { ok: false, strategyUsed: null, output: result.stderr.trim() || result.stdout.trim() || "git status failed" };
  }
  return { ok: true, strategyUsed: null, output: "" };
}

let sshReverseApplyConsent: boolean | null = null;

export function getSshReverseApplyConsent(): boolean | null {
  return sshReverseApplyConsent;
}

export function setSshReverseApplyConsent(value: boolean): void {
  sshReverseApplyConsent = value;
}

export function disposeDiffReviewSshBackend(): void {
  sshReverseApplyConsent = null;
  disposeSharedSshHelperClient();
}
