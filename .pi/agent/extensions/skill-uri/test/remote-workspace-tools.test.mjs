import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  executeRemoteEditTool,
  executeRemoteReadTool,
  executeRemoteWriteTool,
  resolveRemoteWorkspaceToolPath,
} from "../lib/remote-workspace-tools.ts";

// @lat: [[tests#Remote-native workspace file operations]]

const CWD = "/local/worktree";

function textReadResult(overrides = {}) {
  const content = overrides.content ?? "alpha\nbeta\n";
  return {
    kind: "text",
    content,
    sourceBytes: Buffer.byteLength(content),
    totalFileLines: 3,
    startLineDisplay: 1,
    userLimitedLines: null,
    hasMoreAfterUserLimit: false,
    firstLineBytes: 5,
    truncation: {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines: 3,
      totalBytes: Buffer.byteLength(content),
      outputLines: 3,
      outputBytes: Buffer.byteLength(content),
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: 2_000,
      maxBytes: 50 * 1024,
      ...(overrides.truncation ?? {}),
    },
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    readWorkspaceFile: async () => textReadResult(),
    writeWorkspaceFile: async () => {},
    editWorkspaceFile: async () => ({
      diff: "@@ -1 +1 @@\n- old\n+ new",
      diffTruncated: false,
      firstChangedLine: 1,
      sourceBytes: 4,
      writtenBytes: 4,
    }),
    ...overrides,
  };
}

test("remote path resolution matches pi workspace conventions", () => {
  assert.equal(resolveRemoteWorkspaceToolPath("README.md", CWD, "/local/home"), "/local/worktree/README.md");
  assert.equal(resolveRemoteWorkspaceToolPath("@notes/file.md", CWD, "/local/home"), "/local/worktree/notes/file.md");
  assert.equal(resolveRemoteWorkspaceToolPath("~/notes.md", CWD, "/local/home"), "/local/home/notes.md");
  assert.equal(resolveRemoteWorkspaceToolPath("a\u00a0b.md", CWD, "/local/home"), "/local/worktree/a b.md");
});

test("remote read sends one high-level request with range limits and preserves continuation notices", async () => {
  const controller = new AbortController();
  const calls = [];
  const session = makeSession({
    readWorkspaceFile: async (path, options, signal) => {
      calls.push({ path, options, signal });
      return textReadResult({
        content: "gamma\ndelta\n",
        totalFileLines: 10,
        startLineDisplay: 3,
        userLimitedLines: 2,
        hasMoreAfterUserLimit: true,
        truncation: {
          content: "gamma\ndelta\n",
          totalLines: 2,
          totalBytes: 12,
          outputLines: 2,
          outputBytes: 12,
        },
      });
    },
  });

  const result = await executeRemoteReadTool(
    session,
    CWD,
    "read-1",
    { path: "notes.md", offset: 3, limit: 2 },
    controller.signal,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { offset: 3, limit: 2, maxLines: 2_000, maxBytes: 50 * 1024 });
  assert.equal(calls[0].path, resolve(CWD, "notes.md"));
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(result.content[0].text, "gamma\ndelta\n\n\n[6 more lines in file. Use offset=5 to continue.]");
});

test("remote read preserves pi truncation metadata and byte-limit notice", async () => {
  const session = makeSession({
    readWorkspaceFile: async () => textReadResult({
      content: "partial",
      sourceBytes: 80_000,
      totalFileLines: 50,
      startLineDisplay: 7,
      truncation: {
        content: "partial",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 20,
        totalBytes: 60_000,
        outputLines: 4,
        outputBytes: 51_200,
        lastLinePartial: true,
      },
    }),
  });

  const result = await executeRemoteReadTool(session, CWD, "read-2", { path: "large.txt", offset: 7 });
  assert.match(result.content[0].text, /Showing lines 7-10 of 50 \(50\.0KB limit\)\. Use offset=11/);
  assert.equal(result.details.truncation.truncatedBy, "bytes");
  assert.equal(result.details.truncation.content, "partial");
});

