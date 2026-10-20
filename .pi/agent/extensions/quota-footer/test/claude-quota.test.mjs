import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeQuotaError, normalizeClaudeUsageResponse, readClaudeRateLimits } from "../lib/claude-quota.ts";
import { formatQuotaStatus } from "../lib/quota-footer.ts";
import { readQuotaStatusForProvider, resolveQuotaSource } from "../lib/quota-source.ts";

const NOW_MS = Date.parse("2026-10-20T05:00:00.000Z");
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (text) => text.replace(ANSI_REGEX, "");

// Trimmed real response from https://api.anthropic.com/api/oauth/usage (2026-10-20).
const USAGE_RESPONSE = {
  five_hour: { utilization: 34.0, resets_at: "2026-10-20T08:49:59.763747+00:00" },
  seven_day: { utilization: 12.0, resets_at: "2026-10-26T05:59:59.763792+00:00" },
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
};

function writeCredentials(dir, expiresAt) {
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok-123", refreshToken: "r", expiresAt } }),
  );
}

async function withUsageServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/api/oauth/usage`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("normalizeClaudeUsageResponse maps five_hour/seven_day onto the shared 5h/weekly footer", () => {
  const snapshot = normalizeClaudeUsageResponse(USAGE_RESPONSE, NOW_MS);
  assert.equal(snapshot?.source, "claude-oauth-usage");
  assert.equal(snapshot?.primary?.windowMinutes, 300);
  assert.equal(snapshot?.secondary?.windowMinutes, 10080);
  assert.equal(snapshot?.primary?.resetsAt, Math.floor(Date.parse("2026-10-20T08:49:59.763Z") / 1000));
  assert.equal(stripAnsi(formatQuotaStatus(snapshot, NOW_MS)), "5h ━━━━━━ 66% · weekly ━━━━━━ 88%");
});

test("normalizeClaudeUsageResponse flags an exhausted plan window", () => {
  const snapshot = normalizeClaudeUsageResponse(
    { ...USAGE_RESPONSE, five_hour: { utilization: 100, resets_at: USAGE_RESPONSE.five_hour.resets_at } },
    NOW_MS,
  );
  assert.ok(stripAnsi(formatQuotaStatus(snapshot, NOW_MS)).endsWith(" !"));
});

test("readClaudeRateLimits sends the Claude Code OAuth token to the usage endpoint", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-quota-"));
  writeCredentials(configDir, NOW_MS + 3_600_000);
  let seenHeaders;
  try {
    const snapshot = await withUsageServer((req, res) => {
      seenHeaders = req.headers;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(USAGE_RESPONSE));
    }, (usageUrl) => readClaudeRateLimits({ claudeConfigDir: configDir, usageUrl, observedAtMs: NOW_MS }));

    assert.equal(seenHeaders.authorization, "Bearer tok-123");
    assert.equal(seenHeaders["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(snapshot.primary?.usedPercent, 34);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("readClaudeRateLimits fails with a typed reason instead of refreshing an expired token", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-quota-"));
  writeCredentials(configDir, NOW_MS - 1);
  try {
    await assert.rejects(
      readClaudeRateLimits({ claudeConfigDir: configDir, usageUrl: "http://127.0.0.1:1/unused", observedAtMs: NOW_MS }),
      (error) => error instanceof ClaudeQuotaError && error.reason === "token-expired",
    );
    await assert.rejects(
      readClaudeRateLimits({ claudeConfigDir: path.join(configDir, "missing"), observedAtMs: NOW_MS }),
      (error) => error instanceof ClaudeQuotaError && error.reason === "no-credentials",
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("readClaudeRateLimits surfaces HTTP errors", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-quota-"));
  writeCredentials(configDir, NOW_MS + 3_600_000);
  try {
    await withUsageServer((_req, res) => {
      res.statusCode = 401;
      res.end("{}");
    }, (usageUrl) => assert.rejects(
      readClaudeRateLimits({ claudeConfigDir: configDir, usageUrl, observedAtMs: NOW_MS }),
      (error) => error instanceof ClaudeQuotaError && error.reason === "http" && /401/.test(error.message),
    ));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("resolveQuotaSource routes only subscription providers", () => {
  assert.equal(resolveQuotaSource("openai-codex"), "codex");
  assert.equal(resolveQuotaSource("claude-code"), "claude");
  assert.equal(resolveQuotaSource("anthropic"), null);
  assert.equal(resolveQuotaSource("openrouter"), null);
  assert.equal(resolveQuotaSource(undefined), null);
});

test("readQuotaStatusForProvider tells the user quota is unavailable for other providers", async () => {
  const result = await readQuotaStatusForProvider("openrouter", NOW_MS);
  assert.equal(stripAnsi(result.text), "quota n/a for openrouter");
  assert.equal(result.error, undefined);
  assert.equal(stripAnsi((await readQuotaStatusForProvider(undefined, NOW_MS)).text), "quota n/a for no model");
});
