import test from "node:test";
import assert from "node:assert/strict";

import skillUriExtension from "../index.ts";
import {
  __resetSkillUriBackendProvidersForTests,
  getActiveSkillUriBackend,
  registerSkillUriBackendProvider,
} from "../lib/backend-runtime.ts";

function createFakePi() {
  const tools = new Map();
  const events = new Map();

  return {
    tools,
    events,
    api: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      on(eventName, handler) {
        events.set(eventName, handler);
      },
    },
  };
}

test("last registered active backend wins", () => {
  __resetSkillUriBackendProvidersForTests();
  registerSkillUriBackendProvider({
    key: "one",
    isActive: () => true,
    createReadOps: () => {
      throw new Error("unused");
    },
    createWriteOps: () => {
      throw new Error("unused");
    },
    createEditOps: () => {
      throw new Error("unused");
    },
    createBashOps: () => {
      throw new Error("unused");
    },
    getRemoteContext: () => null,
    getConnectionInfo: () => null,
  });
  registerSkillUriBackendProvider({
    key: "two",
    isActive: () => true,
    createReadOps: () => {
      throw new Error("unused");
    },
    createWriteOps: () => {
      throw new Error("unused");
    },
    createEditOps: () => {
      throw new Error("unused");
    },
    createBashOps: () => {
      throw new Error("unused");
    },
    getRemoteContext: () => null,
    getConnectionInfo: () => null,
  });

  assert.equal(getActiveSkillUriBackend()?.key, "two");
});

test("read delegates non-skill paths to the active backend", async () => {
  __resetSkillUriBackendProvidersForTests();
  registerSkillUriBackendProvider({
    key: "backend",
    isActive: () => true,
    createReadOps: () => ({
      readFile: async () => Buffer.from("from-backend\n", "utf-8"),
      access: async () => {},
      detectImageMimeType: async () => null,
    }),
    createWriteOps: () => {
      throw new Error("unused");
    },
    createEditOps: () => {
      throw new Error("unused");
    },
    createBashOps: () => {
      throw new Error("unused");
    },
    getRemoteContext: () => ({
      remoteHome: "/remote/home",
      transport: {
        readFile: async () => Buffer.from("", "utf-8"),
        writeFile: async () => {},
      },
    }),
    getConnectionInfo: () => null,
  });

  const fake = createFakePi();
  skillUriExtension(fake.api);

  const readTool = fake.tools.get("read");
  assert.ok(readTool);
  const result = await readTool.execute("read-1", { path: "README.md" });
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, "from-backend\n");
});
