import test from "node:test";
import assert from "node:assert/strict";

import { __testInternals } from "../index.ts";

const stripAnsi = (text) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

const {
  buildFooterPathLabel,
  buildRemoteFooterLines,
  buildRemoteFooterLabel,
  buildSingleLineFooter,
  buildStartupNoticeEntries,
  renderStartupNoticeLines,
  shouldPublishStartupNotice,
  filterStartupNoticeMessages,
} = __testInternals;

test("buildFooterPathLabel prefixes the remote path icon and omits branch display", () => {
  assert.equal(buildFooterPathLabel("/remote/home/project", "/remote/home", "main", undefined), " ~/project");
});

test("buildFooterPathLabel appends the session name when present", () => {
  assert.equal(
    buildFooterPathLabel("/remote/home/project", "/remote/home", "main", "ssh session"),
    " ~/project • ssh session",
  );
});

test("buildFooterPathLabel keeps the icon when remote branch is unavailable", () => {
  assert.equal(buildFooterPathLabel("/remote/home/project", "/remote/home", null, undefined), " ~/project");
});

test("buildRemoteFooterLabel replaces the grey footer path with the ssh target and remote path", () => {
  assert.equal(
    buildRemoteFooterLabel(
      {
        remote: "ssh-alias",
        remoteDisplayTarget: "tan@example.com",
        port: 22,
        remoteCwd: "/remote/home/project",
        remoteHome: "/remote/home",
        localCwd: "/local/project",
        localHome: "/local",
      },
      "/remote/home/project",
      "main",
      undefined,
    ),
    " tan@example.com:~/project",
  );
});

test("buildRemoteFooterLines keeps the tui-broker layout without a footer token meter", () => {
  const lines = buildRemoteFooterLines(
    {
      fg(color, text) {
        return `${color}:${text}`;
      },
    },
    {
      pwd: " tan@example.com:~/project",
      modelId: "gpt-5.4",
      modelProvider: "openai",
      reasoning: true,
      thinkingLevel: "high",
      availableProviderCount: 1,
      extensionStatuses: ["ssh active"],
    },
    48,
  );

  assert.deepEqual(lines, [
    `dim:${buildSingleLineFooter(" tan@example.com:~/project", "gpt-5.4 • high", 48)}`,
    "dim:ssh active",
  ]);
});

test("buildRemoteFooterLines dims truncated extension status text, not only the ellipsis", () => {
  const lines = buildRemoteFooterLines(
    {
      fg(color, text) {
        return `${color}:${text}`;
      },
    },
    {
      pwd: " tan@example.com:~/project",
      modelId: "gpt-5.4",
      modelProvider: "openai",
      reasoning: true,
      thinkingLevel: "high",
      availableProviderCount: 1,
      extensionStatuses: ["󰒓 Ready | 󰙯 Online"],
    },
    12,
  );

  assert.equal(lines[0], `dim:${buildSingleLineFooter(" tan@example.com:~/project", "gpt-5.4 • high", 12)}`);
  assert.equal(stripAnsi(lines[1]), "dim:󰒓 Ready |...");
});

test("buildStartupNoticeEntries includes enabled, remote context, and warnings", () => {
  const entries = buildStartupNoticeEntries(
    {
      remote: "ssh-alias",
      remoteDisplayTarget: "tan@example.com",
      port: 22,
      remoteCwd: "/remote/home/project",
      remoteHome: "/remote/home",
      localCwd: "/local/project",
      localHome: "/local",
    },
    "/remote/home/project",
    {
      file: { path: "/remote/home/project/AGENTS.md", content: "# agents" },
      warning: "prompt context warning",
    },
  );

  assert.deepEqual(entries, [
    {
      tone: "info",
      title: "pi-ssh",
      body: ["tan@example.com:/remote/home/project (port 22)"],
      bodyIndent: 0,
    },
    {
      tone: "info",
      title: "Remote Context",
      body: ["~/project/AGENTS.md"],
      bodyIndent: 2,
      separateFromPrevious: true,
    },
    {
      tone: "warning",
      title: "pi-ssh warning",
      body: ["prompt context warning"],
      separateFromPrevious: true,
    },
  ]);
});

test("renderStartupNoticeLines groups startup notices into widget lines", () => {
  const lines = renderStartupNoticeLines(
    {
      fg(color, text) {
        return `${color}:${text}`;
      },
    },
    [
      { tone: "info", title: "pi-ssh", body: ["tan@example.com:/remote/home/project (port 22)"], bodyIndent: 0 },
      { tone: "info", title: "Remote Context", body: ["~/project/AGENTS.md"], bodyIndent: 2, separateFromPrevious: true },
      { tone: "warning", title: "pi-ssh warning", body: ["prompt context warning"], separateFromPrevious: true },
    ],
  );

  assert.deepEqual(lines, [
    "mdHeading:[pi-ssh]",
    "dim:tan@example.com:/remote/home/project (port 22)",
    "",
    "mdHeading:[Remote Context]",
    "dim:  ~/project/AGENTS.md",
    "",
    "warning:[pi-ssh warning]",
    "dim:  prompt context warning",
  ]);
});

test("shouldPublishStartupNotice only allows empty displayed transcripts", () => {
  assert.equal(shouldPublishStartupNotice([]), true);
  assert.equal(shouldPublishStartupNotice([{ type: "custom" }]), true);
  assert.equal(shouldPublishStartupNotice([{ type: "custom_message", display: false }]), true);
  assert.equal(shouldPublishStartupNotice([{ type: "message" }]), false);
  assert.equal(shouldPublishStartupNotice([{ type: "custom_message", display: true }]), false);
});

test("filterStartupNoticeMessages removes pi-ssh startup notices from context", () => {
  const filtered = filterStartupNoticeMessages([
    { role: "user", content: "hi" },
    { role: "custom", customType: "pi-ssh-startup-notice", content: "notice" },
    { role: "custom", customType: "other", content: "keep" },
  ]);

  assert.deepEqual(filtered, [
    { role: "user", content: "hi" },
    { role: "custom", customType: "other", content: "keep" },
  ]);
});
