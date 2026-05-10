import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const SEARCH_ROOTS = [
  "/home/tan/.pi/agent/extensions/tui-broker",
  "/home/tan/.pi/agent/extensions/goal",
  "/home/tan/.pi/agent/extensions/git-state",
  "/home/tan/.pi/agent/extensions/pi-ssh",
  "/home/tan/.pi/agent/git/github.com/SamuelLHuber/pi-fff/src",
];

const ALLOWED_FOOTER_OWNERS = new Set([
  "/home/tan/.pi/agent/extensions/tui-broker/index.ts",
  "/home/tan/.pi/agent/extensions/pi-ssh/index.ts",
]);

const ALLOWED_EDITOR_OWNERS = new Set([
  "/home/tan/.pi/agent/extensions/tui-broker/index.ts",
  "/home/tan/.pi/agent/extensions/goal/index.ts",
  "/home/tan/.pi/agent/git/github.com/SamuelLHuber/pi-fff/src/index.ts",
]);

const PI_FFF_INDEX = "/home/tan/.pi/agent/git/github.com/SamuelLHuber/pi-fff/src/index.ts";

function astGrepPaths(pattern, roots = SEARCH_ROOTS) {
  const stdout = execFileSync("ast-grep", ["--lang", "ts", "--pattern", pattern, ...roots], {
    encoding: "utf8",
  });

  return Array.from(
    new Set(
      stdout
        .split("\n")
        .map((line) => line.match(/^(\/.*?):\d+:/)?.[1])
        .filter(Boolean)
        .filter((filePath) => !filePath.includes("/node_modules/")),
    ),
  ).sort();
}

test("only approved local extensions call ctx.ui.setFooter directly", () => {
  const paths = astGrepPaths("ctx.ui.setFooter($X)");
  assert.deepEqual(paths, [...ALLOWED_FOOTER_OWNERS].sort());
});

test("only approved local extensions call ctx.ui.setEditorComponent directly", () => {
  const paths = astGrepPaths("ctx.ui.setEditorComponent($X)");
  assert.deepEqual(paths, [...ALLOWED_EDITOR_OWNERS].sort());
});

test("pi-fff keeps the broker interop handoff in its entrypoint", () => {
  assert.deepEqual(astGrepPaths("applyFffEditorMode($X)", [PI_FFF_INDEX]), [PI_FFF_INDEX]);
  assert.deepEqual(astGrepPaths("isTuiBrokerInstalled()", [PI_FFF_INDEX]), [PI_FFF_INDEX]);
  assert.deepEqual(astGrepPaths("registerTuiBrokerAutocompleteProviderWrapper($X)", [PI_FFF_INDEX]), [PI_FFF_INDEX]);
  assert.deepEqual(astGrepPaths("requestTuiBrokerEditorReinstall()", [PI_FFF_INDEX]), [PI_FFF_INDEX]);
});
