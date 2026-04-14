import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createPiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";
import {
  editRemoteFileViaLocalStage,
  resolveSshEditorStagePath,
} from "../lib/ssh-staged-editor.ts";

function makeRemoteRepo(prefix = "pi-diff-review-ssh-stage-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "tracked.ts"), "export const remote = 1;\n", "utf8");
  return dir;
}

function makeSession(remoteRoot) {
  return createPiSshSession({
    connection: {
      remote: "user@example.com",
      port: 2222,
      remoteCwd: remoteRoot,
      remoteHome: path.dirname(remoteRoot),
      localCwd: "/local/worktree",
      localHome: "/local",
    },
    transport: {
      exec: async () => ({ exitCode: 0 }),
      readFile: async (remotePath) => fs.promises.readFile(remotePath),
      writeFile: async (remotePath, content) => {
        await fs.promises.mkdir(path.dirname(remotePath), { recursive: true });
        await fs.promises.writeFile(remotePath, content);
      },
      ensureReadable: async () => {},
      ensureReadableWritable: async () => {},
      detectImageMimeType: async () => null,
      mkdir: async (remoteDir) => { await fs.promises.mkdir(remoteDir, { recursive: true }); },
    },
    execCapture: async (command, options = {}) => {
      const result = spawnSync("bash", ["-lc", command], {
        encoding: "buffer",
        input: options.stdin,
        timeout: (options.timeoutSeconds ?? 30) * 1000,
      });
      return {
        stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
        stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
        exitCode: typeof result.status === "number" ? result.status : null,
        timedOut: result.signal === "SIGTERM",
        aborted: false,
      };
    },
  });
}

function makeIdentity(remoteRoot) {
  return {
    session: makeSession(remoteRoot),
    connection: {
      kind: "ssh",
      remote: "user@example.com",
      port: 2222,
      remoteCwd: remoteRoot,
    },
    remoteCwd: remoteRoot,
    repoRoot: remoteRoot,
    scopeKey: `ssh:user@example.com:2222:${remoteRoot}`,
    repoLabel: `SSH user@example.com:2222 ${remoteRoot}`,
  };
}

function makeTui() {
  return {
    stop() {},
    start() {},
    requestRender() {},
  };
}

test("resolveSshEditorStagePath sanitizes session ids before building the local stage path", () => {
  const stagePath = resolveSshEditorStagePath({
    scopeKey: "ssh:user@example.com:2222:/remote/repo",
    sessionId: "../../odd/session",
    repoRelPath: "src\\tracked.ts",
  });

  assert.equal(stagePath.includes("../"), false);
  assert.equal(stagePath.includes("..\\"), false);
  assert.ok(stagePath.endsWith(path.join("sessions", "..__..__odd__session", "src", "tracked.ts")));
});

test("editRemoteFileViaLocalStage allocates a new local stage path when a recovery copy already exists", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-reuse-");
  const ssh = makeIdentity(remoteRoot);
  const sessionId = `session-${Date.now()}-reuse`;
  const originalStagePath = resolveSshEditorStagePath({ scopeKey: ssh.scopeKey, sessionId, repoRelPath: "src/tracked.ts" });
  fs.mkdirSync(path.dirname(originalStagePath), { recursive: true });
  fs.writeFileSync(originalStagePath, "preserved recovery copy\n", "utf8");

  const result = await editRemoteFileViaLocalStage({
    tui: makeTui(),
    ssh,
    sessionId,
    repoRelPath: "src/tracked.ts",
    lineTargeted: false,
    openEditor: ({ filePath }) => {
      fs.writeFileSync(filePath, "export const remote = 7;\n", "utf8");
      return { status: 0 };
    },
  });

  assert.notEqual(result.stagePath, originalStagePath);
  assert.equal(fs.readFileSync(originalStagePath, "utf8"), "preserved recovery copy\n");
  assert.equal(fs.readFileSync(path.join(remoteRoot, "src", "tracked.ts"), "utf8"), "export const remote = 7;\n");
});

