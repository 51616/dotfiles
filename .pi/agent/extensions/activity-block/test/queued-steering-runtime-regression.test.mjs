import test from "node:test";
import assert from "node:assert/strict";
import activityBlockExtension from "../index.ts";

function makePiStub() {
  const handlers = new Map();
  const appended = [];
  return {
    handlers,
    appended,
    pi: {
      on(name, handler) {
        handlers.set(String(name), handler);
      },
      registerMessageRenderer() {},
      registerCommand() {},
      registerShortcut() {},
      appendEntry(type, data) {
        appended.push({ type, data });
      },
    },
  };
}

function makeCtx() {
  let idle = true;
  return {
    ctx: {
      hasUI: false,
      isIdle() {
        return idle;
      },
      sessionManager: {
        getBranch() {
          return [];
        },
      },
      ui: {
        setStatus() {},
        setLiveTranscriptMode() {},
        setHistoricalTranscriptMode() {},
        notify() {},
        onTerminalInput() {
          return () => {};
        },
      },
    },
    setIdle(value) {
      idle = value;
    },
  };
}

async function triggerTurnResponse(handlers, ctx, text, turnIndex = 0) {
  return handlers.get("before_turn_response")({
    type: "before_turn_response",
    turnIndex,
    triggerMessages: [{ role: "user", content: [{ type: "text", text }] }],
    systemPrompt: "",
  }, ctx);
}

test("queued steering spawns a fresh activity block for the next response turn", async () => {
  const { pi, handlers, appended } = makePiStub();
  const { ctx, setIdle } = makeCtx();
  activityBlockExtension(pi);

  const firstTurn = await triggerTurnResponse(handlers, ctx, "initial", 0);
  assert.equal(firstTurn?.message?.details?.turnDisplayId, "1");

  setIdle(false);
  await handlers.get("input")({ type: "input", text: "steer now", source: "interactive" }, ctx);
  await handlers.get("message_start")({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "steer now" }] },
  }, ctx);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "activity-block-state");
  assert.equal(appended[0].data.turnId, firstTurn?.message?.details?.turnId);
  assert.equal(appended[0].data.snapshot.finalLabel, "Interrupted by steering");

  const secondTurn = await triggerTurnResponse(handlers, ctx, "steer now", 1);
  assert.equal(secondTurn?.message?.details?.turnDisplayId, "2");
  assert.equal(appended.length, 1);
});
