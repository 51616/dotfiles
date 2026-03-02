import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import piInstanceMaster from "../pi-instance-master/index.ts";
import piRouterNotifier from "../pi-router-notifier/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "../../..");

function createStubPi() {
  const handlers = new Map();
  return {
    on(event, fn) {
      handlers.set(event, fn);
    },
    handlers,
  };
}

function withStubbedTimers(fn) {
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  let unrefCalled = false;
  globalThis.setInterval = (cb, ms) => {
    return {
      __cb: cb,
      __ms: ms,
      unref() {
        unrefCalled = true;
      },
    };
  };

  globalThis.clearInterval = () => {};

  try {
    fn({ getUnrefCalled: () => unrefCalled });
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
}

test("pi-instance-master: background refresh timer is unref()'d", async () => {
  const pi = createStubPi();
  piInstanceMaster(pi);

  const handler = pi.handlers.get("session_start");
  assert.equal(typeof handler, "function");

  const oldRoot = process.env.PI_VAULT_ROOT;
  const oldPath = process.env.PATH;
  process.env.PI_VAULT_ROOT = repoRoot;
  // Speed: prevent spawnSync('systemctl'/'ps') from doing anything expensive.
  process.env.PATH = "";

  try {
    await new Promise((resolve, reject) => {
      withStubbedTimers(({ getUnrefCalled }) => {
        const ctx = {
          hasUI: true,
          cwd: repoRoot,
          ui: {
            setStatus() {},
          },
        };

        Promise.resolve(handler({}, ctx))
          .then(() => {
            assert.equal(getUnrefCalled(), true);
            resolve();
          })
          .catch(reject);
      });
    });
  } finally {
    process.env.PI_VAULT_ROOT = oldRoot;
    process.env.PATH = oldPath;
  }
});

test("pi-router-notifier: polling timer is unref()'d", async () => {
  const pi = createStubPi();
  piRouterNotifier(pi);

  const handler = pi.handlers.get("session_start");
  assert.equal(typeof handler, "function");

  const oldRoot = process.env.PI_VAULT_ROOT;
  process.env.PI_VAULT_ROOT = repoRoot;

  try {
    await new Promise((resolve, reject) => {
      withStubbedTimers(({ getUnrefCalled }) => {
        const ctx = {
          hasUI: true,
          cwd: repoRoot,
          ui: {
            setStatus() {},
            notify() {},
          },
        };

        Promise.resolve(handler({}, ctx))
          .then(() => {
            assert.equal(getUnrefCalled(), true);
            resolve();
          })
          .catch(reject);
      });
    });
  } finally {
    process.env.PI_VAULT_ROOT = oldRoot;
  }
});
