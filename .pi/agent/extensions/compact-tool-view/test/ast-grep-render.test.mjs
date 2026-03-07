import test from "node:test";
import assert from "node:assert/strict";
import { buildAstGrepCallSummary } from "../lib/ast-grep-render.ts";

test("buildAstGrepCallSummary includes the key ast-grep args", () => {
  const summary = buildAstGrepCallSummary({
    pattern: "const $A = $B",
    lang: "ts",
    paths: ["src", "test", "docs"],
    globs: ["**/*.ts", "!dist/**"],
    rewrite: "let $A = $B",
    apply: true,
    context: 2,
    json: "pretty",
    timeoutMs: 5000,
  });

  assert.match(summary, /pattern=/);
  assert.match(summary, /lang=ts/);
  assert.match(summary, /paths=src, test \+1/);
  assert.match(summary, /globs=\*\*\/\*\.ts, !dist\/\*\*/);
  assert.match(summary, /rewrite=/);
  assert.match(summary, /apply=true/);
  assert.match(summary, /context=2/);
  assert.match(summary, /json=pretty/);
  assert.match(summary, /timeoutMs=5000/);
});

test("buildAstGrepCallSummary truncates long inline pattern text", () => {
  const summary = buildAstGrepCallSummary({
    pattern: "x".repeat(120),
  });

  assert.match(summary, /pattern=/);
  assert.match(summary, /…/);
});
