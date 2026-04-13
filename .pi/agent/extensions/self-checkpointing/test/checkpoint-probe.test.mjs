import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createCheckpointProbe,
  resolveCheckpointBackendConfig,
} from "../lib/self-checkpointing-checkpoint-probe.ts";

const BEGIN = "__PI_SELF_CHECKPOINT_PROBE_BEGIN__";
const END = "__PI_SELF_CHECKPOINT_PROBE_END__";

test("resolveCheckpointBackendConfig maps ssh backend connection info", () => {
  const config = resolveCheckpointBackendConfig({
    kind: "ssh",
    remote: "user@example.com",
    remoteCwd: "/srv/repo",
    port: 2222,
  });

  assert.deepEqual(config, {
    remote: "user@example.com",
    remotePath: "/srv/repo",
    port: 2222,
  });
});

test("createCheckpointProbe validates and infers checkpoints through the active ssh backend", () => {
  const calls = [];
  const checkpointPath = `/tmp/pi-work/checkpoints/demo-${process.pid}.md`;
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, "demo\n", "utf8");

  const probe = createCheckpointProbe({
    getActiveBackend: () => ({
      getConnectionInfo: () => ({
        kind: "ssh",
        remote: "user@example.com",
        remoteCwd: "/tmp",
        port: 2222,
      }),
    }),
    sshExec(request) {
      calls.push(request);
      if (request.remoteCommand.includes("'validate'")) {
        const result = spawnSync("bash", ["-lc", request.remoteCommand], {
          encoding: "utf-8",
          timeout: request.timeoutMs,
        });
        return {
          status: result.status,
          stdout: typeof result.stdout === "string" ? result.stdout : "",
        };
      }

      const payload = JSON.stringify({ latestPath: checkpointPath, mtimeMs: Date.now() });
      return {
        status: 0,
        stdout: `remote login banner\n${BEGIN}\n${payload}\n${END}\n`,
      };
    },
  });

  assert.equal(probe.isFreshCheckpointFile(checkpointPath, 60_000), true);
  assert.equal(probe.inferLatestCheckpointPath(60_000), checkpointPath);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].remote, "user@example.com");
  assert.equal(calls[0].port, 2222);
  assert.match(calls[0].remoteCommand, /\/tmp/);
  assert.match(calls[0].remoteCommand, /python3|python/);
  assert.doesNotMatch(calls[0].remoteCommand, /then;/);

  fs.unlinkSync(checkpointPath);
});

test("createCheckpointProbe infers the latest local checkpoint from /tmp/pi-work/checkpoints", () => {
  const dir = "/tmp/pi-work/checkpoints";
  const older = path.join(dir, `probe-local-${process.pid}-older.md`);
  const newer = path.join(dir, `probe-local-${process.pid}-newer.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(older, "older\n", "utf8");
  fs.writeFileSync(newer, "newer\n", "utf8");

  const oldTime = new Date(Date.now() - 5_000);
  const newTime = new Date(Date.now() - 1_000);
  fs.utimesSync(older, oldTime, oldTime);
  fs.utimesSync(newer, newTime, newTime);

  const probe = createCheckpointProbe({ getActiveBackend: () => null });
  assert.equal(probe.inferLatestCheckpointPath(60_000), newer);
  assert.equal(probe.isFreshCheckpointFile(newer, 60_000), true);

  fs.unlinkSync(older);
  fs.unlinkSync(newer);
});

test("createCheckpointProbe keeps using the last active ssh backend when the provider temporarily disappears", () => {
  const calls = [];
  let active = true;
  const checkpointPath = "/tmp/pi-work/checkpoints/demo-sticky.md";
  const probe = createCheckpointProbe({
    getActiveBackend: () => active
      ? {
          getConnectionInfo: () => ({
            kind: "ssh",
            remote: "user@example.com",
            remoteCwd: "/srv/repo",
            port: 22,
          }),
        }
      : null,
    sshExec(request) {
      calls.push(request);
      return {
        status: 0,
        stdout: `${BEGIN}\n${JSON.stringify({ exists: true, fresh: true, latestPath: checkpointPath, mtimeMs: Date.now() })}\n${END}\n`,
      };
    },
  });

  assert.equal(probe.isFreshCheckpointFile(checkpointPath, 60_000), true);
  active = false;
  assert.equal(probe.isFreshCheckpointFile(checkpointPath, 60_000), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].remote, "user@example.com");
});

test("createCheckpointProbe rejects obviously malformed checkpoint paths before ssh probing", () => {
  let called = false;
  const probe = createCheckpointProbe({
    getActiveBackend: () => ({
      getConnectionInfo: () => ({
        kind: "ssh",
        remote: "user@example.com",
        remoteCwd: "/srv/repo",
        port: 22,
      }),
    }),
    sshExec() {
      called = true;
      return { status: 0, stdout: "" };
    },
  });

  assert.equal(probe.isFreshCheckpointFile("<bad>", 60_000), false);
  assert.equal(called, false);
});
