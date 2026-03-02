import test from "node:test";
import assert from "node:assert/strict";
import { registerAutockptCommand } from "../lib/autockpt/autockpt-command.ts";

function withEnv(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function makeFakeCtx() {
  const notices = [];
  const widgets = [];

  return {
    hasUI: true,
    notices,
    widgets,
    ui: {
      notify: (msg, level) => notices.push({ msg: String(msg), level: String(level) }),
      setWidget: (key, content) => widgets.push({ key: String(key), content }),
    },
  };
}

function makeDeps(overrides = {}) {
  const calls = {
    setDebug: [],
    updateArmed: 0,
    startAutotest: [],
    debug: [],
  };

  const deps = {
    enabled: true,
    debugWidgetKey: "autockpt-debug",
    getUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    getThresholdPercent: () => Number.parseFloat(process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME ?? "65"),
    getArmed: () => false,
    getPendingCompactionRequested: () => false,
    getAutotestInProgress: () => false,
    isDebugEnabled: () => false,
    setDebugEnabled: (next) => calls.setDebug.push(Boolean(next)),
    getDebugLog: () => calls.debug,
    clearDebugLog: () => {
      calls.debug.splice(0, calls.debug.length);
    },
    renderDebugWidget: () => {},
    updateArmedStatus: () => {
      calls.updateArmed += 1;
    },
    pushDebug: (_ctx, line) => calls.debug.push(String(line)),
    startAutotestFromCommand: (_ctx, threshold) => calls.startAutotest.push(Number(threshold)),
    ...overrides,
  };

  return { deps, calls };
}

function getRegisteredHandler() {
  let handler = null;
  const pi = {
    registerCommand: (_name, spec) => {
      handler = spec?.handler ?? null;
    },
  };
  return {
    pi,
    get handler() {
      return handler;
    },
  };
}

test("registerAutockptCommand handles threshold set/reset", async () => {
  await withEnv({ PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME: undefined }, async () => {
    const reg = getRegisteredHandler();
    const { deps, calls } = makeDeps();
    registerAutockptCommand(reg.pi, deps);

    const handler = reg.handler;
    assert.equal(typeof handler, "function");

    const ctx = makeFakeCtx();
    await handler("threshold 72", ctx);
    assert.equal(process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME, "72");
    assert.equal(calls.updateArmed, 1);

    await handler("threshold reset", ctx);
    assert.equal(process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME, undefined);
    assert.equal(calls.updateArmed, 2);
  });
});

test("registerAutockptCommand forwards test command threshold", async () => {
  const reg = getRegisteredHandler();
  const { deps, calls } = makeDeps();
  registerAutockptCommand(reg.pi, deps);

  const handler = reg.handler;
  assert.equal(typeof handler, "function");

  const ctx = makeFakeCtx();
  await handler("test 7", ctx);
  assert.deepEqual(calls.startAutotest, [7]);
});
