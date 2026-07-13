import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PiSshFileWorkerClient } from "../lib/pi-ssh-file-protocol.ts";

// @lat: [[tests#Persistent SSH file protocol]]

const testDir = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDir, "..", "fixtures", "fake-file-worker.mjs");

function launcher(mode) {
  return () => spawn(process.execPath, [fixture, mode], { stdio: ["pipe", "pipe", "pipe"] });
}

async function usingClient(mode, run, options = {}) {
  const client = new PiSshFileWorkerClient({
    launcher: launcher(mode),
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    ...options,
  });
  try {
    return await run(client);
  } finally {
    await client.dispose();
  }
}

test("file protocol routes concurrent out-of-order responses by request id", async () => {
  await usingClient("out-of-order", async (client) => {
    const first = client.request("echo", { token: "first" }, Buffer.from("payload-one"));
    const second = client.request("echo", { token: "second" }, Buffer.from("payload-two"));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.header.token, "first");
    assert.equal(firstResult.payload.toString("utf8"), "payload-one");
    assert.equal(secondResult.header.token, "second");
    assert.equal(secondResult.payload.toString("utf8"), "payload-two");
  });
});

test("file protocol rejects an incompatible worker version", async () => {
  await usingClient("bad-version", async (client) => {
    await assert.rejects(client.request("echo"), /protocol version/i);
  });
});

test("file protocol includes bounded worker stderr in startup failures", async () => {
  await usingClient("startup-error", async (client) => {
    await assert.rejects(
      client.request("echo"),
      /closed unexpectedly[\s\S]*Remote worker stderr:[\s\S]*python3 or python is required/,
    );
  });
});

