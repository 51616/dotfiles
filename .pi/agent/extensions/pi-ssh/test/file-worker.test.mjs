import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PiSshFileWorkerClient } from "../lib/pi-ssh-file-protocol.ts";

// @lat: [[tests#Remote-native workspace file operations]]

const testDir = dirname(fileURLToPath(import.meta.url));
const workerPath = join(testDir, "..", "lib", "pi-ssh-file-worker.py");

async function withWorker(run) {
  const debugEvents = [];
  const client = new PiSshFileWorkerClient({
    launcher: () => spawn("python3", ["-u", workerPath], { stdio: ["pipe", "pipe", "pipe"] }),
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 5_000,
    onDebug: (event, details) => debugEvents.push({ event, details }),
  });
  const root = await mkdtemp(join(tmpdir(), "pi-ssh-file-worker-"));
  try {
    await run({ client, root, debugEvents });
  } finally {
    await client.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function requestRead(client, path, options = {}) {
  return client.request("read_workspace", {
    path,
    maxLines: 2_000,
    maxBytes: 50 * 1024,
    ...options,
  });
}

test("worker ranged read transfers bounded selected text instead of the source file", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "large.txt");
    const lines = Array.from({ length: 100_000 }, (_, index) => `line-${String(index + 1).padStart(6, "0")}`);
    const source = lines.join("\n");
    await writeFile(path, source, "utf8");

    const result = await requestRead(client, path, { offset: 50_001, limit: 20 });
    const output = result.payload.toString("utf8");

    assert.equal(result.header.fileKind, "text");
    assert.equal(result.header.totalFileLines, 100_000);
    assert.equal(result.header.sourceBytes, Buffer.byteLength(source));
    assert.equal(result.header.userLimitedLines, 20);
    assert.equal(result.header.hasMoreAfterUserLimit, true);
    assert.equal(output.split("\n").length, 20);
    assert.match(output, /^line-050001/);
    assert.match(output, /line-050020$/);
    assert.ok(result.payload.length < 1_000);
    assert.ok(result.payload.length < result.header.sourceBytes / 1_000);
  });
});

test("worker read preserves pi truncation metadata and first-line-too-large behavior", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "long-lines.txt");
    await writeFile(path, `${"x".repeat(60 * 1024)}\ntail`, "utf8");

    const result = await requestRead(client, path);
    assert.equal(result.payload.length, 0);
    assert.equal(result.header.truncation.truncated, true);
    assert.equal(result.header.truncation.truncatedBy, "bytes");
    assert.equal(result.header.truncation.firstLineExceedsLimit, true);
    assert.equal(result.header.firstLineBytes, 60 * 1024);
  });
});

test("worker detects supported images by signature and returns exact bytes", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "image-without-extension");
    const image = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("payload")]);
    await writeFile(path, image);

    const result = await requestRead(client, path);
    assert.equal(result.header.fileKind, "image");
    assert.equal(result.header.mimeType, "image/png");
    assert.deepEqual(result.payload, image);
  });
});

test("worker write sends and stores raw UTF-8 payload exactly once", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "nested", "unicode.txt");
    const content = Buffer.from("日本語 café 🚀\n", "utf8");

    const result = await client.request("write_file", { path }, content);
    assert.equal(result.header.writtenBytes, content.length);
    assert.equal(result.payload.length, 0);
    assert.deepEqual(await readFile(path), content);
  });
});

test("worker edit changes a large file remotely and returns only bounded metadata", async () => {
  await withWorker(async ({ client, root, debugEvents }) => {
    const path = join(root, "large-edit.txt");
    const prefix = "unchanged-prefix\n".repeat(100_000);
    const suffix = "unchanged-suffix\n".repeat(100_000);
    await writeFile(path, `${prefix}target = old\n${suffix}`, "utf8");

    const result = await client.request("edit_workspace", {
      path,
      displayPath: "large-edit.txt",
      edits: [{ oldText: "target = old", newText: "target = new" }],
    });
    const updated = await readFile(path, "utf8");

    assert.match(updated, /target = new/);
    assert.doesNotMatch(updated, /target = old/);
    assert.match(result.header.diff, /-.*target = old/);
    assert.match(result.header.diff, /\+.*target = new/);
    assert.equal(typeof result.header.firstChangedLine, "number");
    assert.equal(result.payload.length, 0);
    assert.ok(Buffer.byteLength(result.header.diff) < 10_000);

    const begin = debugEvents.find(
      ({ event, details }) => event === "request.begin" && details.operation === "edit_workspace",
    );
    assert.ok(begin);
    assert.equal(begin.details.payloadBytes, 0);
  });
});

test("worker edit preserves BOM and CRLF while supporting fuzzy punctuation matching", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "format.txt");
    await writeFile(path, "\ufeffheader\r\nsmart “quote”\r\ntail\r\n", "utf8");

    await client.request("edit_workspace", {
      path,
      displayPath: "format.txt",
      edits: [{ oldText: 'smart "quote"', newText: "smart replacement" }],
    });
    const updated = await readFile(path, "utf8");

    assert.ok(updated.startsWith("\ufeff"));
    assert.match(updated, /header\r\nsmart replacement\r\ntail\r\n/);
    assert.equal(updated.replace(/\r\n/g, "").includes("\n"), false);
  });
});

