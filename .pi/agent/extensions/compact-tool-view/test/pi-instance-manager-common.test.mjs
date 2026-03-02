import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeManagerState } from "../pi-instance-manager/lib/pi-instance-manager-common.ts";

function withSocketEnv(sockPath, fn) {
  const prev = process.env.PI_INSTANCE_MANAGER_SOCKET;
  process.env.PI_INSTANCE_MANAGER_SOCKET = sockPath;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.PI_INSTANCE_MANAGER_SOCKET;
      else process.env.PI_INSTANCE_MANAGER_SOCKET = prev;
    });
}

test("probeManagerState reports missing socket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-probe-"));
  const sockPath = path.join(dir, "missing.sock");

  await withSocketEnv(sockPath, async () => {
    const probe = await probeManagerState(150);
    assert.equal(probe.state, null);
    assert.equal(probe.socketPresent, false);
    assert.ok(["ENOENT", "SOCKET_CLOSED", "UNKNOWN"].includes(probe.errorCode));
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("probeManagerState detects stale unix socket (connection refused)", async () => {
  const { spawn } = await import("node:child_process");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-probe-stale-"));
  const sockPath = path.join(dir, "manager.sock");

  const child = spawn(
    process.execPath,
    [
      "-e",
      `const net=require('node:net'); const sock=${JSON.stringify(sockPath)}; const s=net.createServer(); s.listen(sock,()=>{console.log('ready')}); setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not become ready")), 2000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  process.kill(child.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(fs.existsSync(sockPath), true);

  await withSocketEnv(sockPath, async () => {
    const probe = await probeManagerState(150);
    assert.equal(probe.state, null);
    assert.equal(probe.socketPresent, true);
    assert.ok(["ECONNREFUSED", "SOCKET_CLOSED", "UNKNOWN"].includes(probe.errorCode));
  });

  fs.rmSync(dir, { recursive: true, force: true });
});
