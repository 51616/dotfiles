import test from "node:test";
import assert from "node:assert/strict";

import { resolveInputAction } from "../lib/app-input.ts";

const LEFT_ARROW = "\x1b[D";
const RIGHT_ARROW = "\x1b[C";

test("left/right arrows switch panes directionally", () => {
  assert.deepEqual(resolveInputAction({
    data: RIGHT_ARROW,
    focusMode: "files",
    hasFile: true,
    bodyHeight: 10,
  }), { type: "switchPane" });

  assert.deepEqual(resolveInputAction({
    data: LEFT_ARROW,
    focusMode: "diff",
    hasFile: true,
    bodyHeight: 10,
  }), { type: "switchPane" });

  assert.deepEqual(resolveInputAction({
    data: LEFT_ARROW,
    focusMode: "files",
    hasFile: true,
    bodyHeight: 10,
  }), { type: "none" });

  assert.deepEqual(resolveInputAction({
    data: RIGHT_ARROW,
    focusMode: "diff",
    hasFile: true,
    bodyHeight: 10,
  }), { type: "none" });
});

test("brackets move between contiguous changed chunks in diff focus", () => {
  assert.deepEqual(resolveInputAction({
    data: "]",
    focusMode: "diff",
    hasFile: true,
    bodyHeight: 10,
  }), { type: "moveChangeBlock", direction: 1 });

  assert.deepEqual(resolveInputAction({
    data: "[",
    focusMode: "diff",
    hasFile: true,
    bodyHeight: 10,
  }), { type: "moveChangeBlock", direction: -1 });

  assert.deepEqual(resolveInputAction({
    data: "]",
    focusMode: "files",
    hasFile: true,
    bodyHeight: 10,
  }), { type: "none" });
});

test("phase 11 shortcuts map to range, peek, and comment navigation actions", () => {
  assert.deepEqual(resolveInputAction({ data: "t", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "switchScope", scope: "t" });
  assert.deepEqual(resolveInputAction({ data: "v", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "peekCommentsAtCursor" });
  assert.deepEqual(resolveInputAction({ data: "h", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "createRangeComment" });
  assert.deepEqual(resolveInputAction({ data: "x", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "toggleRangeSelection" });
  assert.deepEqual(resolveInputAction({ data: "n", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "jumpComment", direction: 1, fileOnly: false });
  assert.deepEqual(resolveInputAction({ data: ".", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "jumpComment", direction: 1, fileOnly: true });
  assert.deepEqual(resolveInputAction({ data: "w", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "jumpCommentFile", staleOnly: false });
  assert.deepEqual(resolveInputAction({ data: "z", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "jumpCommentFile", staleOnly: true });
});

test("space toggles the current hunk only in diff focus", () => {
  assert.deepEqual(resolveInputAction({ data: " ", focusMode: "diff", hasFile: true, bodyHeight: 10 }), { type: "toggleHunkRejected" });
  assert.deepEqual(resolveInputAction({ data: " ", focusMode: "files", hasFile: true, bodyHeight: 10 }), { type: "none" });
});
