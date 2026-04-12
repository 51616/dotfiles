import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionRunner } from "@mariozechner/pi-coding-agent";
import commandContextForTools from "../command-context-for-tools/index.ts";

function withRestoredExtensionRunner(body) {
  const proto = ExtensionRunner.prototype;
  const originalCreateContext = proto.createContext;
  const originalPatchedFlag = proto.__commandContextForToolsPatched;

  return Promise.resolve()
    .then(() => body(proto))
    .finally(() => {
      proto.createContext = originalCreateContext;
      if (originalPatchedFlag === undefined) {
        delete proto.__commandContextForToolsPatched;
      } else {
        proto.__commandContextForToolsPatched = originalPatchedFlag;
      }
    });
}

test("command-context-for-tools grafts command-only session controls onto plain tool contexts", async () => {
  await withRestoredExtensionRunner(async (proto) => {
    const existingReload = () => "keep-existing-reload";

    delete proto.__commandContextForToolsPatched;
    proto.createContext = function createContext() {
      return {
        base: true,
        reload: existingReload,
      };
    };

    commandContextForTools({});

    const ctx = proto.createContext.call({
      waitForIdleFn: async () => "idle",
      newSessionHandler: async (options) => ({ kind: "new", options }),
      forkHandler: async (entryId) => ({ kind: "fork", entryId }),
      navigateTreeHandler: async (targetId, options) => ({ targetId, options }),
      switchSessionHandler: async (sessionPath) => ({ kind: "switch", sessionPath }),
      reloadHandler: async () => "replacement-reload",
    });

    assert.equal(ctx.base, true);
    assert.equal(await ctx.waitForIdle(), "idle");
    assert.deepEqual(await ctx.newSession({ draft: true }), { kind: "new", options: { draft: true } });
    assert.deepEqual(await ctx.fork("entry-1"), { kind: "fork", entryId: "entry-1" });
    assert.deepEqual(await ctx.navigateTree("entry-2", { summarize: true }), {
      targetId: "entry-2",
      options: { summarize: true },
    });
    assert.deepEqual(await ctx.switchSession("/tmp/session.jsonl"), {
      kind: "switch",
      sessionPath: "/tmp/session.jsonl",
    });
    assert.equal(ctx.reload, existingReload);
    assert.equal(ctx.reload(), "keep-existing-reload");
  });
});

test("command-context-for-tools patches ExtensionRunner.createContext only once", async () => {
  await withRestoredExtensionRunner(async (proto) => {
    delete proto.__commandContextForToolsPatched;
    proto.createContext = function createContext() {
      return {};
    };

    commandContextForTools({});
    const firstPatchedCreateContext = proto.createContext;

    commandContextForTools({});

    assert.equal(proto.__commandContextForToolsPatched, true);
    assert.equal(proto.createContext, firstPatchedCreateContext);
  });
});
