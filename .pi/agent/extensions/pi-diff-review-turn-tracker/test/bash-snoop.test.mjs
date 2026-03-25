import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { snoopedBashPaths } from "../lib/bash-snoop.ts";

test("snoopedBashPaths captures explicit rm/mv commands", () => {
  const cwd = "/tmp/demo";
  assert.deepEqual(snoopedBashPaths("rm src/a.ts src/b.ts", cwd), [
    path.resolve(cwd, "src/a.ts"),
    path.resolve(cwd, "src/b.ts"),
  ]);
  assert.deepEqual(snoopedBashPaths("git mv old.ts new.ts", cwd), [
    path.resolve(cwd, "old.ts"),
    path.resolve(cwd, "new.ts"),
  ]);
});

test("snoopedBashPaths ignores shell-y commands", () => {
  const cwd = "/tmp/demo";
  assert.deepEqual(snoopedBashPaths("rm *.ts", cwd), []);
  assert.deepEqual(snoopedBashPaths("rm a.ts && rm b.ts", cwd), []);
  assert.deepEqual(snoopedBashPaths("find . -name '*.ts' -delete", cwd), []);
});
