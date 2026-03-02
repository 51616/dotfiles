import test from "node:test";
import assert from "node:assert/strict";
import selfCheckpointing from "../self-checkpointing/index.ts";

function makePiStub() {
  const handlers = new Map();
  const commands = new Map();

  const pi = {
    on(name, handler) {
      handlers.set(String(name), handler);
    },
    registerCommand(name, spec) {
      commands.set(String(name), spec);
    },
    sendMessage() {},
    sendUserMessage() {},
  };

  return { pi, handlers, commands };
}

test("self-checkpointing entrypoint registers expected hooks and /autockpt command", () => {
  const { pi, handlers, commands } = makePiStub();

  // Should not throw on init.
  selfCheckpointing(pi);

  // Command
  assert.ok(commands.has("autockpt"));

  // Event hooks
  for (const name of [
    "session_start",
    "turn_start",
    "turn_end",
    "session_shutdown",
    "session_compact",
    "input",
    "tool_result",
    "message_end",
  ]) {
    assert.equal(typeof handlers.get(name), "function", `missing handler: ${name}`);
  }
});
