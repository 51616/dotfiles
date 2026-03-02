import assert from "node:assert/strict";
import { test } from "node:test";

import { maybeResumeAfterDiscordTurn } from "../pi-instance-manager/lib/pi-instance-manager-session-sync.ts";

function makeCtx({ idle = true, onSwitch } = {}) {
  return {
    isIdle: () => idle,
    switchSession: async (sessionPath) => {
      if (onSwitch) await onSwitch(sessionPath);
      return { cancelled: false };
    },
  };
}

test("maybeResumeAfterDiscordTurn: switches using session file path after Discord lock release", async () => {
  const calls = [];
  const ctx = makeCtx({ onSwitch: async (path) => calls.push(path) });

  await maybeResumeAfterDiscordTurn({
    ctx,
    sessionFilePath: "/tmp/sessions/abc.jsonl",
    previousLock: {
      token: "lock-1",
      owner: "pi-discord-bot:prompt:user=123:session=abc",
    },
    nextLock: null,
    hasLocalTurnLock: false,
    hasPendingQueue: false,
    compacting: false,
  });

  assert.deepEqual(calls, ["/tmp/sessions/abc.jsonl"]);
});

test("maybeResumeAfterDiscordTurn: no-op when session file path is missing", async () => {
  const calls = [];
  const ctx = makeCtx({ onSwitch: async (path) => calls.push(path) });

  await maybeResumeAfterDiscordTurn({
    ctx,
    sessionFilePath: "",
    previousLock: {
      token: "lock-1",
      owner: "pi-discord-bot:prompt:user=123:session=abc",
    },
    nextLock: null,
    hasLocalTurnLock: false,
    hasPendingQueue: false,
    compacting: false,
  });

  assert.equal(calls.length, 0);
});

test("maybeResumeAfterDiscordTurn: no-op when lock owner is not Discord prompt", async () => {
  const calls = [];
  const ctx = makeCtx({ onSwitch: async (path) => calls.push(path) });

  await maybeResumeAfterDiscordTurn({
    ctx,
    sessionFilePath: "/tmp/sessions/abc.jsonl",
    previousLock: {
      token: "lock-1",
      owner: "pi-tui:prompt:pid=1:session=abc",
    },
    nextLock: null,
    hasLocalTurnLock: false,
    hasPendingQueue: false,
    compacting: false,
  });

  assert.equal(calls.length, 0);
});

test("maybeResumeAfterDiscordTurn: no-op when same Discord lock token is still active", async () => {
  const calls = [];
  const ctx = makeCtx({ onSwitch: async (path) => calls.push(path) });

  await maybeResumeAfterDiscordTurn({
    ctx,
    sessionFilePath: "/tmp/sessions/abc.jsonl",
    previousLock: {
      token: "lock-1",
      owner: "pi-discord-bot:prompt:user=123:session=abc",
    },
    nextLock: {
      token: "lock-1",
      owner: "pi-discord-bot:prompt:user=123:session=abc",
    },
    hasLocalTurnLock: false,
    hasPendingQueue: false,
    compacting: false,
  });

  assert.equal(calls.length, 0);
});

test("maybeResumeAfterDiscordTurn: no-op when Discord lock is still active with a new token", async () => {
  const calls = [];
  const ctx = makeCtx({ onSwitch: async (path) => calls.push(path) });

  await maybeResumeAfterDiscordTurn({
    ctx,
    sessionFilePath: "/tmp/sessions/abc.jsonl",
    previousLock: {
      token: "lock-1",
      owner: "pi-discord-bot:prompt:user=123:session=abc",
    },
    nextLock: {
      token: "lock-2",
      owner: "pi-discord-bot:prompt:user=123:session=abc",
    },
    hasLocalTurnLock: false,
    hasPendingQueue: false,
    compacting: false,
  });

  assert.equal(calls.length, 0);
});

test("maybeResumeAfterDiscordTurn: no-op when not idle", async () => {
  const calls = [];
  const ctx = makeCtx({ idle: false, onSwitch: async (path) => calls.push(path) });

  await maybeResumeAfterDiscordTurn({
    ctx,
    sessionFilePath: "/tmp/sessions/abc.jsonl",
    previousLock: {
      token: "lock-1",
      owner: "pi-discord-bot:prompt:user=123:session=abc",
    },
    nextLock: null,
    hasLocalTurnLock: false,
    hasPendingQueue: false,
    compacting: false,
  });

  assert.equal(calls.length, 0);
});

test("maybeResumeAfterDiscordTurn: swallows switchSession failures (best effort)", async () => {
  const ctx = {
    isIdle: () => true,
    switchSession: async () => {
      throw new Error("boom");
    },
  };

  await assert.doesNotReject(async () => {
    await maybeResumeAfterDiscordTurn({
      ctx,
      sessionFilePath: "/tmp/sessions/abc.jsonl",
      previousLock: {
        token: "lock-1",
        owner: "pi-discord-bot:prompt:user=123:session=abc",
      },
      nextLock: null,
      hasLocalTurnLock: false,
      hasPendingQueue: false,
      compacting: false,
    });
  });
});
