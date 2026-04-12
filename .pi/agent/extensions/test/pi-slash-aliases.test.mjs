import test from "node:test";
import assert from "node:assert/strict";
import piSlash from "../pi-slash/index.ts";

function makePiStub() {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();

  const pi = {
    on(name, handler) {
      handlers.set(String(name), handler);
    },
    registerCommand(name, spec) {
      commands.set(String(name), spec);
    },
    registerTool(spec) {
      tools.set(String(spec.name), spec);
    },
    getCommands() {
      return [];
    },
    async setModel() {
      return true;
    },
    setThinkingLevel() {},
  };

  return { pi, commands, tools, handlers };
}

function makeCtx(overrides = {}) {
  let shutdownCalls = 0;
  let newSessionCalls = 0;
  let confirmCalls = 0;
  const navigateTreeCalls = [];
  const notifications = [];

  const ctx = {
    hasUI: true,
    isIdle: () => true,
    shutdown() {
      shutdownCalls += 1;
    },
    async newSession() {
      newSessionCalls += 1;
      return { cancelled: false };
    },
    async navigateTree(targetId, options) {
      navigateTreeCalls.push({ targetId, options });
      return { cancelled: false };
    },
    compact() {},
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => "Session 1",
      getSessionFile: () => "/tmp/session-1.jsonl",
      getCwd: () => process.cwd(),
      getSessionDir: () => ".pi/sessions",
      getHeader: () => ({ timestamp: "2026-03-25T00:00:00.000Z" }),
      getLeafId: () => "assistant-1",
      getTree: () => [
        {
          entry: {
            id: "user-1",
            parentId: null,
            timestamp: "2026-03-25T00:00:00.000Z",
            type: "message",
            message: { role: "user", content: "Root question" },
          },
          children: [
            {
              entry: {
                id: "assistant-1",
                parentId: "user-1",
                timestamp: "2026-03-25T00:00:01.000Z",
                type: "message",
                message: { role: "assistant", content: "Root answer" },
              },
              children: [],
            },
          ],
        },
      ],
    },
    modelRegistry: {
      find: () => null,
      refresh() {},
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      async confirm() {
        confirmCalls += 1;
        return true;
      },
      async select() {
        return "";
      },
    },
    ...overrides,
  };

  return {
    ctx,
    counts: () => ({ shutdownCalls, newSessionCalls, confirmCalls, navigateTreeCalls, notifications }),
  };
}

test("pi-slash registers interactive alias commands", () => {
  const { pi, commands } = makePiStub();

  piSlash(pi);

  assert.ok(commands.has("q"));
  assert.ok(commands.has("exit"));
  assert.ok(commands.has("clear"));
});

test("/q and /exit request shutdown, /clear starts a new session", async () => {
  const { pi, commands } = makePiStub();
  piSlash(pi);

  {
    const { ctx, counts } = makeCtx();
    await commands.get("q").handler("", ctx);
    assert.equal(counts().shutdownCalls, 1);
  }

  {
    const { ctx, counts } = makeCtx();
    await commands.get("exit").handler("", ctx);
    assert.equal(counts().shutdownCalls, 1);
  }

  {
    const { ctx, counts } = makeCtx();
    await commands.get("clear").handler("", ctx);
    assert.equal(counts().newSessionCalls, 1);
  }
});

test("pi_slash slash.run honors aliases and confirmation semantics", async () => {
  const { pi, tools } = makePiStub();
  piSlash(pi);

  const tool = tools.get("pi_slash");
  assert.ok(tool);

  {
    const { ctx, counts } = makeCtx();
    const result = await tool.execute(
      "tool-1",
      { op: "slash.run", command: "/clear" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.details.ok, true);
    assert.equal(counts().confirmCalls, 1);
    assert.equal(counts().newSessionCalls, 1);
  }

  {
    const { ctx, counts } = makeCtx();
    const result = await tool.execute(
      "tool-2",
      { op: "slash.run", command: "/q" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.details.ok, true);
    assert.equal(counts().confirmCalls, 0);
    assert.equal(counts().shutdownCalls, 1);
  }
});


test("pi_slash slash.run supports /tree listing and direct navigation", async () => {
  const { pi, tools } = makePiStub();
  piSlash(pi);

  const tool = tools.get("pi_slash");
  assert.ok(tool);

  {
    const { ctx } = makeCtx();
    const result = await tool.execute(
      "tool-tree-list",
      { op: "slash.run", command: "/tree" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.details.ok, true);
    assert.match(result.content[0].text, /Session Tree/);
    assert.match(result.content[0].text, /assistant-1/);
  }

  {
    const { ctx, counts } = makeCtx();
    const result = await tool.execute(
      "tool-tree-nav",
      { op: "slash.run", command: "/tree user-1 --summary" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.details.ok, true);
    assert.deepEqual(counts().navigateTreeCalls, [{ targetId: "user-1", options: { summarize: true } }]);
  }
});


test("pi_slash schedules /tree navigation until the turn finishes", async () => {
  const { pi, tools, handlers } = makePiStub();
  piSlash(pi);

  const tool = tools.get("pi_slash");
  assert.ok(tool);
  assert.ok(handlers.has("agent_end"));

  const { ctx, counts } = makeCtx({ isIdle: () => false });
  const result = await tool.execute(
    "tool-tree-scheduled",
    { op: "slash.run", command: "/tree user-1" },
    new AbortController().signal,
    undefined,
    ctx,
  );

  assert.equal(result.details.ok, true);
  assert.deepEqual(counts().navigateTreeCalls, []);

  await handlers.get("agent_end")(undefined, ctx);
  assert.deepEqual(counts().navigateTreeCalls, [{ targetId: "user-1", options: undefined }]);
});
