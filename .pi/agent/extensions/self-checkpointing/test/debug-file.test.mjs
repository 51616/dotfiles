import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSelfCheckpointingDebugFile } from "../lib/self-checkpointing-debug-file.ts";

function createCtx(sessionId = "sess-1") {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => "/tmp/demo-cwd",
    },
  };
}

test("debug file logger writes jsonl records when enabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-debug-"));
  const logger = createSelfCheckpointingDebugFile({
    pendingDir: dir,
    isEnabled: () => true,
    pid: 123,
    getCheckpointProbeInfo: () => ({
      mode: "ssh",
      source: "active-backend",
      remote: "user@example.com",
      port: 22,
      remotePath: "/srv/repo",
    }),
  });
  const ctx = createCtx();

  logger.append(ctx, "session_start");
  const logPath = logger.logPathFor(ctx);

  assert.ok(logPath);
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);

  const record = JSON.parse(lines[0]);
  assert.equal(record.pid, 123);
  assert.equal(record.sessionId, "sess-1");
  assert.equal(record.cwd, "/tmp/demo-cwd");
  assert.equal(record.line, "session_start");
  assert.deepEqual(record.checkpointProbe, {
    mode: "ssh",
    source: "active-backend",
    remote: "user@example.com",
    port: 22,
    remotePath: "/srv/repo",
  });
});

test("debug file logger stays silent when disabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-debug-"));
  const logger = createSelfCheckpointingDebugFile({
    pendingDir: dir,
    isEnabled: () => false,
    pid: 123,
  });
  const ctx = createCtx();

  logger.append(ctx, "session_start");

  assert.equal(logger.logPathFor(ctx), null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("debug file logger honors explicit path override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-debug-"));
  const logPath = path.join(dir, "custom.jsonl");
  const logger = createSelfCheckpointingDebugFile({
    pendingDir: dir,
    pathOverride: logPath,
    isEnabled: () => true,
    pid: 123,
  });
  const ctx = createCtx("sess-2");

  logger.append(ctx, "turn_end");

  assert.equal(logger.logPathFor(ctx), logPath);
  const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(record.sessionId, "sess-2");
  assert.equal(record.line, "turn_end");
});
