import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS = path.join(__dirname, "helpers", "pi-instance-manager-out-of-vault-harness.mjs");

function runHarness(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", HARNESS], {
      cwd: path.resolve(__dirname, "../../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`harness timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`harness exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const line = stdout
          .trim()
          .split("\n")
          .reverse()
          .find((entry) => entry.startsWith("__PI_HARNESS_JSON__ "));
        if (!line) {
          throw new Error(`missing sentinel JSON line in output: ${stdout}`);
        }
        resolve(JSON.parse(line.slice("__PI_HARNESS_JSON__ ".length)));
      } catch (error) {
        reject(new Error(`failed to parse harness output: ${stdout}\n${stderr}\n${String(error)}`));
      }
    });
  });
}

function assertSubsequence(actual, expected) {
  let index = 0;
  for (const item of actual) {
    if (item === expected[index]) index += 1;
    if (index === expected.length) return;
  }
  assert.fail(`expected subsequence ${expected.join(" -> ")} in ${actual.join(", ")}`);
}

test("pi-instance-manager coordinates an out-of-vault session by session id", async () => {
  const result = await runHarness();

  assert.equal(result.cwd.includes("outside-repo"), true);
  assert.equal(result.vaultRoot.includes("vault-root"), true);
  assert.notEqual(result.cwd.startsWith(result.vaultRoot), true);

  assert.ok(Array.isArray(result.sent));
  assert.ok(result.sent.includes("hello from outside vault"));
  assert.equal(result.enqueueSessionId, "shared-session");
  assert.match(String(result.enqueueOwner || ""), /session=shared-session/);

  for (const op of ["state.get", "turn.enqueue", "turn.wait", "lock.acquire", "turn.done", "lock.release"]) {
    assert.ok(result.ops.includes(op), `expected manager op: ${op}`);
  }
  assertSubsequence(result.ops, ["turn.enqueue", "turn.wait", "lock.acquire", "turn.done", "lock.release"]);

  for (const key of ["pi-compact", "pi-instance-manager", "pi-services"]) {
    assert.ok(result.statusKeys.includes(key), `expected status key: ${key}`);
  }
  assert.ok(result.widgetKeys.includes("pi-compact-help"));
  assert.ok(result.nonEmptyStatuses.some(([key, value]) => key === "pi-instance-manager" && String(value).trim()));
  assert.ok(result.nonEmptyStatuses.some(([key, value]) => key === "pi-services" && String(value).trim()));
});
