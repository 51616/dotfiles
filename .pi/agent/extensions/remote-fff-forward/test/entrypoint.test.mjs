import test from "node:test";
import assert from "node:assert/strict";

import remoteFffForwardExtension from "../index.ts";
import { __publishActivePiSshSessionForTests } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

function makeFakePi(flags = {}) {
  const tools = [];
  const toolMap = new Map();
  const commands = new Map();
  const events = new Map();
  return {
    tools,
    toolMap,
    commands,
    events,
    api: {
      getFlag(name) {
        return flags[name];
      },
      registerTool(tool) {
        tools.push(tool);
        toolMap.set(tool.name, tool);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      on(name, handler) {
        events.set(name, handler);
      },
    },
  };
}

test("remote FFF tools stay inert without SSH state", () => {
  __publishActivePiSshSessionForTests(null);
  const fake = makeFakePi();
  remoteFffForwardExtension(fake.api);

  assert.deepEqual(fake.tools.map((tool) => tool.name), []);
  assert.ok(fake.commands.has("remote-fff-health"));
  assert.ok(fake.commands.has("remote-fff-restart"));
});

test("remote FFF registers fffind and ffgrep immediately when --ssh is set", () => {
  __publishActivePiSshSessionForTests(null);
  const fake = makeFakePi({ ssh: "gcp_slurm_sakana_eu:/tmp/project" });
  remoteFffForwardExtension(fake.api);

  assert.deepEqual(fake.tools.map((tool) => tool.name).sort(), ["fffind", "ffgrep"]);
  assert.equal(fake.tools.find((tool) => tool.name === "fffind").label, "fffind");
  assert.equal(fake.tools.find((tool) => tool.name === "ffgrep").label, "ffgrep");
});

test("remote FFF can register on session_start when SSH flag appears later", async () => {
  __publishActivePiSshSessionForTests(null);
  const flags = {};
  const fake = makeFakePi(flags);
  remoteFffForwardExtension(fake.api);

  flags.ssh = "gcp_slurm_sakana_eu:/tmp/project";
  await fake.events.get("session_start")({ reason: "test" }, {});

  assert.deepEqual(fake.tools.map((tool) => tool.name).sort(), ["fffind", "ffgrep"]);
});

test("remote FFF re-registers on session_start so it wins tool override order", async () => {
  __publishActivePiSshSessionForTests(null);
  const fake = makeFakePi({ ssh: "gcp_slurm_sakana_eu:/tmp/project" });
  remoteFffForwardExtension(fake.api);

  await fake.events.get("session_start")({ reason: "test" }, {});

  assert.deepEqual(fake.tools.map((tool) => tool.name), ["ffgrep", "fffind", "ffgrep", "fffind"]);
  assert.deepEqual([...fake.toolMap.keys()].sort(), ["fffind", "ffgrep"]);
});
