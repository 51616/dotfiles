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
  parseSshConfigHostAliases,
  renderStartupNoticeLines,
  resolveSshDisplayTarget,
  shouldPublishStartupNotice,
  filterStartupNoticeMessages,
} = __testInternals;

test("parseSshConfigHostAliases returns concrete host aliases in config order", () => {
  assert.deepEqual(
    parseSshConfigHostAliases(`
Host gcp_slurm_sakana_eu *.example !blocked
  HostName 34.91.238.94
Host gcp_slurm_sakana_eu-pi-agent # comment
  HostName 34.91.238.94
Host *
  ServerAliveInterval 30
`),
    ["gcp_slurm_sakana_eu", "gcp_slurm_sakana_eu-pi-agent"],
  );
});

test("resolveSshDisplayTarget uses a directly requested ssh config alias", async () => {
  const target = await resolveSshDisplayTarget("gcp_slurm_sakana_eu-pi-agent", 22, {
    readConfigText: () => "Host gcp_slurm_sakana_eu-pi-agent\n  HostName 34.91.238.94\n",
    resolveEffectiveTarget: async () => {
      throw new Error("alias input should not need ssh -G resolution");
    },
  });

  assert.equal(target, "gcp_slurm_sakana_eu-pi-agent");
});

test("resolveSshDisplayTarget maps a full user-host target to the first matching ssh config alias", async () => {
  const effectiveTargets = new Map([
    ["rujikorn_sakana_ai@34.91.238.94", { user: "rujikorn_sakana_ai", hostname: "34.91.238.94", port: "22" }],
    ["gcp_slurm_sakana_eu", { user: "rujikorn_sakana_ai", hostname: "34.91.238.94", port: "22" }],
    ["gcp_slurm_sakana_eu-pi-agent", { user: "rujikorn_sakana_ai", hostname: "34.91.238.94", port: "22" }],
  ]);

  const target = await resolveSshDisplayTarget("rujikorn_sakana_ai@34.91.238.94", 22, {
    readConfigText: () => `
Host gcp_slurm_sakana_eu
  HostName 34.91.238.94
  User rujikorn_sakana_ai
Host gcp_slurm_sakana_eu-pi-agent
  HostName 34.91.238.94
  User rujikorn_sakana_ai
`,
    resolveEffectiveTarget: async (remote) => effectiveTargets.get(remote) ?? null,
  });

  assert.equal(target, "gcp_slurm_sakana_eu");
});

test("buildFooterPathLabel prefixes the remote path icon and omits branch display", () => {
  assert.equal(buildFooterPathLabel("/remote/home/project", "/remote/home", "main", undefined), " ~/project");
});

test("buildFooterPathLabel appends the session name when present", () => {
  assert.equal(
    buildFooterPathLabel("/remote/home/project", "/remote/home", "main", "ssh session"),
    " ~/project • ssh session",
  );
});

test("buildFooterPathLabel keeps the icon when remote branch is unavailable", () => {
  assert.equal(buildFooterPathLabel("/remote/home/project", "/remote/home", null, undefined), " ~/project");
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
    " tan@example.com:~/project",
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
      pwd: " tan@example.com:~/project",
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
    `dim:${buildSingleLineFooter(" tan@example.com:~/project", "󰚩 gpt-5.4 · 󰧑 high", 48)}`,
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
      pwd: " tan@example.com:~/project",
      modelId: "gpt-5.4",
      modelProvider: "openai",
      reasoning: true,
      thinkingLevel: "high",
      availableProviderCount: 1,
      extensionStatuses: ["󰒓 Ready | 󰙯 Online"],
    },
    12,
  );

  assert.equal(lines[0], `dim:${buildSingleLineFooter(" tan@example.com:~/project", "󰚩 gpt-5.4 · 󰧑 high", 12)}`);
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