test("editRemoteFileViaLocalStage uploads changed staged edits back to the remote file", async () => {
  const remoteRoot = makeRemoteRepo();
  const ssh = makeIdentity(remoteRoot);
  const sessionId = `session-${Date.now()}`;
  let seenStagePath = null;

  const result = await editRemoteFileViaLocalStage({
    tui: makeTui(),
    ssh,
    sessionId,
    repoRelPath: "src/tracked.ts",
    line: 1,
    lineTargeted: true,
    openEditor: ({ filePath }) => {
      seenStagePath = filePath;
      fs.writeFileSync(filePath, "export const remote = 2;\n", "utf8");
      return { status: 0 };
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.uploaded, true);
  assert.equal(result.conflict, false);
  assert.equal(fs.readFileSync(path.join(remoteRoot, "src", "tracked.ts"), "utf8"), "export const remote = 2;\n");
  assert.ok(seenStagePath);
  assert.equal(fs.existsSync(seenStagePath), false);
});

test("editRemoteFileViaLocalStage preserves executable mode bits on remote writeback", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-exec-");
  const targetPath = path.join(remoteRoot, "src", "tracked.ts");
  fs.chmodSync(targetPath, 0o755);
  const ssh = makeIdentity(remoteRoot);

  const result = await editRemoteFileViaLocalStage({
    tui: makeTui(),
    ssh,
    sessionId: `session-${Date.now()}-exec`,
    repoRelPath: "src/tracked.ts",
    lineTargeted: false,
    openEditor: ({ filePath }) => {
      fs.writeFileSync(filePath, "export const remote = 3;\n", "utf8");
      return { status: 0 };
    },
  });

  assert.equal(result.uploaded, true);
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o755);
});

test("editRemoteFileViaLocalStage leaves the remote file alone when the staged copy is unchanged", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-unchanged-");
  const ssh = makeIdentity(remoteRoot);
  const sessionId = `session-${Date.now()}-unchanged`;
  const stagePath = resolveSshEditorStagePath({ scopeKey: ssh.scopeKey, sessionId, repoRelPath: "src/tracked.ts" });

  const result = await editRemoteFileViaLocalStage({
    tui: makeTui(),
    ssh,
    sessionId,
    repoRelPath: "src/tracked.ts",
    lineTargeted: false,
    openEditor: () => ({ status: 0 }),
  });

  assert.equal(result.changed, false);
  assert.equal(result.uploaded, false);
  assert.equal(result.conflict, false);
  assert.equal(fs.readFileSync(path.join(remoteRoot, "src", "tracked.ts"), "utf8"), "export const remote = 1;\n");
  assert.equal(fs.existsSync(stagePath), false);
});

test("editRemoteFileViaLocalStage refuses binary-looking remote files", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-binary-");
  fs.writeFileSync(path.join(remoteRoot, "src", "tracked.ts"), Buffer.from([0x00, 0x61, 0x62, 0x63]));
  const ssh = makeIdentity(remoteRoot);

  await assert.rejects(
    () => editRemoteFileViaLocalStage({
      tui: makeTui(),
      ssh,
      sessionId: `session-${Date.now()}-binary`,
      repoRelPath: "src/tracked.ts",
      lineTargeted: false,
      openEditor: () => ({ status: 0 }),
    }),
    /Refusing to edit a binary-looking file over SSH/,
  );
});

test("editRemoteFileViaLocalStage refuses oversized remote files before staging", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-too-large-");
  fs.writeFileSync(path.join(remoteRoot, "src", "tracked.ts"), Buffer.alloc(4 * 1024 * 1024 + 2, 0x61));
  const ssh = makeIdentity(remoteRoot);

  await assert.rejects(
    () => editRemoteFileViaLocalStage({
      tui: makeTui(),
      ssh,
      sessionId: `session-${Date.now()}-too-large`,
      repoRelPath: "src/tracked.ts",
      lineTargeted: false,
      openEditor: () => ({ status: 0 }),
    }),
    /Remote file is too large to stage locally/,
  );
});

