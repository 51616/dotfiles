import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import skillUriExtension from "../index.ts";
import { buildSkillUri, encodeSkillId } from "../lib/skill-uris.ts";
import { __resetSkillUriBackendProvidersForTests } from "../lib/backend-runtime.ts";

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

test("local mode read/write/edit tools support canonical skill uris", async () => {
  __resetSkillUriBackendProvidersForTests();

  const base = await mkdtemp(join(tmpdir(), "skill-uri-local-tools-"));
  const skillRoot = join(base, "demo-skill");
  await mkdir(join(skillRoot, "scripts"), { recursive: true });
  await mkdir(join(skillRoot, "templates"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n", "utf-8");
  await writeFile(join(skillRoot, "scripts", "demo.txt"), "hello\n", "utf-8");
  await writeFile(join(skillRoot, "templates", "note.txt"), "before\n", "utf-8");

  const fake = createFakePi();
  skillUriExtension(fake.api);

  const beforeAgentStart = fake.events.get("before_agent_start");
  assert.equal(typeof beforeAgentStart, "function");

  const prompt = [
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>demo</name>",
    "    <description>demo skill</description>",
    `    <location>${join(skillRoot, "SKILL.md")}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  const updated = await beforeAgentStart({ systemPrompt: prompt }, { hasUI: false });
  assert.match(updated.systemPrompt, /skill:\/\/demo\/SKILL\.md/);

  const readTool = fake.tools.get("read");
  const writeTool = fake.tools.get("write");
  const editTool = fake.tools.get("edit");
  assert.ok(readTool);
  assert.ok(writeTool);
  assert.ok(editTool);

  const scriptUri = buildSkillUri(encodeSkillId("demo"), "scripts/demo.txt");
  const readResult = await readTool.execute("read-1", { path: scriptUri });
  assert.equal(readResult.content[0].type, "text");
  assert.equal(readResult.content[0].text, "hello\n");

  const noteUri = buildSkillUri(encodeSkillId("demo"), "templates/note.txt");
  await writeTool.execute("write-1", { path: noteUri, content: "after\n" });
  assert.equal(await readFile(join(skillRoot, "templates", "note.txt"), "utf-8"), "after\n");

  await editTool.execute("edit-1", {
    path: noteUri,
    edits: [
      {
        oldText: "after\n",
        newText: "edited\n",
      },
    ],
  });
  assert.equal(await readFile(join(skillRoot, "templates", "note.txt"), "utf-8"), "edited\n");
});
