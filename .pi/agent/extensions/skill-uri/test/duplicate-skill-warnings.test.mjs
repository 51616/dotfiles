import test from "node:test";
import assert from "node:assert/strict";

import skillUriExtension from "../index.ts";
import { __resetPiSshSessionForTests } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

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

test("before_agent_start warns once and keeps the last duplicate skill", async () => {
  __resetPiSshSessionForTests();

  const fake = createFakePi();
  skillUriExtension(fake.api);
  const beforeAgentStart = fake.events.get("before_agent_start");
  assert.equal(typeof beforeAgentStart, "function");

  const warnings = [];
  const prompt = [
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>demo</name>",
    "    <description>global</description>",
    "    <location>/home/tan/.pi/agent/skills/demo/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>demo</name>",
    "    <description>project</description>",
    "    <location>/home/tan/vault/.pi/skills/demo/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  const ctx = {
    hasUI: true,
    ui: {
      notify(message, level) {
        warnings.push({ message, level });
      },
    },
  };

  const updated = await beforeAgentStart({ systemPrompt: prompt }, ctx);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, "warning");
  assert.match(warnings[0].message, /duplicate skill name 'demo'/i);
  assert.equal((updated.systemPrompt.match(/<skill>/g) || []).length, 1);
  assert.match(updated.systemPrompt, /skill:\/\/demo\/SKILL\.md/);

  await beforeAgentStart({ systemPrompt: prompt }, ctx);
  assert.equal(warnings.length, 1);
});