test("worker uses the dominant line ending and applies successful multi-edit batches", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "mixed-endings.txt");
    await writeFile(path, "first\nsecond\r\nthird\r\nfourth\r\n", "utf8");

    await client.request("edit_workspace", {
      path,
      displayPath: "mixed-endings.txt",
      edits: [
        { oldText: "first", newText: "FIRST" },
        { oldText: "third", newText: "THIRD" },
      ],
    });
    const updated = await readFile(path, "utf8");
    assert.equal(updated, "FIRST\r\nsecond\r\nTHIRD\r\nfourth\r\n");
    assert.equal(updated.replaceAll("\r\n", "").includes("\n"), false);
  });
});

test("worker rejects payloads on non-write operations and does not exhaust its pool on FIFOs", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "plain.txt");
    await writeFile(path, "content\n", "utf8");
    await assert.rejects(
      client.request("read_workspace", { path, maxLines: 2_000, maxBytes: 50 * 1024 }, Buffer.from("unexpected")),
      /must not contain a payload/,
    );

    const fifos = Array.from({ length: 4 }, (_, index) => join(root, `not-a-file-${index}.fifo`));
    for (const fifo of fifos) {
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
    }
    await assert.rejects(
      client.request("read_file", { path: fifos[0] }, Buffer.alloc(0), { timeoutMs: 1_000 }),
      /Not a regular file/,
    );
    await Promise.all(fifos.map((fifo) => assert.rejects(
      client.request("write_file", { path: fifo }, Buffer.from("must-not-block"), { timeoutMs: 1_000 }),
      /Cannot overwrite non-regular file/,
    )));

    const recovered = join(root, "after-fifos.txt");
    await client.request("write_file", { path: recovered }, Buffer.from("healthy"), { timeoutMs: 1_000 });
    assert.equal((await readFile(recovered, "utf8")), "healthy");
  });
});

test("worker line-ending ties preserve the first lone-CR style as LF", async () => {
  await withWorker(async ({ client, root }) => {
    const path = join(root, "line-ending-tie.txt");
    await writeFile(path, "first\rmiddle\r\nthird", "utf8");
    await client.request("edit_workspace", {
      path,
      displayPath: "line-ending-tie.txt",
      edits: [{ oldText: "middle", newText: "MIDDLE" }],
    });
    assert.equal(await readFile(path, "utf8"), "first\nMIDDLE\nthird");
  });
});

test("worker invalid edits leave the original file byte-for-byte unchanged", async () => {
  const cases = [
    {
      name: "missing",
      content: "alpha\nbeta\n",
      edits: [{ oldText: "absent", newText: "new" }],
      error: /Could not find/,
    },
    {
      name: "duplicate",
      content: "same\nmiddle\nsame\n",
      edits: [{ oldText: "same", newText: "new" }],
      error: /2 occurrences/,
    },
    {
      name: "empty",
      content: "alpha\n",
      edits: [{ oldText: "", newText: "new" }],
      error: /must not be empty/,
    },
    {
      name: "overlap",
      content: "abcdef\n",
      edits: [
        { oldText: "abcd", newText: "one" },
        { oldText: "cdef", newText: "two" },
      ],
      error: /overlap/,
    },
    {
      name: "no-change",
      content: "alpha\n",
      edits: [{ oldText: "alpha", newText: "alpha" }],
      error: /No changes made/,
    },
  ];

  await withWorker(async ({ client, root }) => {
    for (const entry of cases) {
      const path = join(root, `${entry.name}.txt`);
      const original = Buffer.from(entry.content, "utf8");
      await writeFile(path, original);
      await assert.rejects(
        client.request("edit_workspace", { path, displayPath: entry.name, edits: entry.edits }),
        entry.error,
      );
      assert.deepEqual(await readFile(path), original, entry.name);
    }
  });
});

test("worker handles independent reads concurrently and emits structured completion logs", async () => {
  await withWorker(async ({ client, root, debugEvents }) => {
    const firstPath = join(root, "first.txt");
    const secondPath = join(root, "second.txt");
    await Promise.all([writeFile(firstPath, "first\n"), writeFile(secondPath, "second\n")]);

    const [first, second] = await Promise.all([
      requestRead(client, firstPath),
      requestRead(client, secondPath),
    ]);
    assert.equal(first.payload.toString("utf8"), "first\n");
    assert.equal(second.payload.toString("utf8"), "second\n");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const completionLogs = debugEvents.filter(
      ({ event, details }) => event === "worker.stderr" && String(details.line).includes('"event":"request.complete"'),
    );
    assert.ok(completionLogs.length >= 2);
    assert.ok(completionLogs.every(({ details }) => String(details.line).includes('"durationMs":')));
  });
});
