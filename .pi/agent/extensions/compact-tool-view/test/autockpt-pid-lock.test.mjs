import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearStalePidLock,
  readPidLock,
  releasePidLock,
  tryAcquirePidLock,
} from "../lib/autockpt/autockpt-pid-lock.ts";

function newTmpLockPath(name = "compaction.lock.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-lock-"));
  return path.join(dir, name);
}

test("pid lock: acquire blocks other acquires until released", () => {
  const lockPath = newTmpLockPath();

  const a1 = tryAcquirePidLock(lockPath, { maxAgeMs: 60_000, checkpointPath: "work/x.md" });
  assert.equal(a1.acquired, true);
  assert.equal(a1.record.pid, process.pid);

  const a2 = tryAcquirePidLock(lockPath, { maxAgeMs: 60_000, checkpointPath: "work/x.md" });
  assert.equal(a2.acquired, false);
  assert.ok(a2.reason.includes("held"));

  assert.equal(releasePidLock(lockPath, process.pid), true);

  const a3 = tryAcquirePidLock(lockPath, { maxAgeMs: 60_000, checkpointPath: "work/x.md" });
  assert.equal(a3.acquired, true);
  assert.equal(a3.record.pid, process.pid);
});

test("pid lock: stale lock (dead pid) is cleared and can be re-acquired", () => {
  const lockPath = newTmpLockPath();

  // Write a lock record with a pid that should not exist.
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      {
        v: 1,
        pid: 999999,
        createdAt: Date.now() - 10_000,
        checkpointPath: "work/log/checkpoints/old.md",
      },
      null,
      2,
    ),
    "utf8",
  );

  const before = readPidLock(lockPath);
  assert.equal(before?.pid, 999999);

  // Should clear because pid is dead.
  const cleared = clearStalePidLock(lockPath, 60_000);
  assert.equal(cleared, true);

  const a1 = tryAcquirePidLock(lockPath, { maxAgeMs: 60_000, checkpointPath: "work/new.md" });
  assert.equal(a1.acquired, true);
  assert.equal(a1.record.pid, process.pid);
});