test("remote image read fetches bytes once and reuses pi image attachment behavior", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  let calls = 0;
  const session = makeSession({
    readWorkspaceFile: async () => {
      calls += 1;
      return { kind: "image", mimeType: "image/png", content: png, sourceBytes: png.length };
    },
  });

  const result = await executeRemoteReadTool(session, CWD, "read-image", { path: "pixel.png" });
  assert.equal(calls, 1);
  assert.equal(result.content[0].text, "Read image file [image/png]");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  assert.ok(result.content[1].data.length > 0);
});

test("remote write sends exact UTF-8 bytes once and forwards the abort signal", async () => {
  const controller = new AbortController();
  const calls = [];
  const session = makeSession({
    writeWorkspaceFile: async (path, content, signal) => calls.push({ path, content, signal }),
  });

  const result = await executeRemoteWriteTool(session, CWD, { path: "unicode.txt", content: "雪だるま ☃\n" }, controller.signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/local/worktree/unicode.txt");
  assert.deepEqual(calls[0].content, Buffer.from("雪だるま ☃\n", "utf8"));
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(result.content[0].text, "Successfully wrote 7 bytes to unicode.txt");
});

test("remote edit sends only replacement blocks once and returns worker diff details", async () => {
  const calls = [];
  const edits = [{ oldText: "before", newText: "after" }];
  const session = makeSession({
    editWorkspaceFile: async (path, displayPath, receivedEdits, signal) => {
      calls.push({ path, displayPath, receivedEdits, signal });
      return {
        diff: "@@ -1 +1 @@\n- before\n+ after",
        diffTruncated: false,
        firstChangedLine: 1,
        sourceBytes: 6,
        writtenBytes: 5,
      };
    },
  });

  const result = await executeRemoteEditTool(session, CWD, { path: "state.txt", edits });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/local/worktree/state.txt");
  assert.equal(calls[0].displayPath, "state.txt");
  assert.deepEqual(calls[0].receivedEdits, edits);
  assert.equal(result.details.firstChangedLine, 1);
  assert.match(result.details.diff, /- before/);
});

test("remote adapter rejects invalid ranges and empty edit batches before transport", async () => {
  let calls = 0;
  const session = makeSession({
    readWorkspaceFile: async () => {
      calls += 1;
      return textReadResult();
    },
    editWorkspaceFile: async () => {
      calls += 1;
      return makeSession().editWorkspaceFile();
    },
  });

  await assert.rejects(executeRemoteReadTool(session, CWD, "read-bad", { path: "x", offset: 0 }), /positive integer/);
  await assert.rejects(executeRemoteEditTool(session, CWD, { path: "x", edits: [] }), /at least one replacement/);
  assert.equal(calls, 0);
});

test("a remote mutation aborted while queued settles promptly and is never sent", async () => {
  const starts = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolveFirst) => {
    releaseFirst = resolveFirst;
  });
  const session = makeSession({
    writeWorkspaceFile: async (_path, content) => {
      starts.push(content.toString("utf8"));
      if (starts.length === 1) await firstBlocked;
    },
  });
  const controller = new AbortController();

  const first = executeRemoteWriteTool(session, CWD, { path: "abort-queued.txt", content: "first" });
  const second = executeRemoteWriteTool(
    session,
    CWD,
    { path: "abort-queued.txt", content: "must-not-send" },
    controller.signal,
  );
  await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  controller.abort();
  await assert.rejects(
    Promise.race([
      second,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("queued abort did not settle")), 250)),
    ]),
    /aborted/,
  );
  assert.deepEqual(starts, ["first"]);

  releaseFirst();
  await first;
  await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  assert.deepEqual(starts, ["first"], "aborted queued mutation must remain skipped after its predecessor finishes");
});

test("remote writes to the same path remain serialized", async () => {
  const starts = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolveFirst) => {
    releaseFirst = resolveFirst;
  });
  const session = makeSession({
    writeWorkspaceFile: async (_path, content) => {
      starts.push(content.toString("utf8"));
      if (starts.length === 1) await firstBlocked;
    },
  });

  const first = executeRemoteWriteTool(session, CWD, { path: "same.txt", content: "first" });
  const second = executeRemoteWriteTool(session, CWD, { path: "same.txt", content: "second" });
  await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  assert.deepEqual(starts, ["first"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(starts, ["first", "second"]);
});
