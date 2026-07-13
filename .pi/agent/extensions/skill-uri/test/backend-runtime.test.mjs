import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import skillUriExtension from "../index.ts";
import {
  __publishActivePiSshSessionForTests,
  __resetPiSshSessionForTests,
  __resetPiSshWorkspaceFileRouterForTests,
  createPiSshSession,
  hasPiSshWorkspaceFileRouter,
} from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

function createFakePi() {
  const tools = new Map();
  const events = new Map();

  return {
    tools,
    events,
    api: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      on(eventName, handler) {
        events.set(eventName, handler);
      },
    },
  };
}

function makeSession(options = {}) {
  const state = options.state ?? { currentText: "from-session:/remote/worktree/README.md\n" };
  return createPiSshSession({
    connection: {
      remote: "user@example.com",
      port: 2222,
      remoteCwd: "/remote/worktree",
      remoteHome: "/remote/home",
      localCwd: process.cwd(),
      localHome: "/home/local",
    },
    transport: {
      exec: async () => ({ exitCode: 0 }),
      readFile: async (path) => Buffer.from(options.readText ?? state.currentText ?? `from-session:${path}\n`, "utf-8"),
      writeFile: async (path, content) => {
        state.currentText = content.toString("utf-8");
        options.onWrite?.(path, state.currentText);
      },
      readWorkspaceFile: async (path, readOptions, signal) => {
        const content = options.readText ?? state.currentText ?? `from-session:${path}\n`;
        options.onRead?.(path, readOptions, signal);
        return {
          kind: "text",
          content,
          sourceBytes: Buffer.byteLength(content),
          totalFileLines: content.split("\n").length,
          startLineDisplay: readOptions.offset ?? 1,
          userLimitedLines: readOptions.limit ?? null,
          hasMoreAfterUserLimit: false,
          firstLineBytes: Buffer.byteLength(content.split("\n", 1)[0]),
          truncation: {
            content,
            truncated: false,
            truncatedBy: null,
            totalLines: content.split("\n").length,
            totalBytes: Buffer.byteLength(content),
            outputLines: content.split("\n").length,
            outputBytes: Buffer.byteLength(content),
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines: readOptions.maxLines,
            maxBytes: readOptions.maxBytes,
          },
        };
      },
      editWorkspaceFile: async (path, displayPath, edits, signal) => {
        const original = state.currentText;
        let content = original;
        for (const edit of edits) {
          const index = content.indexOf(edit.oldText);
          if (index < 0 || content.indexOf(edit.oldText, index + edit.oldText.length) >= 0) {
            throw new Error(`Could not uniquely replace edit in ${displayPath}`);
          }
          content = content.slice(0, index) + edit.newText + content.slice(index + edit.oldText.length);
        }
        state.currentText = content;
        options.onEdit?.(path, displayPath, edits, signal);
        options.onWrite?.(path, content);
        return {
          diff: `-${original}+${content}`,
          diffTruncated: false,
          firstChangedLine: 1,
          sourceBytes: Buffer.byteLength(original),
          writtenBytes: Buffer.byteLength(content),
        };
      },
    },
    execCapture: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    }),
  });
}

test("skill-uri router registration is removed when its extension instance shuts down", () => {
  __resetPiSshWorkspaceFileRouterForTests();
  const fake = createFakePi();
  skillUriExtension(fake.api);
  assert.equal(hasPiSshWorkspaceFileRouter(), true);
  fake.events.get("session_shutdown")({ reason: "reload" }, {});
  assert.equal(hasPiSshWorkspaceFileRouter(), false);
});

test("read keeps local behavior when no active pi-ssh session exists", async () => {
  __resetPiSshSessionForTests();

  const base = await mkdtemp(join(tmpdir(), "skill-uri-local-read-"));
  const filePath = join(base, "README.md");
  await writeFile(filePath, "local-read\n", "utf-8");

  const fake = createFakePi();
  skillUriExtension(fake.api);

  const readTool = fake.tools.get("read");
  assert.ok(readTool);
  const result = await readTool.execute("read-1", { path: filePath });
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, "local-read\n");
});

test("read delegates non-skill paths to the active pi-ssh session", async () => {
  __resetPiSshSessionForTests();
  __publishActivePiSshSessionForTests(makeSession());

  const fake = createFakePi();
  skillUriExtension(fake.api);

  const readTool = fake.tools.get("read");
  assert.ok(readTool);
  const result = await readTool.execute("read-1", { path: "README.md" });
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, "from-session:/remote/worktree/README.md\n");
});

test("write and edit delegate non-skill paths to the active pi-ssh session", async () => {
  __resetPiSshSessionForTests();
  const writes = [];
  __publishActivePiSshSessionForTests(makeSession({
    state: { currentText: "before\n" },
    onWrite: (path, content) => writes.push({ path, content }),
  }));

  const fake = createFakePi();
  skillUriExtension(fake.api);

  const writeTool = fake.tools.get("write");
  const editTool = fake.tools.get("edit");
  assert.ok(writeTool);
  assert.ok(editTool);

  await writeTool.execute("write-1", { path: "NOTES.md", content: "after\n" });
  await editTool.execute("edit-1", {
    path: "NOTES.md",
    edits: [
      {
        oldText: "after\n",
        newText: "edited\n",
      },
    ],
  });

  assert.deepEqual(writes, [
    { path: "/remote/worktree/NOTES.md", content: "after\n" },
    { path: "/remote/worktree/NOTES.md", content: "edited\n" },
  ]);
});
