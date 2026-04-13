import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(testDir, "..", "scripts");
const loggerScript = join(scriptsDir, "pi-ssh-logger.remote.sh");
const setupScript = join(scriptsDir, "pi-ssh-logger-setup.sh");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ssh-test-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

test("pi-ssh-logger preserves stdout, stderr, and exit code for noninteractive commands", () => {
  withTempDir((homeDir) => {
    const result = spawnSync("bash", [loggerScript], {
      env: {
        ...process.env,
        HOME: homeDir,
        SHELL: "/bin/bash",
        SSH_CONNECTION: "203.0.113.4 5555 203.0.113.10 22",
        SSH_ORIGINAL_COMMAND: "printf out; printf err >&2; exit 7",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 7);
    assert.equal(result.stdout, "out");
    assert.match(result.stderr, /\[pi-ssh-logger\] logging to:/);
    assert.match(result.stderr, /err/);

    const logDir = join(homeDir, "ssh-session-logs", "pi");
    const entries = readdirSync(logDir);
    assert.equal(entries.length, 1);

    const logContent = readFileSync(join(logDir, entries[0]), "utf8");
    assert.match(logContent, /\[pi-ssh-logger\] command: printf out; printf err >&2; exit 7/);
    assert.match(logContent, /out/);
    assert.match(logContent, /err/);
  });
});

test("pi-ssh-logger-setup expands ~/ remote paths before upload and verification", () => {
  withTempDir((tempDir) => {
    const fakeBin = join(tempDir, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const callLog = join(tempDir, "calls.log");

    makeExecutable(
      join(fakeBin, "ssh"),
      [
        "#!/usr/bin/env python3",
        "import os, sys",
        "log = os.environ['PI_SSH_TEST_CALL_LOG']",
        "args = sys.argv[1:]",
        "host = args[0] if args else ''",
        "command = args[1] if len(args) > 1 else ''",
        "with open(log, 'a', encoding='utf-8') as fh:",
        "    fh.write(f'SSH host={host} command={command}\\n')",
        "if command == 'printf %s \"$HOME\"':",
        "    sys.stdout.write('/remote/home')",
        "    sys.exit(0)",
        "if command.startswith('mkdir -p -- '):",
        "    sys.exit(0)",
        "if command.startswith('set -euo pipefail; remote_bin='):",
        "    sys.stdout.write('installed=/remote/home/bin/pi-ssh-logger\\nbackup=/remote/home/bin/pi-ssh-logger.bak-2026-04-14_00-37-01\\n')",
        "    sys.exit(0)",
        "if command == 'printf %s ok':",
        "    sys.stdout.write('ok')",
        "    sys.exit(0)",
        "if command == 'ls /definitely-missing':",
        "    sys.stderr.write(\"ls: cannot access '/definitely-missing': No such file or directory\\n\")",
        "    sys.exit(2)",
        "sys.stderr.write(f'unexpected ssh command: {command}\\n')",
        "sys.exit(99)",
      ].join("\n"),
    );

    makeExecutable(
      join(fakeBin, "scp"),
      [
        "#!/usr/bin/env python3",
        "import os, sys",
        "log = os.environ['PI_SSH_TEST_CALL_LOG']",
        "args = sys.argv[1:]",
        "with open(log, 'a', encoding='utf-8') as fh:",
        "    fh.write('SCP ' + ' '.join(args) + '\\n')",
        "sys.exit(0)",
      ].join("\n"),
    );

    const result = spawnSync("bash", [setupScript, "--host", "fake-host"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PI_SSH_TEST_CALL_LOG: callLog,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Uploading logger template to fake-host:\/remote\/home\/bin\/pi-ssh-logger\.new/);
    assert.match(result.stdout, /Installing remote logger at fake-host:\/remote\/home\/bin\/pi-ssh-logger/);
    assert.match(result.stdout, /Verification passed/);

    const calls = readFileSync(callLog, "utf8");
    assert.match(calls, /SSH host=fake-host command=printf %s "\$HOME"/);
    assert.match(calls, /SCP -q -O .* fake-host:\/remote\/home\/bin\/pi-ssh-logger\.new/);
    assert.doesNotMatch(calls, /\/~\//);
    assert.match(calls, /SSH host=fake-host command=printf %s ok/);
    assert.match(calls, /SSH host=fake-host command=ls \/definitely-missing/);
  });
});