test("editRemoteFileViaLocalStage refuses oversized staged edits and preserves the staged copy", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-oversized-edit-");
  const ssh = makeIdentity(remoteRoot);

  await assert.rejects(
    () => editRemoteFileViaLocalStage({
      tui: makeTui(),
      ssh,
      sessionId: `session-${Date.now()}-oversized-edit`,
      repoRelPath: "src/tracked.ts",
      lineTargeted: false,
      openEditor: ({ filePath }) => {
        fs.writeFileSync(filePath, Buffer.alloc(4 * 1024 * 1024 + 2, 0x62));
        return { status: 0 };
      },
    }),
    (error) => {
      assert.match(String(error?.message ?? error), /Refusing to upload an oversized staged SSH edit/);
      assert.equal(fs.existsSync(error?.stagePath), true);
      return true;
    },
  );
});

test("editRemoteFileViaLocalStage refuses symlink targets before opening the editor", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-symlink-");
  const targetPath = path.join(remoteRoot, "src", "tracked.ts");
  const linkedPath = path.join(remoteRoot, "src", "linked.ts");
  fs.renameSync(targetPath, linkedPath);
  fs.symlinkSync(linkedPath, targetPath);
  const ssh = makeIdentity(remoteRoot);
  let opened = false;

  await assert.rejects(
    () => editRemoteFileViaLocalStage({
      tui: makeTui(),
      ssh,
      sessionId: `session-${Date.now()}-symlink`,
      repoRelPath: "src/tracked.ts",
      lineTargeted: false,
      openEditor: () => {
        opened = true;
        return { status: 0 };
      },
    }),
    /Refusing to stage a symlinked remote file over SSH edit/,
  );

  assert.equal(opened, false);
  assert.equal(fs.lstatSync(targetPath).isSymbolicLink(), true);
});

test("editRemoteFileViaLocalStage refuses hardlinked targets before opening the editor", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-hardlink-");
  const targetPath = path.join(remoteRoot, "src", "tracked.ts");
  const hardlinkPath = path.join(remoteRoot, "src", "linked.ts");
  fs.linkSync(targetPath, hardlinkPath);
  const ssh = makeIdentity(remoteRoot);
  let opened = false;

  await assert.rejects(
    () => editRemoteFileViaLocalStage({
      tui: makeTui(),
      ssh,
      sessionId: `session-${Date.now()}-hardlink`,
      repoRelPath: "src/tracked.ts",
      lineTargeted: false,
      openEditor: () => {
        opened = true;
        return { status: 0 };
      },
    }),
    /Refusing to stage a hardlinked remote file over SSH edit/,
  );

  assert.equal(opened, false);
  assert.ok(fs.statSync(targetPath).nlink > 1);
});

test("editRemoteFileViaLocalStage fails closed when the remote baseline drifts during editing", async () => {
  const remoteRoot = makeRemoteRepo("pi-diff-review-ssh-stage-drift-");
  const ssh = makeIdentity(remoteRoot);
  const sessionId = `session-${Date.now()}-drift`;

  const result = await editRemoteFileViaLocalStage({
    tui: makeTui(),
    ssh,
    sessionId,
    repoRelPath: "src/tracked.ts",
    lineTargeted: false,
    openEditor: ({ filePath }) => {
      fs.writeFileSync(path.join(remoteRoot, "src", "tracked.ts"), "export const remote = 99;\n", "utf8");
      fs.writeFileSync(filePath, "export const remote = 2;\n", "utf8");
      return { status: 0 };
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.uploaded, false);
  assert.equal(result.conflict, true);
  assert.equal(fs.readFileSync(path.join(remoteRoot, "src", "tracked.ts"), "utf8"), "export const remote = 99;\n");
  assert.equal(fs.readFileSync(result.stagePath, "utf8"), "export const remote = 2;\n");
});
