import test from "node:test";
import assert from "node:assert/strict";

import { PiSshRemoteFileTransport } from "../lib/pi-ssh-file-transport.ts";

// @lat: [[tests#Persistent SSH file protocol]]

function response(metadata, payload = Buffer.alloc(0)) {
  return {
    header: {
      version: 1,
      kind: "response",
      id: 1,
      ok: true,
      payloadLength: payload.length,
      ...metadata,
    },
    payload,
  };
}

function requester(result) {
  const state = { invalidated: [], calls: [] };
  return {
    state,
    request: async (...args) => {
      state.calls.push(args);
      return typeof result === "function" ? result(...args) : result;
    },
    invalidate: (error) => state.invalidated.push(error),
    dispose: async () => {},
  };
}

test("file transport accepts coherent exact read and write metadata", async () => {
  const exact = Buffer.from("exact-bytes");
  const readWorker = requester(response({ fileKind: "binary", sourceBytes: exact.length }, exact));
  const readTransport = new PiSshRemoteFileTransport(readWorker);
  assert.deepEqual(await readTransport.readFile("/remote/file"), exact);
  assert.equal(readWorker.state.invalidated.length, 0);

  const writeWorker = requester(response({ writtenBytes: exact.length }));
  const writeTransport = new PiSshRemoteFileTransport(writeWorker);
  await writeTransport.writeFile("/remote/file", exact);
  assert.equal(writeWorker.state.invalidated.length, 0);
});

test("file transport poisons the worker on incoherent exact-file metadata", async () => {
  const badReadWorker = requester(response({ fileKind: "binary", sourceBytes: -1 }, Buffer.from("x")));
  const badRead = new PiSshRemoteFileTransport(badReadWorker);
  await assert.rejects(badRead.readFile("/remote/file"), /sourceBytes must be an integer/);
  assert.equal(badReadWorker.state.invalidated.length, 1);

  const badWriteWorker = requester(response({ writtenBytes: 2.5 }));
  const badWrite = new PiSshRemoteFileTransport(badWriteWorker);
  await assert.rejects(badWrite.writeFile("/remote/file", Buffer.from("xx")), /writtenBytes must be an integer/);
  assert.equal(badWriteWorker.state.invalidated.length, 1);
});

test("file transport validates text payload counts and requested truncation limits", async () => {
  const payload = Buffer.from("hello");
  const worker = requester(response({
    fileKind: "text",
    sourceBytes: 5,
    totalFileLines: 1,
    startLineDisplay: 1,
    userLimitedLines: null,
    hasMoreAfterUserLimit: false,
    firstLineBytes: 5,
    truncation: {
      truncated: false,
      truncatedBy: null,
      totalLines: 1,
      totalBytes: 5,
      outputLines: 1,
      outputBytes: 4,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: 2_000,
      maxBytes: 50 * 1024,
    },
  }, payload));
  const transport = new PiSshRemoteFileTransport(worker);
  await assert.rejects(
    transport.readWorkspaceFile("/remote/file", { maxLines: 2_000, maxBytes: 50 * 1024 }),
    /outputBytes 4 does not match payload 5/,
  );
  assert.equal(worker.state.invalidated.length, 1);
});

