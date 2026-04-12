import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContextUsageBorderText,
  buildContextUsageLabel,
  buildEditorBorderBadgeText,
  buildModelEffortLabel,
  buildSingleLineFooter,
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

test("buildModelEffortLabel keeps only model and effort", () => {
  assert.equal(buildModelEffortLabel("gpt-5.4", true, "high"), "gpt-5.4 • high");
  assert.equal(buildModelEffortLabel("gpt-5.4", true, "off"), "gpt-5.4 • thinking off");
  assert.equal(buildModelEffortLabel("gpt-5.4", false, "high"), "gpt-5.4");
});

test("buildSingleLineFooter keeps model label right-aligned", () => {
  assert.equal(
    buildSingleLineFooter("~/vault (main)", "gpt-5.4 • high", 40),
    "~/vault (main)            gpt-5.4 • high",
  );
  assert.equal(
    buildSingleLineFooter("/a/very/long/path/that/needs/truncation", "gpt-5.4 • high", 30),
    "/a/very/long... gpt-5.4 • high",
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
