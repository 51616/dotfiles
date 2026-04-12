import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandPromptTemplateCommand } from "../pi-instance-manager/lib/pi-instance-manager-command-expansion.ts";

test("expandPromptTemplateCommand expands prompt-template arguments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-prompt-"));
  const templatePath = path.join(dir, "implement.md");
  fs.writeFileSync(
    templatePath,
    [
      "---",
      "description: Implement a change",
      "---",
      "Implement $1 with ${@:2}.",
      "All args: $ARGUMENTS",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const expanded = expandPromptTemplateCommand('/implement cache "event hooks" now', {
      getCommands: () => [
        {
          name: "implement",
          source: "prompt",
          sourceInfo: { path: templatePath },
        },
      ],
    });

    assert.equal(expanded.trim(), "Implement cache with event hooks now.\nAll args: cache event hooks now");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expandPromptTemplateCommand ignores non-prompt slash commands", () => {
  const raw = "/implement cache";
  const expanded = expandPromptTemplateCommand(raw, {
    getCommands: () => [
      {
        name: "implement",
        source: "extension",
        sourceInfo: { path: "/tmp/unused.ts" },
      },
    ],
  });

  assert.equal(expanded, raw);
});
