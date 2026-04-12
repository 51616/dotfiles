import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider, Editor, TUI } from "../node_modules/@mariozechner/pi-tui/dist/index.js";

const ENTRYPOINT = "../command-palette/index.ts";
const PROMPT_HELPERS_ENTRYPOINT = "../command-palette/lib/prompt-templates.ts";

async function loadModule() {
  return import(ENTRYPOINT);
}

async function loadPromptHelpers() {
  return import(PROMPT_HELPERS_ENTRYPOINT);
}

class StubTerminal {
  constructor(columns = 100, rows = 30) {
    this.columns = columns;
    this.rows = rows;
    this.kittyProtocolActive = false;
  }
  start() {}
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
}

function createEditorTheme() {
  return {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
}

function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b_pi:c\x07/g, "");
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
  assert.equal(isDirectlyExecutable({ name: "reload", source: "builtin" }), true);
  assert.equal(isDirectlyExecutable({ name: "new", source: "builtin" }), true);
  assert.equal(isDirectlyExecutable({ name: "resume", source: "builtin" }), true);
  assert.equal(
    isDirectlyExecutable({ name: "investigate", source: "prompt", path: "/tmp/investigate.md" }),
    true,
  );
  assert.equal(isDirectlyExecutable({ name: "model", source: "builtin" }), false);
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

test("empty palette query shows executable commands first", async () => {
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
    { name: "model", description: "Select model", source: "builtin" },
    { name: "reload", description: "Reload", source: "builtin" },
    { name: "spec", description: "Spec template", source: "prompt", path: "/tmp/spec.md" },
    { name: "skill:plan", description: "Skill", source: "skill" },
  ];

  const overlay = new CommandPaletteOverlay(tui, theme, commands, "", () => {});
  const rendered = overlay.render(80).slice(7, 11).join("\n");

  assert.match(rendered, /\/reload/);
  assert.match(rendered, /\/spec/);
  assert.match(rendered, /\/model/);
  assert.match(rendered, /\/skill:plan/);
  assert.ok(rendered.indexOf("/reload") < rendered.indexOf("/spec"));
  assert.ok(rendered.indexOf("/spec") < rendered.indexOf("/model"));
  assert.ok(rendered.indexOf("/model") < rendered.indexOf("/skill:plan"));
});

test("command palette flattens multiline descriptions for display", async () => {
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
    {
      name: "read-git-repo",
      description: "\nUse when: inspect a repo.\nDon’t use when: reading a web page.\n",
      source: "skill",
    },
  ];

  const overlay = new CommandPaletteOverlay(tui, theme, commands, "read-git-repo", () => {});
  const renderedLine = overlay.render(116).find((line) => line.includes("/read-git-repo"));

  assert.ok(renderedLine, "expected rendered command row");
  assert.match(renderedLine, /Use when: inspect a repo\. Don’t use when: reading a web page\./);
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

test("command palette frame width stays capped on wide renders", async () => {
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
  const commands = buildPaletteCommands([]);
  const overlay = new CommandPaletteOverlay(tui, theme, commands, "", () => {});
  const rendered = overlay.render(200);

  assert.equal(rendered[0].length, 116);
  assert.equal(rendered.at(-1).length, 116);
});


test("extension workspace pi-tui dependency matches coding-agent's tui range", async () => {
  const workspacePkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const codingAgentPkg = JSON.parse(
    readFileSync(new URL("../node_modules/@mariozechner/pi-coding-agent/package.json", import.meta.url), "utf8"),
  );

  assert.equal(
    workspacePkg.dependencies["@mariozechner/pi-tui"],
    codingAgentPkg.dependencies["@mariozechner/pi-tui"],
    "expected extensions to use the same pi-tui range as pi-coding-agent",
  );
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

  assert.match(rendered.at(-2), /Showing\s+1 of\s+1/);
});

test("command palette footer keeps a stable text width while scrolling", async () => {
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
    Array.from({ length: 6 }, (_, index) => ({
      name: `cmd-${index + 1}`,
      description: `command ${index + 1}`,
      source: "extension",
      sourceInfo: {
        path: `/tmp/cmd-${index + 1}.ts`,
        source: "file",
        scope: "project",
        origin: "top-level",
      },
    })),
  );
  const overlay = new CommandPaletteOverlay(tui, theme, commands, "", () => {});

  const widths = [];
  for (let step = 0; step < 20; step += 1) {
    const footer = stripAnsi(renderedFooter(overlay.render(80)));
    const innerText = footer.slice(2, -2).trimEnd();
    widths.push(innerText.length);
    overlay.handleInput("\u001b[B");
  }

  assert.equal(new Set(widths).size, 1);
});

function renderedFooter(renderedLines) {
  return renderedLines.at(-2) ?? "";
}

test("dismissFocusedEditorAutocomplete clears slash autocomplete before opening the palette", async () => {
  const { dismissFocusedEditorAutocomplete } = await loadModule();
  const terminal = new StubTerminal();
  const tui = new TUI(terminal);
  const editor = new Editor(tui, createEditorTheme());
  tui.addChild(editor);
  tui.setFocus(editor);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider([
      { name: "reload", description: "Reload runtime" },
      { name: "resume", description: "Resume session" },
    ]),
  );

  editor.handleInput("/");
  editor.handleInput("r");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(editor.isShowingAutocomplete(), true);

  dismissFocusedEditorAutocomplete(tui);

  assert.equal(editor.isShowingAutocomplete(), false);
});

test("palette status row stops inheriting underlying autocomplete text after dismissal", async () => {
  const { CommandPaletteOverlay, buildPaletteCommands, dismissFocusedEditorAutocomplete } = await loadModule();
  const terminal = new StubTerminal();
  const paletteTheme = {
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

  async function renderStatusLine(dismissAutocomplete) {
    const tui = new TUI(terminal);
    const editor = new Editor(tui, createEditorTheme());
    tui.addChild(editor);
    tui.setFocus(editor);
    editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider([
        { name: "reload", description: "Reload runtime" },
        { name: "resume", description: "Resume session" },
        { name: "report", description: "Write report" },
      ]),
    );
    editor.handleInput("/");
    editor.handleInput("r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    if (dismissAutocomplete) {
      dismissFocusedEditorAutocomplete(tui);
    }

    const overlay = new CommandPaletteOverlay(
      tui,
      paletteTheme,
      buildPaletteCommands([
        {
          name: "report",
          description: "Write report",
          source: "extension",
          sourceInfo: { path: "/tmp/report.ts", source: "file", scope: "project", origin: "top-level" },
        },
      ]),
      "r",
      () => {},
    );

    tui.showOverlay(overlay, {
      anchor: "top-center",
      width: "78%",
      minWidth: 64,
      maxHeight: "84%",
      margin: { top: 1, left: 2, right: 2 },
    });

    return stripAnsi(
      tui
        .compositeOverlays(tui.render(terminal.columns), terminal.columns, terminal.rows)
        .find((line) => line.includes("commands •")),
    );
  }

  const beforeDismiss = await renderStatusLine(false);
  const afterDismiss = await renderStatusLine(true);

  assert.match(beforeDismiss, /^→ reload\s+│/);
  assert.match(afterDismiss, /^\s+│/);
  assert.doesNotMatch(afterDismiss, /^→ reload\s+│/);
});
