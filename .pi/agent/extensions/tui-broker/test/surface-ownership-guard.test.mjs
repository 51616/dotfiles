import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// pi loads `npm:@ff-labs/pi-fff` (settings `packages`) from pi's agent package cache.
const PI_FFF_SRC = join(
  process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
  "npm/node_modules/@ff-labs/pi-fff/src",
);

const SEARCH_ROOTS = [
  "/home/tan/.pi/agent/extensions/tui-broker",
  "/home/tan/.pi/agent/extensions/goal",
  "/home/tan/.pi/agent/extensions/git-state",
  "/home/tan/.pi/agent/extensions/pi-ssh",
  PI_FFF_SRC,
];

const ALLOWED_FOOTER_OWNERS = new Set([
  "/home/tan/.pi/agent/extensions/tui-broker/index.ts",
  "/home/tan/.pi/agent/extensions/pi-ssh/index.ts",
]);

const ALLOWED_EDITOR_OWNERS = new Set([
  "/home/tan/.pi/agent/extensions/tui-broker/index.ts",
  "/home/tan/.pi/agent/extensions/goal/index.ts",
]);

function astGrepPaths(pattern, roots = SEARCH_ROOTS) {
  // ast-grep exits 1 when nothing matches; that is a valid (empty) result here.
  let stdout = "";
  try {
    stdout = execFileSync("ast-grep", ["--lang", "ts", "--pattern", pattern, ...roots], { encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1 || error.stderr?.toString().trim()) throw error;
  }

  // Skip only node_modules nested *inside* a search root. pi-fff itself is installed under
  // `.../npm/node_modules/`, so a plain `includes("/node_modules/")` filter would silently drop
  // every pi-fff match and make the ownership guards vacuous for it.
  const isNestedDependency = (filePath) => {
    const root = roots.find((candidate) => filePath.startsWith(`${candidate}/`));
    return root !== undefined && filePath.slice(root.length).includes("/node_modules/");
  };

  return Array.from(
    new Set(
      stdout
        .split("\n")
        .map((line) => line.match(/^(\/.*?):\d+:/)?.[1])
        .filter(Boolean)
        .filter((filePath) => !isNestedDependency(filePath)),
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

test("pi-fff contributes autocomplete through pi's provider stack", () => {
  // If this fails, pi-fff changed how it hooks autocomplete; re-check broker interop before patching.
  assert.deepEqual(astGrepPaths("ctx.ui.addAutocompleteProvider($$$)", [PI_FFF_SRC]), [join(PI_FFF_SRC, "index.ts")]);
});