test("file protocol aborts promptly during startup and dispose terminates the shared child", async () => {
  let child;
  const client = new PiSshFileWorkerClient({
    launcher: () => {
      child = spawn(process.execPath, [fixture, "silent-handshake"], { stdio: ["pipe", "pipe", "pipe"] });
      return child;
    },
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
  });
  const controller = new AbortController();
  try {
    const started = performance.now();
    const request = client.request("echo", {}, Buffer.alloc(0), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(request, /aborted/);
    assert.ok(performance.now() - started < 500, "startup abort should not wait for the handshake timeout");
  } finally {
    await client.dispose();
  }
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timeout = setTimeout(() => reject(new Error("startup child did not exit after dispose")), 1_500);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
});

test("file protocol kills a silent child on startup timeout and restarts lazily", async () => {
  let launches = 0;
  let firstChild;
  const client = new PiSshFileWorkerClient({
    launcher: () => {
      launches += 1;
      const child = spawn(process.execPath, [fixture, launches === 1 ? "silent-handshake" : "echo"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (launches === 1) firstChild = child;
      return child;
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(client.request("echo"), /startup timed out after 1000ms/);
    await new Promise((resolve, reject) => {
      if (firstChild.exitCode !== null || firstChild.signalCode !== null) return resolve();
      const timeout = setTimeout(() => reject(new Error("timed-out startup child was orphaned")), 1_500);
      firstChild.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    assert.equal((await client.request("echo", {}, Buffer.from("recovered"))).payload.toString(), "recovered");
    assert.equal(launches, 2);
  } finally {
    await client.dispose();
  }
});

test("file protocol bounds unterminated worker stderr retained in startup diagnostics", async () => {
  await usingClient(
    "startup-stderr-flood",
    async (client) => {
      let failure;
      try {
        await client.request("echo");
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /startup timed out/);
      assert.match(failure.message, /flood-tail/);
      assert.ok(failure.message.length < 3_000, `diagnostic was ${failure.message.length} characters`);
    },
    { startupTimeoutMs: 1_000 },
  );
});

test("file protocol rejects workers missing required capabilities", async () => {
  await usingClient("missing-capability", async (client) => {
    await assert.rejects(client.request("echo"), /missing required capabilities: edit_workspace/);
  });
});

test("file protocol rejects malformed response lengths and restarts lazily", async () => {
  let launches = 0;
  const client = new PiSshFileWorkerClient({
    launcher: () => {
      launches += 1;
      return spawn(process.execPath, [fixture, launches === 1 ? "malformed-after-request" : "echo"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    maxHeaderBytes: 1_024,
  });

  try {
    await assert.rejects(client.request("echo"), /header length/i);
    const recovered = await client.request("echo", { token: "recovered" }, Buffer.from("ok"));
    assert.equal(recovered.payload.toString("utf8"), "ok");
    assert.equal(launches, 2);
  } finally {
    await client.dispose();
  }
});

test("file protocol aborts one sent caller without desynchronizing later responses", async () => {
  await usingClient("echo", async (client) => {
    const controller = new AbortController();
    const delayed = client.request("echo", { delayMs: 100 }, Buffer.from("late"), {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(delayed, /aborted/i);

    const next = await client.request("echo", {}, Buffer.from("next"));
    assert.equal(next.payload.toString("utf8"), "next");
  });
});

test("file protocol skips an aborted frame that is still queued locally", async () => {
  const debugEvents = [];
  const controller = new AbortController();
  await usingClient(
    "echo",
    async (client) => {
      const first = client.request("echo", {}, Buffer.from("first"));
      const second = client.request("write_file", {}, Buffer.from("must-not-send"), { signal: controller.signal });
      await assert.rejects(second, /aborted/i);
      assert.equal((await first).payload.toString("utf8"), "first");
      assert.equal((await client.request("echo", {}, Buffer.from("third"))).payload.toString("utf8"), "third");
      assert.ok(debugEvents.some(({ event, details }) => event === "request.write.skipped" && details.id === 2));
    },
    {
      onDebug: (event, details) => {
        debugEvents.push({ event, details });
        if (event === "request.begin" && details.id === 2) controller.abort();
      },
    },
  );
});

test("file protocol resets the channel when abort interrupts a partial frame write", async () => {
  let launches = 0;
  const controller = new AbortController();
  const client = new PiSshFileWorkerClient({
    launcher: () => {
      launches += 1;
      return spawn(process.execPath, [fixture, launches === 1 ? "slow-consume" : "echo"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 2_000,
    onDebug: (event, details) => {
      if (event === "request.begin" && details.id === 1) {
        setTimeout(() => controller.abort(), 20);
      }
    },
  });
  try {
    const request = client.request("write_file", {}, Buffer.alloc(16 * 1024 * 1024, 120), {
      signal: controller.signal,
    });
    await assert.rejects(request, /aborted.*partial request write/i);
    const recovered = await client.request("echo", {}, Buffer.from("recovered"));
    assert.equal(recovered.payload.toString("utf8"), "recovered");
    assert.equal(launches, 2);
  } finally {
    await client.dispose();
  }
});

test("file protocol handles a half-closed worker pipe and restarts without process-level errors", async () => {
  let launches = 0;
  const client = new PiSshFileWorkerClient({
    launcher: () => {
      launches += 1;
      return spawn(process.execPath, [fixture, launches === 1 ? "close-stdin" : "echo"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(client.request("echo", {}, Buffer.from("broken")), /worker|pipe|write|closed/i);
    const recovered = await client.request("echo", {}, Buffer.from("healthy"));
    assert.equal(recovered.payload.toString("utf8"), "healthy");
    assert.equal(launches, 2);
  } finally {
    await client.dispose();
  }
});

test("file protocol fails all pending calls when the worker exits and restarts", async () => {
  let launches = 0;
  const client = new PiSshFileWorkerClient({
    launcher: () => {
      launches += 1;
      return spawn(process.execPath, [fixture, launches === 1 ? "exit-after-request" : "echo"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });

  try {
    await assert.rejects(client.request("echo"), /worker.*(closed|exited)/i);
    const recovered = await client.request("echo", {}, Buffer.from("healthy"));
    assert.equal(recovered.payload.toString("utf8"), "healthy");
    assert.equal(launches, 2);
  } finally {
    await client.dispose();
  }
});

test("file protocol parses a fragmented multi-megabyte response without frame accumulator copies", async () => {
  await usingClient(
    "fragmented-response",
    async (client) => {
      const payload = Buffer.alloc(5 * 1024 * 1024, 97);
      const result = await client.request("echo", {}, payload);
      assert.deepEqual(result.payload, payload);
    },
    { requestTimeoutMs: 10_000 },
  );
});

test("file protocol poisons the worker on unsolicited response ids", async () => {
  await usingClient("unsolicited-response", async (client) => {
    await assert.rejects(client.request("echo"), /unsolicited or duplicate response id 999|not running/);
  });
});

test("file protocol poisons the worker after a duplicate response", async () => {
  let launches = 0;
  const client = new PiSshFileWorkerClient({
    launcher: () => {
      launches += 1;
      return spawn(process.execPath, [fixture, launches === 1 ? "duplicate-response" : "echo"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
  try {
    assert.equal((await client.request("echo", {}, Buffer.from("first"))).payload.toString("utf8"), "first");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await client.request("echo", {}, Buffer.from("next"))).payload.toString("utf8"), "next");
    assert.equal(launches, 2);
  } finally {
    await client.dispose();
  }
});

test("file protocol rejects oversized request headers and payloads before writing", async () => {
  await usingClient(
    "echo",
    async (client) => {
      await assert.rejects(client.request("echo", { token: "x".repeat(1_000) }), /header.*limit/i);
      await assert.rejects(client.request("echo", {}, Buffer.alloc(17)), /payload.*limit/i);
    },
    { maxHeaderBytes: 128, maxPayloadBytes: 16 },
  );
});
