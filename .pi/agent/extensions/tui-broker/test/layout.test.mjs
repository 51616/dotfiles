import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContextUsageBorderText,
  buildContextUsageLabel,
  buildEditorBorderBadgeText,
  buildEditorTopBorderLine,
  buildModelEffortLabel,
  buildSingleLineFooter,
  formatModelIdForDisplay,
  formatThinkingLevelForDisplay,
  formatTokens,
  getContextUsageHighlightAnsiCodes,
  getContextUsageHighlightLevel,
  sanitizeStatusText,
} from "../lib/layout.ts";

test("formatTokens keeps small and large counts readable", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_600), "1.6k");
  assert.equal(formatTokens(272_000), "272k");
});

test("buildContextUsageLabel omits auto suffix and formats unknown usage", () => {
  assert.equal(buildContextUsageLabel({ percent: 12.2, contextWindow: 272_000 }), "12.2%/272k");
  assert.equal(buildContextUsageLabel({ percent: null, contextWindow: 272_000 }), "?/272k");
  assert.equal(buildContextUsageLabel({ percent: 12.2, contextWindow: 0 }), undefined);
});

test("buildContextUsageBorderText pads the context meter away from the border", () => {
  assert.equal(buildContextUsageBorderText("12.2%/272k"), " 12.2%/272k ");
});

test("getContextUsageHighlightLevel uses absolute token thresholds", () => {
  assert.equal(getContextUsageHighlightLevel(null), "none");
  assert.equal(getContextUsageHighlightLevel(63_999), "none");
  assert.equal(getContextUsageHighlightLevel(64_000), "bold");
  assert.equal(getContextUsageHighlightLevel(128_000), "yellow");
  assert.equal(getContextUsageHighlightLevel(192_000), "orange");
  assert.equal(getContextUsageHighlightLevel(224_000), "red");
});

test("getContextUsageHighlightAnsiCodes makes highlighted states bold", () => {
  assert.equal(getContextUsageHighlightAnsiCodes(63_999), undefined);
  assert.equal(getContextUsageHighlightAnsiCodes(64_000), "1");
  assert.equal(getContextUsageHighlightAnsiCodes(128_000), "1;33");
  assert.equal(getContextUsageHighlightAnsiCodes(192_000), "1;38;5;208");
  assert.equal(getContextUsageHighlightAnsiCodes(224_000), "1;31");
});

test("formatModelIdForDisplay makes common model ids human readable", () => {
  assert.equal(formatModelIdForDisplay("gpt-5.4"), "GPT-5.4");
  assert.equal(formatModelIdForDisplay("gpt-5.3-codex"), "GPT-5.3 Codex");
  assert.equal(formatModelIdForDisplay("gpt-oss-120b"), "GPT-OSS 120b");
  assert.equal(formatModelIdForDisplay("o4-mini"), "o4 Mini");
  assert.equal(formatModelIdForDisplay("claude-sonnet-4-5"), "Claude Sonnet 4.5");
  assert.equal(formatModelIdForDisplay("gemini-2.5-pro"), "Gemini 2.5 Pro");
  assert.equal(formatModelIdForDisplay(undefined), "No Model");
});

test("formatThinkingLevelForDisplay makes effort labels human readable", () => {
  assert.equal(formatThinkingLevelForDisplay("high"), "High");
  assert.equal(formatThinkingLevelForDisplay("xhigh"), "Extra High");
  assert.equal(formatThinkingLevelForDisplay("off"), "Thinking Off");
});

test("buildModelEffortLabel keeps only model, effort, and effort suffixes", () => {
  assert.equal(buildModelEffortLabel("gpt-5.4", true, "high"), "󰚩 GPT-5.4 · 󰧑 High");
  assert.equal(buildModelEffortLabel("gpt-5.4", true, "high", ["fast"]), "󰚩 GPT-5.4 · 󰧑 High (fast)");
  assert.equal(buildModelEffortLabel("gpt-5.4", true, "off"), "󰚩 GPT-5.4 · 󰧑 Thinking Off");
  assert.equal(buildModelEffortLabel("gpt-5.4", false, "high", ["fast"]), "󰚩 GPT-5.4");
});

test("buildSingleLineFooter keeps model label right-aligned", () => {
  assert.equal(
    buildSingleLineFooter(" ~/vault", "󰚩 GPT-5.4 · 󰧑 High", 40),
    " ~/vault             󰚩 GPT-5.4 · 󰧑 High",
  );
  assert.equal(
    buildSingleLineFooter("/a/very/long/path/that/needs/truncation", "󰚩 GPT-5.4 · 󰧑 High", 30),
    "/a/very/... 󰚩 GPT-5.4 · 󰧑 High",
  );
});

test("sanitizeStatusText flattens control characters", () => {
  assert.equal(sanitizeStatusText("ready\n\t now"), "ready now");
});

test("buildEditorBorderBadgeText joins badges and scroll info compactly", () => {
  assert.equal(
    buildEditorBorderBadgeText(["↻ repeat 1/3", "✎ snippet investigate"], "↑ 12 more"),
    "↻ repeat 1/3 • ✎ snippet investigate • ↑ 12 more",
  );
  assert.equal(buildEditorBorderBadgeText([], null), undefined);
});

test("buildEditorTopBorderLine keeps a right label aligned on the border", () => {
  assert.equal(
    buildEditorTopBorderLine({
      leftText: "↻ repeat 1/3",
      rightText: " main 2 +10 -3",
      width: 40,
      borderChar: "─",
      colorizeBorder: (text) => text,
    }),
    "↻ repeat 1/3 ────────  main 2 +10 -3 ─",
  );
});
