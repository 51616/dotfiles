import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAssistantText,
  extractCommandFromInput,
  extractResultTail,
  extractReturnCode,
  summarizeToolInput,
  truncateInline,
} from "../pi-instance-bridge/lib/pi-instance-bridge-text.ts";

test("extractAssistantText picks newest assistant text and skips thinking blocks", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden" },
        { type: "text", text: "older" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "newest" },
      ],
    },
  ];

  assert.equal(extractAssistantText(messages), "newest");
});

test("truncateInline compacts whitespace and enforces max length", () => {
  assert.equal(truncateInline("a   b\n c", 20), "a b c");
  const out = truncateInline("x".repeat(20), 10);
  assert.equal(out.length, 10);
  assert.match(out, /…$/);
});

test("summarizeToolInput and extractCommandFromInput truncate long payloads", () => {
  const summary = summarizeToolInput({ text: "a".repeat(300) });
  assert.ok(summary.length <= 240);
  assert.match(summary, /…$/);

  const cmd = extractCommandFromInput({ command: "b".repeat(2000) });
  assert.equal(cmd.length, 1200);
  assert.match(cmd, /…$/);
});

test("extractReturnCode checks known numeric fields in order", () => {
  assert.equal(extractReturnCode({ exitCode: 7 }), 7);
  assert.equal(extractReturnCode({ code: 5 }), 5);
  assert.equal(extractReturnCode({ returnCode: 3 }), 3);
  assert.equal(extractReturnCode({ code: "1" }), null);
});

test("extractResultTail falls back to details when content is empty", () => {
  const tail = extractResultTail({}, { output_text: "line-1\nline-2" });
  assert.ok(tail.includes("line-2"));
});
