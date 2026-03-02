import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearPendingResume,
  readPendingResume,
  writePendingResume,
} from "../lib/autockpt/autockpt-pending-resume.ts";

function newTmpPath(name = "pending-resume.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-pending-"));
  return path.join(dir, name);
}

test("pending resume store: write/read/clear lifecycle", () => {
  const filePath = newTmpPath();

  writePendingResume(filePath, {
    v: 1,
    checkpointPath: "work/log/checkpoints/2026-02-18_1700_test.md",
    resumeText: "resume",
    createdAt: 123,
    attempts: 2,
    lastSentAt: 456,
    ownerPid: 999,
    sessionId: "session-abc",
  });

  const got = readPendingResume(filePath);
  assert.equal(got?.checkpointPath, "work/log/checkpoints/2026-02-18_1700_test.md");
  assert.equal(got?.resumeText, "resume");
  assert.equal(got?.attempts, 2);
  assert.equal(got?.lastSentAt, 456);
  assert.equal(got?.ownerPid, 999);
  assert.equal(got?.sessionId, "session-abc");

  clearPendingResume(filePath);
  assert.equal(readPendingResume(filePath), null);
});

test("pending resume store: invalid payload returns null", () => {
  const filePath = newTmpPath();
  fs.writeFileSync(filePath, JSON.stringify({ checkpointPath: "", resumeText: "" }), "utf8");
  assert.equal(readPendingResume(filePath), null);
});
