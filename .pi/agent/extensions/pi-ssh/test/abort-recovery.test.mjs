import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testInternals } from "../index.ts";

const { PersistentRemoteShell } = __testInternals;
const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-ssh-shell.mjs");

function makeConnection() {
  return {
    remote: "fake@host",
    port: 22,
    remoteCwd: "/remote/worktree",
    remoteHome: "/remote",
    localCwd: "/local/worktree",
    localHome: "/local",
  };
}

test("PersistentRemoteShell abort recovers by resetting the shell when no end marker arrives", async () => {
  let launchCount = 0;
  const shell = new PersistentRemoteShell(makeConnection(), {
    abortGraceMs: 25,
    startupCommands: [],
    launcher: () => {
      launchCount += 1;
      const mode = launchCount === 1 ? "abort-no-marker" : "normal";
      return spawn(process.execPath, [helperPath], {
        env: { ...process.env, PI_SSH_FAKE_MODE: mode },
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  });

  const controller = new AbortController();
  const firstRun = shell.exec("sleep 10", "/local/worktree", {
    signal: controller.signal,
    onData: () => {},
  });

  setTimeout(() => controller.abort(), 10);
  await assert.rejects(firstRun, /aborted/);

  let output = "";
  const secondRun = await shell.exec("echo ok", "/local/worktree", {
    onData: (chunk) => {
      output += chunk.toString("utf-8");
    },
  });

  assert.equal(secondRun.exitCode, 0);
  assert.match(output, /hello from fake shell/);
  assert.equal(launchCount, 2);

  await shell.dispose();
});

test("PersistentRemoteShell timeout recovers by resetting the shell when no end marker arrives", async () => {
  let launchCount = 0;
  const shell = new PersistentRemoteShell(makeConnection(), {
    abortGraceMs: 25,
    startupCommands: [],
    launcher: () => {
      launchCount += 1;
      const mode = launchCount === 1 ? "abort-no-marker" : "normal";
      return spawn(process.execPath, [helperPath], {
        env: { ...process.env, PI_SSH_FAKE_MODE: mode },
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  });

  await assert.rejects(
    shell.exec("sleep 10", "/local/worktree", {
      timeout: 0.01,
      onData: () => {},
    }),
    /timeout:0.01/,
  );

  let output = "";
  const secondRun = await shell.exec("echo ok", "/local/worktree", {
    onData: (chunk) => {
      output += chunk.toString("utf-8");
    },
  });

  assert.equal(secondRun.exitCode, 0);
  assert.match(output, /hello from fake shell/);
  assert.equal(launchCount, 2);

  await shell.dispose();
});