test("file transport binds text metadata to the requested range and visible payload", async () => {
  const payload = Buffer.from("line-2");
  const validMetadata = {
    fileKind: "text",
    sourceBytes: 20,
    totalFileLines: 3,
    startLineDisplay: 2,
    userLimitedLines: 1,
    hasMoreAfterUserLimit: true,
    firstLineBytes: payload.length,
    truncation: {
      truncated: false,
      truncatedBy: null,
      totalLines: 1,
      totalBytes: payload.length,
      outputLines: 1,
      outputBytes: payload.length,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: 2_000,
      maxBytes: 50 * 1024,
    },
  };
  const options = { offset: 2, limit: 1, maxLines: 2_000, maxBytes: 50 * 1024 };

  const validWorker = requester(response(validMetadata, payload));
  const valid = await new PiSshRemoteFileTransport(validWorker).readWorkspaceFile("/remote/file", options);
  assert.equal(valid.kind, "text");
  assert.equal(valid.content, "line-2");
  assert.equal(validWorker.state.invalidated.length, 0);

  for (const [name, mutate, expectedError] of [
    ["offset", (metadata) => { metadata.startLineDisplay = 3; }, /does not match requested offset/],
    ["limit", (metadata) => { metadata.userLimitedLines = 2; }, /does not match request selection/],
    ["has-more", (metadata) => { metadata.hasMoreAfterUserLimit = false; }, /inconsistent with the requested range/],
    ["selected-lines", (metadata) => { metadata.truncation.totalLines = 99; }, /does not match selected lines/],
    ["payload-lines", (metadata) => { metadata.truncation.outputLines = 0; }, /does not match payload lines/],
  ]) {
    const metadata = structuredClone(validMetadata);
    mutate(metadata);
    const worker = requester(response(metadata, payload));
    const transport = new PiSshRemoteFileTransport(worker);
    await assert.rejects(transport.readWorkspaceFile("/remote/file", options), expectedError, name);
    assert.equal(worker.state.invalidated.length, 1, name);
  }
});

test("file transport rejects impossible truncation causes and hidden bytes after complete lines", async () => {
  const payload = Buffer.from("\n");
  const baseMetadata = {
    fileKind: "text",
    sourceBytes: 3,
    totalFileLines: 2,
    startLineDisplay: 1,
    userLimitedLines: null,
    hasMoreAfterUserLimit: false,
    firstLineBytes: 0,
    truncation: {
      truncated: true,
      truncatedBy: "lines",
      totalLines: 2,
      totalBytes: 3,
      outputLines: 2,
      outputBytes: 1,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: 2,
      maxBytes: 2,
    },
  };
  const options = { maxLines: 2, maxBytes: 2 };

  for (const [cause, expectedError] of [
    ["lines", /requires totalLines above maxLines/],
    ["bytes", /complete-line output cannot hide bytes/],
  ]) {
    const metadata = structuredClone(baseMetadata);
    metadata.truncation.truncatedBy = cause;
    const worker = requester(response(metadata, payload));
    await assert.rejects(
      new PiSshRemoteFileTransport(worker).readWorkspaceFile("/remote/file", options),
      expectedError,
    );
    assert.equal(worker.state.invalidated.length, 1);
  }

  const partialPayload = Buffer.from("a\n");
  const partialMetadata = structuredClone(baseMetadata);
  partialMetadata.firstLineBytes = 1;
  partialMetadata.truncation.truncatedBy = "bytes";
  partialMetadata.truncation.outputBytes = partialPayload.length;
  partialMetadata.truncation.lastLinePartial = true;
  const partialWorker = requester(response(partialMetadata, partialPayload));
  await assert.rejects(
    new PiSshRemoteFileTransport(partialWorker).readWorkspaceFile("/remote/file", options),
    /lastLinePartial must be false/,
  );
  assert.equal(partialWorker.state.invalidated.length, 1);
});

test("file transport rejects edit payloads and missing positive changed-line metadata", async () => {
  const worker = requester(response({
    diff: "- old\n+ new",
    firstChangedLine: null,
    diffTruncated: false,
    sourceBytes: 4,
    writtenBytes: 4,
  }, Buffer.from("unexpected")));
  const transport = new PiSshRemoteFileTransport(worker);
  await assert.rejects(
    transport.editWorkspaceFile("/remote/file", "file", [{ oldText: "old", newText: "new" }]),
    /must not contain a payload/,
  );
  assert.equal(worker.state.invalidated.length, 1);
});

test("remote operation errors propagate without poisoning a healthy protocol channel", async () => {
  const remoteError = new Error("File not found: /remote/missing");
  const worker = requester(async () => {
    throw remoteError;
  });
  const transport = new PiSshRemoteFileTransport(worker);
  await assert.rejects(transport.readFile("/remote/missing"), /File not found/);
  assert.equal(worker.state.invalidated.length, 0);
});
