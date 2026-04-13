import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCheckpointProbe,
  resolveSshCheckpointConfig,
} from "../lib/self-checkpointing-checkpoint-probe.ts";

const BEGIN = "__PI_SELF_CHECKPOINT_PROBE_BEGIN__";
const END = "__PI_SELF_CHECKPOINT_PROBE_END__";

function withTempCwd(callback) {
  const previousCwd = process.cwd();
  const tempDir = mkdtempSync(path.join(tmpdir(), "pi-self-checkpoint-"));
  try {
    process.chdir(tempDir);
    return callback(tempDir);
  } finally {
    process.chdir(previousCwd);
  }
}

function createCheckpointFile(rootDir, name, content = "# checkpoint\n") {
  const checkpointDir = path.join(rootDir, "work", "log", "checkpoints");
  mkdirSync(checkpointDir, { recursive: true });
  const checkpointPath = path.join(checkpointDir, name);
  writeFileSync(checkpointPath, content, "utf-8");
  return checkpointPath;
}

test("resolveSshCheckpointConfig parses remote target and port", () => {
  const config = resolveSshCheckpointConfig({
    getFlag(name) {
      if (name === "ssh") return "user@example.com:~/repo";
      if (name === "ssh-port") return "2222";
      return undefined;
    },
  });

  assert.deepEqual(config, {
    remote: "user@example.com",
    remotePath: "~/repo",
    port: 2222,
  });
});

test("createCheckpointProbe validates and infers checkpoints through ssh when --ssh is active", () => {
  const calls = [];
  const probe = createCheckpointProbe(
    {
      getFlag(name) {
        if (name === "ssh") return "user@example.com:~/repo";
        if (name === "ssh-port") return "2222";
        return undefined;
      },
    },
    {
      sshExec(request) {
        calls.push(request);
        const payload = calls.length === 1
          ? JSON.stringify({ exists: true, fresh: true, mtimeMs: Date.now() })
          : JSON.stringify({ latestPath: "work/log/checkpoints/demo.md", mtimeMs: Date.now() });
        return {
          status: 0,
          stdout: `remote login banner\n${BEGIN}\n${payload}\n${END}\n`,
        };
      },
    },
  );

  assert.equal(probe.isFreshCheckpointFile("work/log/checkpoints/demo.md", 60_000), true);
  assert.equal(probe.inferLatestCheckpointPath(60_000), "work/log/checkpoints/demo.md");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].remote, "user@example.com");
  assert.equal(calls[0].port, 2222);
  assert.match(calls[0].remoteCommand, /\$HOME/);
  assert.match(calls[0].remoteCommand, /python3|python/);
});

test("createCheckpointProbe accepts a fresh local checkpoint before probing ssh", () => {
  withTempCwd((tempDir) => {
    createCheckpointFile(tempDir, "demo.md");

    let sshCalls = 0;
    const probe = createCheckpointProbe(
      {
        getFlag(name) {
          if (name === "ssh") return "user@example.com:/srv/repo";
          return undefined;
        },
      },
      {
        sshExec() {
          sshCalls += 1;
          return { status: 0, stdout: "" };
        },
      },
    );

    assert.equal(probe.isFreshCheckpointFile("work/log/checkpoints/demo.md", 60_000), true);
    assert.equal(sshCalls, 0);
  });
});

test("createCheckpointProbe picks the freshest checkpoint across local and ssh workspaces", () => {
  withTempCwd((tempDir) => {
    createCheckpointFile(tempDir, "local-newer.md");

    const probe = createCheckpointProbe(
      {
        getFlag(name) {
          if (name === "ssh") return "user@example.com:/srv/repo";
          return undefined;
        },
      },
      {
        sshExec() {
          return {
            status: 0,
            stdout: `remote login banner\n${BEGIN}\n${JSON.stringify({
              latestPath: "work/log/checkpoints/remote-older.md",
              mtimeMs: Date.now() - 5_000,
            })}\n${END}\n`,
          };
        },
      },
    );

    assert.equal(probe.inferLatestCheckpointPath(60_000), path.join("work", "log", "checkpoints", "local-newer.md"));
  });
});

test("createCheckpointProbe rejects obviously malformed checkpoint paths before ssh probing", () => {
  let called = false;
  const probe = createCheckpointProbe(
    {
      getFlag(name) {
        if (name === "ssh") return "user@example.com:/srv/repo";
        return undefined;
      },
    },
    {
      sshExec() {
        called = true;
        return { status: 0, stdout: "" };
      },
    },
  );

  assert.equal(probe.isFreshCheckpointFile("<bad>", 60_000), false);
  assert.equal(called, false);
});
