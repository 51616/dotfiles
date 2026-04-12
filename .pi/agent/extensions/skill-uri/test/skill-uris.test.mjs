import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";

import {
  SkillRegistry,
  SKILL_URI_READ_GUIDANCE,
  buildSkillUri,
  buildVirtualSkillPath,
  encodeSkillId,
  injectSkillUriReadGuidance,
  parseAvailableSkillsFromPrompt,
  rewriteAvailableSkillsLocations,
  skillUriToVirtualPath,
} from "../lib/skill-uris.ts";

function inferOriginHint(filePath) {
  if (filePath.includes("/.pi/agent/skills/")) return "global";
  if (filePath.includes("/.pi/skills/")) return "project";
  return "other";
}

test("parseAvailableSkillsFromPrompt extracts skills with raw file locations", () => {
  const prompt = [
    "System intro",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>pi-architecture</name>",
    "    <description>Architecture map</description>",
    "    <location>/home/tan/vault/.pi/skills/pi-architecture/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  assert.deepEqual(parseAvailableSkillsFromPrompt(prompt), [
    {
      name: "pi-architecture",
      description: "Architecture map",
      filePath: "/home/tan/vault/.pi/skills/pi-architecture/SKILL.md",
    },
  ]);
});

test("SkillRegistry keeps the last duplicate and emits a warning", () => {
  const registry = new SkillRegistry();
  const update = registry.updateFromPromptSkills(
    [
      {
        name: "demo",
        description: "global demo",
        filePath: "/home/tan/.pi/agent/skills/demo/SKILL.md",
      },
      {
        name: "demo",
        description: "project demo",
        filePath: "/home/tan/vault/.pi/skills/demo/SKILL.md",
      },
    ],
    {
      toRootPath: (filePath) => dirname(filePath),
      inferOriginHint,
    },
  );

  assert.equal(update.orderedEntries.length, 1);
  assert.equal(update.orderedEntries[0].filePath, "/home/tan/vault/.pi/skills/demo/SKILL.md");
  assert.equal(update.warnings.length, 1);
  assert.match(update.warnings[0].message, /last entry wins/i);
  assert.equal(registry.findByName("demo")?.filePath, "/home/tan/vault/.pi/skills/demo/SKILL.md");
});

test("SkillRegistry resolves virtual skill paths and blocks traversal", () => {
  const registry = new SkillRegistry();
  registry.updateFromPromptSkills(
    [
      {
        name: "pi-architecture",
        description: "Architecture map",
        filePath: "/home/tan/vault/.pi/skills/pi-architecture/SKILL.md",
      },
    ],
    {
      toRootPath: (filePath) => dirname(filePath),
      inferOriginHint,
    },
  );

  const encoded = encodeSkillId("pi-architecture");
  const resolved = registry.resolveVirtualPath(buildVirtualSkillPath(encoded, "SKILL.md"));
  assert.equal(resolved?.realPath, "/home/tan/vault/.pi/skills/pi-architecture/SKILL.md");
  assert.throws(() => registry.resolveVirtualPath(buildVirtualSkillPath(encoded, "../../etc/passwd")), /escapes root/i);
});

test("rewriteAvailableSkillsLocations keeps only the winning skills and injects skill uris", () => {
  const prompt = [
    "System intro",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>demo</name>",
    "    <description>global demo</description>",
    "    <location>/home/tan/.pi/agent/skills/demo/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>demo</name>",
    "    <description>project demo</description>",
    "    <location>/home/tan/vault/.pi/skills/demo/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  const rewritten = rewriteAvailableSkillsLocations(
    prompt,
    [
      {
        name: "demo",
        description: "project demo",
        filePath: "/home/tan/vault/.pi/skills/demo/SKILL.md",
      },
    ],
    (skill) => buildSkillUri(encodeSkillId(skill.name), "SKILL.md"),
  );

  assert.equal((rewritten.match(/<skill>/g) || []).length, 1);
  assert.match(rewritten, /skill:\/\/demo\/SKILL\.md/);
  assert.doesNotMatch(rewritten, /\/home\/tan\/\.pi\/agent\/skills\/demo/);
});

test("injectSkillUriReadGuidance is idempotent and mentions run_skill_script", () => {
  const prompt = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "<available_skills>",
    "</available_skills>",
  ].join("\n");

  const updated = injectSkillUriReadGuidance(prompt);
  assert.ok(updated.includes(SKILL_URI_READ_GUIDANCE));
  assert.match(updated, /full `skill:\/\/<skill-id>\/relative\/path` URI/i);
  assert.equal(injectSkillUriReadGuidance(updated), updated);
});

test("skillUriToVirtualPath rejects legacy source-prefixed uris", () => {
  assert.throws(() => skillUriToVirtualPath("skill://local/demo/SKILL.md"), /legacy skill uris/i);
});
