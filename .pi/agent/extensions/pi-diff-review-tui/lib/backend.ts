import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildBundleFromPatchText, getRepoRoot as getLocalRepoRoot, parseNameStatus } from "./git.ts";
import { getWorkspaceReviewBundle as getLocalWorkspaceBundle } from "./live-repo-bundle.ts";
import type { DiffBundle } from "./types.ts";
import { enrichTurnBundleWithAgentReport } from "./turn-agent-report.ts";
import {
  applyReverse as applyRemoteReverse,
  diffWorkspace as getRemoteWorkspaceDiff,
  patchForPath as getRemotePatchForPath,
  resolveDiffReviewSshIdentity,
  type DiffReviewSshIdentity,
} from "../../lib/pi-diff-review-ssh.ts";

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
  ssh?: DiffReviewSshIdentity;
};

function summarizeBundle(bundle: DiffBundle): string {
  const fileCount = bundle.files.length;
  const headLabel = bundle.head ? ` head=${bundle.head.slice(0, 12)}` : " head=(unborn)";
  return `${bundle.sourceKind}:${fileCount} file${fileCount === 1 ? "" : "s"}${headLabel}`;
}

function requireSshIdentity(identity: DiffReviewRepoIdentity): DiffReviewSshIdentity {
  if (!identity.ssh) {
    throw new Error("SSH backend unavailable: missing resolved pi-ssh session identity.");
  }
  return identity.ssh;
}

export async function resolveRepoIdentity(_pi: ExtensionAPI, localCwd: string): Promise<DiffReviewRepoIdentity> {
  const ssh = await resolveDiffReviewSshIdentity(localCwd);
  if (ssh) {
    return {
      backend: "ssh",
      repoRoot: ssh.repoRoot,
      scopeKey: ssh.scopeKey,
      allowRepoRootWrites: false,
      repoLabel: ssh.repoLabel,
      ssh,
    };
  }

  return resolveLocalRepoIdentity(_pi, localCwd);
}

export async function resolveLocalRepoIdentity(pi: ExtensionAPI, localCwd: string): Promise<DiffReviewRepoIdentity> {
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
    return getLocalWorkspaceBundle(pi, identity.repoRoot);
  }

  const ssh = requireSshIdentity(identity);
  const result = await getRemoteWorkspaceDiff(ssh.session, identity.repoRoot);
  return buildBundleFromPatchText({
    scope: "a",
    repoRoot: identity.repoRoot,
    head: result.head,
    patchTextRaw: result.patchText,
    nameStatusEntries: parseNameStatus(result.nameStatus),
    sourceKind: "git",
  });
}

export async function getTurnBundleWithAgentReport(
  pi: ExtensionAPI,
  identity: DiffReviewRepoIdentity,
  bundle: DiffBundle,
): Promise<DiffBundle> {
  if (identity.backend === "ssh") {
    const ssh = identity.ssh;
    if (!ssh) {
      return bundle;
    }
    return enrichTurnBundleWithAgentReport(pi, bundle, {
      currentRepoPatchForPath: async ({ repoRoot, repoRelPath }) => {
        try {
          return await getRemotePatchForPath(ssh.session, repoRoot, repoRelPath);
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
    const ssh = requireSshIdentity(identity);
    return applyRemoteReverse(ssh.session, identity.repoRoot, patchText, "auto");
  }

  // Local backend uses existing git apply implementation in rejected-hunks.ts.
  // This method is unused in local mode; call sites should keep using the local path.
  const result = await pi.exec("git", ["status"], { cwd: identity.repoRoot });
  if (result.code !== 0) {
    return { ok: false, strategyUsed: null, output: result.stderr.trim() || result.stdout.trim() || "git status failed" };
  }
  return { ok: true, strategyUsed: null, output: "" };
}

export async function buildDiffReviewDebugReport(pi: ExtensionAPI, localCwd: string): Promise<string> {
  const lines: string[] = [
    "[pi-diff-review debug]",
    `local cwd: ${localCwd}`,
  ];

  try {
    const localIdentity = await resolveLocalRepoIdentity(pi, localCwd);
    const localBundle = await getLocalWorkspaceBundle(pi, localIdentity.repoRoot);
    lines.push(`local repo root: ${localIdentity.repoRoot}`);
    lines.push(`local behavior: ${summarizeBundle(localBundle)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`local behavior: error (${message})`);
  }

  const ssh = await resolveDiffReviewSshIdentity(localCwd).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`remote behavior: error (${message})`);
    return null;
  });

  if (!ssh) {
    if (!lines.some((line) => line.startsWith("remote behavior:"))) {
      lines.push("remote behavior: no active pi-ssh session");
    }
    return lines.join("\n");
  }

  const portSuffix = ssh.connection.port && ssh.connection.port !== 22 ? `:${ssh.connection.port}` : "";
  lines.push(`remote target: ${ssh.connection.remote}${portSuffix}`);
  lines.push(`mapped remote cwd: ${ssh.remoteCwd}`);
  lines.push(`remote repo root: ${ssh.repoRoot}`);
  lines.push(`remote scope key: ${ssh.scopeKey}`);

  try {
    const remoteBundle = await getWorkspaceBundle(pi, {
      backend: "ssh",
      repoRoot: ssh.repoRoot,
      scopeKey: ssh.scopeKey,
      allowRepoRootWrites: false,
      repoLabel: ssh.repoLabel,
      ssh,
    });
    lines.push(`remote behavior: ${summarizeBundle(remoteBundle)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`remote behavior: error (${message})`);
  }

  return lines.join("\n");
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
}
