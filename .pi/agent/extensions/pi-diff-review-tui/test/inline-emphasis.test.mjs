import test from "node:test";
import assert from "node:assert/strict";

import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { buildInlineEmphasisMap, collectChangedClusters, pairChangedClusterRows, diffTokenRanges } from "../lib/inline-emphasis.ts";

function parsePatch(lines) {
  return parseSingleFilePatch({
    rawPatch: lines.join("\n"),
    status: "M",
    oldPath: "src/example.ts",
    newPath: "src/example.ts",
  });
}

test("collectChangedClusters splits contiguous changed blocks on context rows", () => {
  const file = parsePatch([
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,5 +1,5 @@",
    "-const firstOld = oldCall();",
    "+const firstNew = newCall();",
    " const stable = keep();",
    "-const secondOld = oldValue;",
    "+const secondNew = newValue;",
  ]);

  const clusters = collectChangedClusters(file);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0]?.removed.length, 1);
  assert.equal(clusters[1]?.added.length, 1);
});

test("pairChangedClusterRows keeps confident one-to-one pairings only", () => {
  const file = parsePatch([
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,4 +1,4 @@",
    "-const keepMe = oldCall(alpha);",
    "-totallyDifferentRewrite(one, two, three);",
    "+const keepMe = newCall(alpha);",
    "+return fromSomewhereElse(now);",
  ]);

  const cluster = collectChangedClusters(file)[0];
  assert.ok(cluster);
  const pairings = pairChangedClusterRows(cluster);
  assert.equal(pairings.length, 1);

  const removedRow = file.rows[pairings[0].removedRowIndex];
  const addedRow = file.rows[pairings[0].addedRowIndex];
  assert.match(removedRow?.text ?? "", /oldCall/);
  assert.match(addedRow?.text ?? "", /newCall/);
});

test("buildInlineEmphasisMap leaves ambiguous rewrites unpaired", () => {
  const file = parsePatch([
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,4 +1,4 @@",
    "-oldAlpha(one);",
    "-oldBeta(two);",
    "+brandNewGamma(three);",
    "+brandNewDelta(four);",
  ]);

  const emphasis = buildInlineEmphasisMap(file);
  assert.equal(emphasis.size, 0);
});

test("buildInlineEmphasisMap pairs template-literal edits with strong shared edges", () => {
  const file = parsePatch([
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,2 +1,2 @@",
    "-  return `${count} item(s)`;",
    "+  return `${count} item${count === 1 ? \"\" : \"s\"}`;",
  ]);

  const emphasis = buildInlineEmphasisMap(file);
  const changedRows = file.rows.filter((row) => row.kind === "removed" || row.kind === "added");
  assert.deepEqual(Array.from(emphasis.keys()), changedRows.map((row) => row.rowIndex));
  assert.ok((emphasis.get(changedRows[0]?.rowIndex ?? -1) ?? []).length > 0);
  assert.ok((emphasis.get(changedRows[1]?.rowIndex ?? -1) ?? []).length > 0);
});

test("pairChangedClusterRows follows delta-style homolog pairing for structural rewrites", () => {
  const file = parsePatch([
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,2 +1,2 @@",
    "-return queueTask(output, user, theme, limit);",
    "+return createFormatter(locale, compact, theme, limit);",
  ]);

  const cluster = collectChangedClusters(file)[0];
  assert.ok(cluster);
  const pairings = pairChangedClusterRows(cluster);
  assert.equal(pairings.length, 1);
  assert.ok(pairings[0].score > 0.45);

  const emphasis = buildInlineEmphasisMap(file);
  const changedRows = file.rows.filter((row) => row.kind === "removed" || row.kind === "added");
  assert.deepEqual(Array.from(emphasis.keys()), changedRows.map((row) => row.rowIndex));
});

test("diffTokenRanges marks only changed token spans", () => {
  const ranges = diffTokenRanges(
    "const answer = oldCall(alpha, beta);",
    "const answer = newCall(alpha, gamma);",
  );

  assert.deepEqual(ranges.removed, [
    { start: 15, end: 22 },
    { start: 30, end: 34 },
  ]);
  assert.deepEqual(ranges.added, [
    { start: 15, end: 22 },
    { start: 30, end: 35 },
  ]);
});
