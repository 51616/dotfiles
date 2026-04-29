import test from "node:test";
import assert from "node:assert/strict";
import { readGitState } from "../index.ts";

function createPiStub() {
  return {
    async exec() {
      throw new Error("local git should not be used while pi-ssh is active");
    },
  };
}

test("readGitState reads remote git state from the active pi-ssh session", async () => {
  const commands = [];
  const repoRootCalls = [];
  const session = {
    getConnectionInfo() {
      return { kind: "ssh", remote: "gpu", port: 22, remoteCwd: "/remote/project" };
    },
    mapLocalPathToRemote(localPath) {
      return localPath === "/local/project" ? "/remote/project" : localPath;
    },
    async repoRoot(remoteCwd) {
      repoRootCalls.push(remoteCwd);
      return remoteCwd === "/remote/project/subdir" ? "/remote/project" : null;
    },
    async execText(command) {
      commands.push(command);
      if (command.includes("branch") && command.includes("--show-current")) {
        return { output: "main\n", exitCode: 0, timedOut: false, aborted: false };
      }
      if (command.includes("status") && command.includes("--porcelain")) {
        return { output: " M src/a.ts\n?? src/b.ts\n", exitCode: 0, timedOut: false, aborted: false };
      }
      if (command.includes("diff") && command.includes("--numstat")) {
        return { output: "3\t1\tsrc/a.ts\n", exitCode: 0, timedOut: false, aborted: false };
      }
      if (command.includes("ls-files") && command.includes("--others")) {
        return { output: '{"additions":5,"capped":false}\n', exitCode: 0, timedOut: false, aborted: false };
      }
      return { output: "", exitCode: 1, timedOut: false, aborted: false };
    },
  };

  const snapshot = await readGitState(createPiStub(), "/local/project", {
    getActiveSession: () => session,
    getRemoteFooterSnapshot: () => ({ remoteCwd: "/remote/project/subdir" }),
  });

  assert.deepEqual(repoRootCalls, ["/remote/project/subdir"]);
  assert.deepEqual(snapshot, {
    branchName: "main",
    files: 2,
    additions: 8,
    deletions: 1,
    additionsUnknown: false,
    repoRoot: "/remote/project",
  });
  assert.ok(
    commands
      .filter((command) => command.includes("git --no-optional-locks"))
      .every((command) => command.startsWith("cd -- '/remote/project' && git --no-optional-locks ")),
  );
  assert.ok(commands.some((command) => command.includes("git\", \"--no-optional-locks\", \"ls-files")));
});

test("readGitState marks additions partial when untracked line counting hits the cap", async () => {
  const session = {
    getConnectionInfo() {
      return { kind: "ssh", remote: "gpu", port: 22, remoteCwd: "/remote/project" };
    },
    mapLocalPathToRemote(localPath) {
      return localPath === "/local/project" ? "/remote/project" : localPath;
    },
    async repoRoot() {
      return "/remote/project";
    },
    async execText(command) {
      if (command.includes("branch") && command.includes("--show-current")) {
        return { output: "main\n", exitCode: 0, timedOut: false, aborted: false };
      }
      if (command.includes("status") && command.includes("--porcelain")) {
        return { output: "?? generated.json\n", exitCode: 0, timedOut: false, aborted: false };
      }
      if (command.includes("diff") && command.includes("--numstat")) {
        return { output: "3\t1\tsrc/a.ts\n", exitCode: 0, timedOut: false, aborted: false };
      }
      if (command.includes("ls-files") && command.includes("--others")) {
        return { output: '{"additions":0,"capped":true}\n', exitCode: 0, timedOut: false, aborted: false };
      }
      return { output: "", exitCode: 1, timedOut: false, aborted: false };
    },
  };

  const snapshot = await readGitState(createPiStub(), "/local/project", {
    getActiveSession: () => session,
    getRemoteFooterSnapshot: () => null,
  });

  assert.deepEqual(snapshot, {
    branchName: "main",
    files: 1,
    additions: 3,
    deletions: 1,
    additionsUnknown: true,
    repoRoot: "/remote/project",
  });
});

test("readGitState falls back to mapped remote cwd when no pi-ssh footer snapshot exists", async () => {
  const repoRootCalls = [];
  const session = {
    getConnectionInfo() {
      return { kind: "ssh", remote: "gpu", port: 22, remoteCwd: "/remote/fallback" };
    },
    mapLocalPathToRemote(localPath) {
      return localPath === "/local/project" ? "/remote/project" : localPath;
    },
    async repoRoot(remoteCwd) {
      repoRootCalls.push(remoteCwd);
      return null;
    },
    async execText() {
      throw new Error("git command should not run outside a remote repo");
    },
  };

  const snapshot = await readGitState(createPiStub(), "/local/project", {
    getActiveSession: () => session,
    getRemoteFooterSnapshot: () => null,
  });

  assert.deepEqual(repoRootCalls, ["/remote/project"]);
  assert.equal(snapshot, null);
});
