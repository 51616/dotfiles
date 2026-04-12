import test from "node:test";
import assert from "node:assert/strict";

import {
  CURRENT_DATE_MARKER,
  PROJECT_CONTEXT_SECTION,
  PROMPT_CONTEXT_END_MARKER,
  PROMPT_CONTEXT_STATUS_MARKER,
  SKILLS_SECTION_MARKER,
  injectPromptContextFile,
  parsePromptContextProbeOutput,
  resolvePreferredPromptContextFile,
} from "../lib/remote-context.ts";

test("resolvePreferredPromptContextFile prefers AGENTS.md in remoteCwd", async () => {
  const calls = [];
  const result = await resolvePreferredPromptContextFile("/remote/worktree", async (path) => {
    calls.push(path);
    if (path.endsWith("/AGENTS.md")) {
      return "remote-agents";
    }
    if (path.endsWith("/CLAUDE.md")) {
      return "remote-claude";
    }
    return null;
  });

  assert.deepEqual(calls, ["/remote/worktree/AGENTS.md"]);
  assert.deepEqual(result, {
    file: {
      path: "/remote/worktree/AGENTS.md",
      content: "remote-agents",
    },
    warnings: [],
  });
});

test("resolvePreferredPromptContextFile falls back to CLAUDE.md when AGENTS.md is absent", async () => {
  const calls = [];
  const result = await resolvePreferredPromptContextFile("/remote/worktree", async (path) => {
    calls.push(path);
    if (path.endsWith("/CLAUDE.md")) {
      return "remote-claude";
    }
    return null;
  });

  assert.deepEqual(calls, ["/remote/worktree/AGENTS.md", "/remote/worktree/CLAUDE.md"]);
  assert.deepEqual(result, {
    file: {
      path: "/remote/worktree/CLAUDE.md",
      content: "remote-claude",
    },
    warnings: [],
  });
});

test("resolvePreferredPromptContextFile returns null when no remote context file exists", async () => {
  const result = await resolvePreferredPromptContextFile("/remote/worktree", async () => null);
  assert.deepEqual(result, { file: null, warnings: [] });
});

test("resolvePreferredPromptContextFile warns and stops when AGENTS.md errors", async () => {
  const calls = [];
  const result = await resolvePreferredPromptContextFile("/remote/worktree", async (path) => {
    calls.push(path);
    if (path.endsWith("/AGENTS.md")) {
      throw new Error("AGENTS unreadable");
    }
    if (path.endsWith("/CLAUDE.md")) {
      return "remote-claude";
    }
    return null;
  });

  assert.deepEqual(calls, ["/remote/worktree/AGENTS.md"]);
  assert.deepEqual(result, {
    file: null,
    warnings: ["AGENTS unreadable"],
  });
});

test("parsePromptContextProbeOutput returns decoded content when marker output is valid", () => {
  const encoded = Buffer.from("remote-rules", "utf-8").toString("base64");
  const stdout = [
    "shell noise before marker",
    `${PROMPT_CONTEXT_STATUS_MARKER}ok`,
    encoded,
    PROMPT_CONTEXT_END_MARKER,
  ].join("\n");

  assert.equal(parsePromptContextProbeOutput(stdout, "", "/remote/worktree/AGENTS.md"), "remote-rules");
});

test("parsePromptContextProbeOutput returns null for missing files", () => {
  const stdout = `${PROMPT_CONTEXT_STATUS_MARKER}missing\n`;
  assert.equal(parsePromptContextProbeOutput(stdout, "", "/remote/worktree/AGENTS.md"), null);
});

test("parsePromptContextProbeOutput throws for unreadable files", () => {
  const stdout = `${PROMPT_CONTEXT_STATUS_MARKER}unreadable\n`;
  assert.throws(
    () => parsePromptContextProbeOutput(stdout, "", "/remote/worktree/AGENTS.md"),
    /not a readable regular file/,
  );
});

test("injectPromptContextFile appends a file block inside an existing Project Context section", () => {
  const basePrompt = `System intro${PROJECT_CONTEXT_SECTION}## /local/AGENTS.md\n\nlocal-rules\n\nCurrent date: 2026-04-06\nCurrent working directory: /tmp/project`;

  const result = injectPromptContextFile(basePrompt, {
    path: "/remote/worktree/AGENTS.md",
    content: "remote-rules",
  });

  assert.match(result, /## \/local\/AGENTS\.md\n\nlocal-rules\n\n## \/remote\/worktree\/AGENTS\.md\n\nremote-rules\n\nCurrent date: 2026-04-06/s);
  assert.ok(result.includes(PROJECT_CONTEXT_SECTION));
  assert.equal((result.match(/# Project Context/g) ?? []).length, 1);
  assert.ok(!result.includes("ssh://"));
  assert.ok(!result.includes("Remote Project Context"));
  assert.ok(!result.includes("via SSH"));
});

test("resolvePreferredPromptContextFile only probes remoteCwd candidates", async () => {
  const calls = [];
  await resolvePreferredPromptContextFile("/remote/worktree", async (path) => {
    calls.push(path);
    return null;
  });

  assert.deepEqual(calls, ["/remote/worktree/AGENTS.md", "/remote/worktree/CLAUDE.md"]);
});

test("injectPromptContextFile creates a local-style Project Context section before skills when absent", () => {
  const basePrompt = [
    "System intro",
    "More rules",
    SKILLS_SECTION_MARKER.trim(),
    "Current date: 2026-04-06",
    "Current working directory: /tmp/project",
  ].join("\n\n");

  const result = injectPromptContextFile(basePrompt, {
    path: "/remote/worktree/CLAUDE.md",
    content: "remote-claude-rules",
  });

  const expectedBlock = `${PROJECT_CONTEXT_SECTION}## /remote/worktree/CLAUDE.md\n\nremote-claude-rules\n\n`;
  assert.ok(result.includes(expectedBlock));
  assert.ok(result.indexOf(expectedBlock) < result.indexOf(SKILLS_SECTION_MARKER.trim()));
  assert.ok(result.includes(CURRENT_DATE_MARKER.trimStart()));
});

test("injectPromptContextFile reuses an existing Project Context heading even when the intro text differs", () => {
  const basePrompt = "System intro\n\n# Project Context\n\nCustom intro text.\n\nCurrent date: 2026-04-06";
  const result = injectPromptContextFile(basePrompt, {
    path: "/remote/worktree/AGENTS.md",
    content: "remote-rules",
  });

  assert.equal((result.match(/# Project Context/g) ?? []).length, 1);
  assert.match(result, /Custom intro text\.\n\n## \/remote\/worktree\/AGENTS\.md/s);
});

test("injectPromptContextFile is idempotent for the same file block", () => {
  const withBlock = injectPromptContextFile("System intro\n\nCurrent date: 2026-04-06", {
    path: "/remote/worktree/AGENTS.md",
    content: "remote-rules",
  });

  const secondPass = injectPromptContextFile(withBlock, {
    path: "/remote/worktree/AGENTS.md",
    content: "remote-rules",
  });

  assert.equal(secondPass, withBlock);
});
