import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const SEARCH_ROOTS = [
  "/home/tan/.pi/agent/extensions/tui-broker",
  "/home/tan/.pi/agent/extensions/do-not-stop",
  "/home/tan/.pi/agent/extensions/pi-ssh",
  "/home/tan/.pi/agent/git/github.com/SamuelLHuber/pi-fff/src",
];

const ALLOWED_FOOTER_OWNERS = new Set([
  "/home/tan/.pi/agent/extensions/tui-broker/index.ts",
  "/home/tan/.pi/agent/extensions/pi-ssh/index.ts",
]);

const ALLOWED_EDITOR_OWNERS = new Set([
  "/home/tan/.pi/agent/extensions/tui-broker/index.ts",
  "/home/tan/.pi/agent/extensions/do-not-stop/index.ts",
  "/home/tan/.pi/agent/git/github.com/SamuelLHuber/pi-fff/src/index.ts",
]);

function astGrepPaths(pattern) {
  const stdout = execFileSync("ast-grep", ["--lang", "ts", "--pattern", pattern, ...SEARCH_ROOTS], {
    encoding: "utf8",
  });

  return Array.from(
    new Set(
      stdout
        .split("\n")
        .map((line) => line.match(/^(\/.*?):\d+:/)?.[1])
        .filter(Boolean),
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
