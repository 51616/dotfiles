import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ENTRYPOINT = "../command-palette/index.ts";
const PROMPT_HELPERS_ENTRYPOINT = "../command-palette/lib/prompt-templates.ts";

async function loadModule() {
  return import(ENTRYPOINT);
}

async function loadPromptHelpers() {
  return import(PROMPT_HELPERS_ENTRYPOINT);
}

test("command-palette entrypoint imports cleanly", async () => {
  const mod = await loadModule();
  assert.equal(typeof mod.default, "function");
});

test("buildPaletteCommands keeps built-ins and appends dynamic commands", async () => {
  const { buildPaletteCommands } = await loadModule();
  const commands = buildPaletteCommands([
    {
      name: "foo",
      description: "demo",
      source: "extension",
      sourceInfo: {
        path: "/tmp/foo.ts",
        source: "file",
        scope: "project",
        origin: "top-level",
      },
    },
    {
      name: "model",
      description: "extension collision",
      source: "extension",
      sourceInfo: {
        path: "/tmp/model.ts",
        source: "file",
        scope: "project",
        origin: "top-level",
      },
    },
  ]);

  assert.equal(commands.filter((command) => command.name === "model").length, 1);
  assert.equal(commands.find((command) => command.name === "model")?.source, "builtin");
  assert.equal(commands.find((command) => command.name === "foo")?.source, "extension");
});

test("isDirectlyExecutable marks supported built-ins and prompt templates", async () => {
  const { isDirectlyExecutable } = await loadModule();

  assert.equal(isDirectlyExecutable({ name: "compact", source: "builtin" }), true);
  assert.equal(
    isDirectlyExecutable({ name: "investigate", source: "prompt", path: "/tmp/investigate.md" }),
    true,
  );
  assert.equal(isDirectlyExecutable({ name: "reload", source: "builtin" }), false);
  assert.equal(isDirectlyExecutable({ name: "skill:foo", source: "skill" }), false);
});

test("prompt template helper preserves pi arg semantics and line-prefix rules", async () => {
  const {
    buildPromptTemplateInsertionText,
    getFallbackCurrentLineText,
    parsePromptTemplateArgs,
    substitutePromptTemplateArgs,
  } = await loadPromptHelpers();

  const args = parsePromptTemplateArgs('Button "click handler" tail');
  assert.deepEqual(args, ["Button", "click handler", "tail"]);
  assert.equal(
    substitutePromptTemplateArgs("Name: $1 | Rest: ${@:2} | All: $@", args),
    "Name: Button | Rest: click handler tail | All: Button click handler tail",
  );
  assert.equal(buildPromptTemplateInsertionText("Body", "existing work"), "\n\nBody");
  assert.equal(buildPromptTemplateInsertionText("Body", "   "), "Body");
  assert.equal(getFallbackCurrentLineText("first\nsecond"), "second");
});


test("shouldConfirmReplacement only for non-slash drafts", async () => {
  const { shouldConfirmReplacement } = await loadModule();

  assert.equal(shouldConfirmReplacement(""), false);
  assert.equal(shouldConfirmReplacement("   "), false);
  assert.equal(shouldConfirmReplacement("/reload "), false);
  assert.equal(shouldConfirmReplacement("draft work"), true);
});

test("command palette overlay keeps a stable height as filtering changes", async () => {
  const { CommandPaletteOverlay, buildPaletteCommands } = await loadModule();
  const tui = { requestRender() {} };
  const theme = {
    fg(_token, text) {
      return text;
    },
    bg(_token, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
  const commands = buildPaletteCommands(
    Array.from({ length: 12 }, (_, index) => ({
      name: `extra-${index}`,
      description: `extra command ${index}`,
      source: "extension",
      sourceInfo: {
        path: `/tmp/extra-${index}.ts`,
        source: "file",
        scope: "project",
        origin: "top-level",
      },
    })),
  );

  const manyMatches = new CommandPaletteOverlay(tui, theme, commands, "extra", () => {});
  const singleMatch = new CommandPaletteOverlay(tui, theme, commands, "extra-0", () => {});
  const noMatches = new CommandPaletteOverlay(tui, theme, commands, "does-not-exist", () => {});

  const manyHeight = manyMatches.render(80).length;
  assert.equal(singleMatch.render(80).length, manyHeight);
  assert.equal(noMatches.render(80).length, manyHeight);
});

test("command palette executes prompt templates with inline insertion", async () => {
  const { executePaletteCommand } = await loadModule();
  const promptDir = mkdtempSync(join(tmpdir(), "command-palette-prompts-"));
  const promptPath = join(promptDir, "investigate.md");
  writeFileSync(
    promptPath,
    [
      "---",
      "description: Investigate with a target",
      "---",
      "Investigate $1 thoroughly.",
      "Keep notes for $@.",
      "",
    ].join("\n"),
  );

  const calls = [];
  const ctx = {
    ui: {
      async input(title, placeholder) {
        calls.push({ type: "input", title, placeholder });
        return 'api "error budget"';
      },
      pasteToEditor(text) {
        calls.push({ type: "paste", text });
      },
      notify(message, level) {
        calls.push({ type: "notify", message, level });
      },
      setEditorText(text) {
        calls.push({ type: "setEditorText", text });
      },
    },
  };

  await executePaletteCommand(
    { name: "investigate", source: "prompt", path: promptPath },
    ctx,
    {},
    "already typing here",
  );

  assert.deepEqual(calls, [
    {
      type: "input",
      title: "Prompt template arguments",
      placeholder: "Arguments for /investigate (quote multi-word values if needed)",
    },
    {
      type: "paste",
      text: "\n\nInvestigate api thoroughly.\nKeep notes for api error budget.",
    },
    {
      type: "notify",
      message: "Inserted /investigate at cursor.",
      level: "info",
    },
  ]);
});


test("command palette overlay keeps the footer row present for short result sets", async () => {
  const { CommandPaletteOverlay } = await loadModule();
  const tui = { requestRender() {} };
  const theme = {
    fg(_token, text) {
      return text;
    },
    bg(_token, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
  const commands = [
    { name: "reload", description: "Reload", source: "builtin" },
    { name: "resume", description: "Resume", source: "builtin" },
  ];

  const overlay = new CommandPaletteOverlay(tui, theme, commands, "reload", () => {});
  const rendered = overlay.render(80);

  assert.match(rendered.at(-2), /Showing 1 of 1/);
});
