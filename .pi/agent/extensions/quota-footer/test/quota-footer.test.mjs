import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatQuotaStatus,
  normalizeQuotaSnapshot,
  parseQuotaSnapshotFromJsonLine,
  readLatestCodexSessionRateLimits,
  renderProgressBar,
} from "../lib/quota-footer.ts";

const NOW_MS = Date.parse("2026-05-23T00:00:00.000Z");
const FUTURE_RESET = Math.floor(NOW_MS / 1000) + 3600;
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_RESET = "\x1b[0m";
const BAR_FILLED_OPEN = "\x1b[38;2;166;173;200m";
const BAR_EMPTY_OPEN = "\x1b[38;2;69;71;90m";
const TEXT_OPEN = "\x1b[38;2;108;112;134m";

function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}

function expectedBar(filledCells, emptyCells) {
  const filled = filledCells > 0 ? `${BAR_FILLED_OPEN}${"━".repeat(filledCells)}${ANSI_RESET}` : "";
  const empty = emptyCells > 0 ? `${BAR_EMPTY_OPEN}${"━".repeat(emptyCells)}${ANSI_RESET}` : "";
  return `${filled}${empty}`;
}

function expectedWindow(label, percent, filledCells, emptyCells) {
  return `${TEXT_OPEN}${label} ${ANSI_RESET}${expectedBar(filledCells, emptyCells)}${TEXT_OPEN} ${percent}%${ANSI_RESET}`;
}

function expectedStatus(primaryPercent, primaryFilledCells, secondaryPercent, secondaryFilledCells) {
  return `${expectedWindow("5h", primaryPercent, primaryFilledCells, 6 - primaryFilledCells)}${TEXT_OPEN} · ${ANSI_RESET}${expectedWindow("weekly", secondaryPercent, secondaryFilledCells, 6 - secondaryFilledCells)}`;
}

function snapshot(primaryUsedPercent, secondaryUsedPercent, resetsAt = FUTURE_RESET) {
  return {
    primary: { usedPercent: primaryUsedPercent, windowMinutes: 300, resetsAt },
    secondary: { usedPercent: secondaryUsedPercent, windowMinutes: 10080, resetsAt: resetsAt + 3600 },
    planType: "pro",
    rateLimitReachedType: null,
    source: "codex-session-log",
    observedAtMs: NOW_MS,
  };
}

test("renderProgressBar keeps a fixed compact colorized width", () => {
  assert.equal(renderProgressBar(0), expectedBar(0, 6));
  assert.equal(renderProgressBar(3), expectedBar(1, 5));
  assert.equal(renderProgressBar(9), expectedBar(1, 5));
  assert.equal(renderProgressBar(34), expectedBar(2, 4));
  assert.equal(renderProgressBar(56), expectedBar(3, 3));
  assert.equal(renderProgressBar(99), expectedBar(5, 1));
  assert.equal(renderProgressBar(100), expectedBar(6, 0));
  assert.equal(renderProgressBar(150), expectedBar(6, 0));
  assert.equal(stripAnsi(renderProgressBar(56)), "━━━━━━");
});

test("formatQuotaStatus keeps both quota bars on one compact footer line", () => {
  const status = formatQuotaStatus(snapshot(34, 12), NOW_MS);

  assert.equal(status, expectedStatus(66, 4, 88, 5));
  assert.equal(stripAnsi(status), "5h ━━━━━━ 66% · weekly ━━━━━━ 88%");
  assert.equal(status.includes("\n"), false);
  assert.ok(stripAnsi(status).length <= 40, `status is too wide: ${stripAnsi(status).length}`);
});

test("formatQuotaStatus marks expired snapshots stale instead of showing old bars", () => {
  assert.equal(formatQuotaStatus(snapshot(34, 12, Math.floor(NOW_MS / 1000) - 1), NOW_MS), "quota stale");
});

test("normalizeQuotaSnapshot accepts Codex session-log snake_case windows", () => {
  const normalized = normalizeQuotaSnapshot({
    limit_id: "codex",
    primary: { used_percent: 34, window_minutes: 300, resets_at: FUTURE_RESET },
    secondary: { used_percent: 12, window_minutes: 10080, resets_at: FUTURE_RESET + 3600 },
    plan_type: "pro",
  }, NOW_MS);

  assert.equal(normalized?.primary?.usedPercent, 34);
  assert.equal(normalized?.secondary?.windowMinutes, 10080);
  assert.equal(formatQuotaStatus(normalized, NOW_MS), expectedStatus(66, 4, 88, 5));
});

test("normalizeQuotaSnapshot accepts app-server camelCase windows", () => {
  const normalized = normalizeQuotaSnapshot({
    limitId: "codex",
    primary: { usedPercent: 51, windowDurationMins: 300, resetsAt: FUTURE_RESET },
    secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: FUTURE_RESET + 3600 },
    planType: "pro",
  }, NOW_MS);

  assert.equal(formatQuotaStatus(normalized, NOW_MS), expectedStatus(49, 3, 97, 5));
});

test("parseQuotaSnapshotFromJsonLine reads token_count event payloads", () => {
  const line = JSON.stringify({
    timestamp: "2026-05-23T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 34, window_minutes: 300, resets_at: FUTURE_RESET },
        secondary: { used_percent: 12, window_minutes: 10080, resets_at: FUTURE_RESET + 3600 },
        plan_type: "pro",
      },
    },
  });

  const parsed = parseQuotaSnapshotFromJsonLine(line, NOW_MS - 1000);
  assert.equal(parsed?.observedAtMs, NOW_MS);
  assert.equal(formatQuotaStatus(parsed, NOW_MS), expectedStatus(66, 4, 88, 5));
});

test("readLatestCodexSessionRateLimits scans newest session tails first", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quota-footer-"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "23");
  fs.mkdirSync(sessionDir, { recursive: true });

  const oldFile = path.join(sessionDir, "old.jsonl");
  fs.writeFileSync(oldFile, `${JSON.stringify({
    timestamp: "2026-05-23T00:00:00.000Z",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 90, window_minutes: 300, resets_at: FUTURE_RESET },
        secondary: { used_percent: 80, window_minutes: 10080, resets_at: FUTURE_RESET + 3600 },
      },
    },
  })}\n`);

  const newFile = path.join(sessionDir, "new.jsonl");
  fs.writeFileSync(newFile, `noise\n${JSON.stringify({
    timestamp: "2026-05-23T00:00:00.000Z",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 34, window_minutes: 300, resets_at: FUTURE_RESET },
        secondary: { used_percent: 12, window_minutes: 10080, resets_at: FUTURE_RESET + 3600 },
      },
    },
  })}\n`);
  fs.utimesSync(oldFile, new Date(NOW_MS - 1000), new Date(NOW_MS - 1000));
  fs.utimesSync(newFile, new Date(NOW_MS), new Date(NOW_MS));

  try {
    const latest = await readLatestCodexSessionRateLimits({ codexHome });
    assert.equal(formatQuotaStatus(latest, NOW_MS), expectedStatus(66, 4, 88, 5));
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
