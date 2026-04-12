import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import piInstanceManager from "../../pi-instance-manager/index.ts";

function withStubbedIntervals(fn) {
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  globalThis.setInterval = () => ({ unref() {} });
  globalThis.clearInterval = () => {};

  try {
    return fn();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
}

async function createFakeManagerServer(sockPath, sessionId, requests) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          const req = JSON.parse(line);
          requests.push({ op: String(req.op || ""), payload: req });

          let data = {};
          switch (String(req.op || "")) {
            case "state.get":
              data = {
                state: {
                  compacting: false,
                  activeCompactions: [],
                  activeLocks: [],
                  queuedTurnRequests: 0,
                  turnQueues: [
                    {
                      sessionId,
                      total: 0,
                      queued: 0,
                      items: [],
                    },
                  ],
                },
              };
              break;
            case "turn.enqueue":
              data = { ticketId: "ticket-1" };
              break;
            case "turn.wait":
              data = { granted: true, waited: false };
              break;
            case "lock.acquire":
              data = { token: "lock-1", waited: false };
              break;
            case "turn.done":
            case "turn.cancel":
            case "lock.release":
            case "lock.renew":
              data = { ok: true, renewed: true };
              break;
            default:
              data = {};
              break;
          }

          socket.write(`${JSON.stringify({ id: req.id, ok: true, data })}\n`);
        }
        idx = buffer.indexOf("\n");
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(sockPath, resolve);
  });

  server.unref?.();

  return {
    server,
    destroySockets() {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore cleanup errors
        }
      }
      sockets.clear();
    },
  };
}

async function main() {
  const tmpBase = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  const root = fs.mkdtempSync(path.join(tmpBase, "pi-im-ov-"));
  const vaultRoot = path.join(root, "vault-root");
  const outsideDir = path.join(root, "outside-repo");
  const sessionFile = path.join(root, "shared-session.jsonl");
  const sockPath = path.join(root, "manager.sock");
  const serviceScript = path.join(vaultRoot, ".pi", "scripts", "pi-instance-manager", "scripts", "service.sh");

  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(path.dirname(serviceScript), { recursive: true });
  fs.writeFileSync(serviceScript, "#!/usr/bin/env bash\n", "utf8");
  fs.chmodSync(serviceScript, 0o755);
  fs.writeFileSync(sessionFile, "", "utf8");

  const sessionId = "shared-session";
  const prompt = "hello from outside vault";
  const requests = [];
  const { server, destroySockets } = await createFakeManagerServer(sockPath, sessionId, requests);

  const oldCwd = process.cwd();
  const oldSocket = process.env.PI_INSTANCE_MANAGER_SOCKET;
  const oldPath = process.env.PATH;
  const oldVaultRoot = process.env.PI_VAULT_ROOT;
  process.env.PI_INSTANCE_MANAGER_SOCKET = sockPath;
  process.env.PI_VAULT_ROOT = vaultRoot;
  process.env.PATH = "/usr/bin:/bin";
  process.chdir(outsideDir);

  try {
    const result = await withStubbedIntervals(async () => {
      const handlers = new Map();
      const sent = [];
      const statusCalls = [];
      const widgetCalls = [];

      const pi = {
        on(name, handler) {
          const key = String(name);
          const list = handlers.get(key) || [];
          list.push(handler);
          handlers.set(key, list);
        },
        registerCommand() {},
        sendUserMessage(text) {
          sent.push(text);
        },
      };

      piInstanceManager(pi);

      const ctx = {
        hasUI: true,
        cwd: outsideDir,
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => sessionFile,
        },
        switchSession: async () => {},
        ui: {
          setStatus(key, value) {
            statusCalls.push([key, value]);
          },
          setWidget(key, value, options) {
            widgetCalls.push([key, value, options]);
          },
          setEditorText() {},
          notify() {},
        },
      };

      for (const handler of handlers.get("session_start") || []) {
        await handler({}, ctx);
      }
      for (const handler of handlers.get("input") || []) {
        await handler({ source: "user", text: prompt }, ctx);
      }
      for (const handler of handlers.get("agent_end") || []) {
        await handler({}, ctx);
      }
      for (const handler of handlers.get("session_shutdown") || []) {
        await handler({}, ctx);
      }

      const enqueueRequest = requests.find((entry) => entry.op === "turn.enqueue");
      assert.ok(enqueueRequest);

      return {
        cwd: outsideDir,
        vaultRoot,
        sent,
        ops: requests.map((entry) => entry.op),
        enqueueSessionId: enqueueRequest.payload.sessionId,
        enqueueOwner: enqueueRequest.payload.owner,
        statusKeys: [...new Set(statusCalls.map(([key]) => key))].sort(),
        widgetKeys: [...new Set(widgetCalls.map(([key]) => key))].sort(),
        nonEmptyStatuses: statusCalls
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([key, value]) => [key, value]),
      };
    });

    process.stdout.write(`__PI_HARNESS_JSON__ ${JSON.stringify(result)}\n`);
  } finally {
    process.chdir(oldCwd);
    if (oldSocket === undefined) delete process.env.PI_INSTANCE_MANAGER_SOCKET;
    else process.env.PI_INSTANCE_MANAGER_SOCKET = oldSocket;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldVaultRoot === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = oldVaultRoot;
    destroySockets();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
