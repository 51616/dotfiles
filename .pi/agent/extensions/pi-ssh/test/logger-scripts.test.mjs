import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function renderLoggerForCommand(directory, command) {
  const commandHash = createHash("sha256").update(command).digest("hex");
  const rendered = readFileSync(loggerScript, "utf8").replaceAll(
    "__PI_SSH_FILE_WORKER_COMMAND_SHA256__",
    commandHash,
  );
  assert.doesNotMatch(rendered, /__PI_SSH_FILE_WORKER_COMMAND_SHA256__/);
  const renderedPath = join(directory, "pi-ssh-logger");
  makeExecutable(renderedPath, rendered);
  return renderedPath;
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

test("pi-ssh-logger audits transfer-marker substrings in executables and arguments", () => {
  for (const buildCommand of [
    (homeDir) => "/bin/echo arbitrary-command-with-sftp-server-marker",
    (homeDir) => {
      const script = join(homeDir, "sftp-server-lookalike");
      makeExecutable(script, "#!/usr/bin/env bash\nprintf script-lookalike-executed\n");
      return script;
    },
  ]) {
    withTempDir((homeDir) => {
      const command = buildCommand(homeDir);
      const result = spawnSync("bash", [loggerScript], {
        env: {
          ...process.env,
          HOME: homeDir,
          SHELL: "/bin/bash",
          SSH_CONNECTION: "203.0.113.4 5555 203.0.113.10 22",
          SSH_ORIGINAL_COMMAND: command,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const logDir = join(homeDir, "ssh-session-logs", "pi");
      const entries = readdirSync(logDir);
      assert.equal(entries.length, 1, command);
      const logContent = readFileSync(join(logDir, entries[0]), "utf8");
      assert.match(logContent, /\[pi-ssh-logger\] command:/);
      assert.match(logContent, /sftp-server/);
      assert.match(logContent, /lookalike|arbitrary-command/);
    });
  }
});

test("pi-ssh-logger audits transfer client modes even when server tokens appear later", () => {
  for (const command of [
    "scp -S /bin/echo -- example.invalid:/etc/hosts -t",
    "rsync -e /bin/echo -- example.invalid:/etc/hosts --server",
    "rsync --server -e/bin/echo . /tmp",
    "rsync --server -ve/bin/echo . /tmp",
    "rsync --server -vecho . /tmp",
    "rsync --server --rsh=/bin/echo . /tmp",
    "scp -t /tmp/target -S /bin/echo",
  ]) {
    withTempDir((homeDir) => {
      const result = spawnSync("bash", [loggerScript], {
        env: {
          ...process.env,
          HOME: homeDir,
          SHELL: "/bin/bash",
          SSH_CONNECTION: "203.0.113.4 5555 203.0.113.10 22",
          SSH_ORIGINAL_COMMAND: command,
        },
        encoding: "utf8",
        timeout: 2_000,
      });
      assert.notEqual(result.status, null, result.error?.message);
      const logDir = join(homeDir, "ssh-session-logs", "pi");
      const entries = readdirSync(logDir);
      assert.equal(entries.length, 1, command);
      const logContent = readFileSync(join(logDir, entries[0]), "utf8");
      assert.ok(logContent.includes(`[pi-ssh-logger] command: ${command}`), command);
    });
  }
});

test("pi-ssh-logger permits canonical and secluded-args rsync server grammar without audit wrapping", (context) => {
  if (!existsSync("/usr/bin/rsync") && !existsSync("/bin/rsync")) {
    context.skip("rsync is not installed");
    return;
  }
  for (const command of [
    "rsync --server -logDtpre.iLsfxCIvu . /tmp",
    "rsync --server -se.LsfxCIvu",
    "rsync --server --sender -se.LsfxCIvu",
  ]) {
    withTempDir((homeDir) => {
      const result = spawnSync("bash", [loggerScript], {
        env: {
          ...process.env,
          HOME: homeDir,
          SHELL: "/bin/bash",
          SSH_CONNECTION: "203.0.113.4 5555 203.0.113.10 22",
          SSH_ORIGINAL_COMMAND: command,
        },
        encoding: "utf8",
        timeout: 2_000,
      });
      assert.notEqual(result.status, null, result.error?.message);
      assert.equal(existsSync(join(homeDir, "ssh-session-logs", "pi")), false, command);
    });
  }
});

test("pi-ssh-logger preserves worker frames without copying payloads into audit logs", () => {
  withTempDir((homeDir) => {
    const payloadMarker = "PI_SSH_PRIVATE_FILE_PAYLOAD";
    const eventMarker = '{"event":"request.complete","operation":"read","responseBytes":32}';
    const workerCommand = [
      "PI_SSH_FILE_WORKER_PROTOCOL=1",
      "export PI_SSH_FILE_WORKER_PROTOCOL",
      `printf '%s' '${payloadMarker}'`,
      `printf '%s\\n' '${eventMarker}' >&2`,
      "exit 7",
    ].join("; ");
    const renderedLogger = renderLoggerForCommand(homeDir, workerCommand);
    const result = spawnSync("bash", [renderedLogger], {
      env: {
        ...process.env,
        HOME: homeDir,
        SHELL: "/bin/bash",
        SSH_CONNECTION: "203.0.113.4 5555 203.0.113.10 22",
        SSH_ORIGINAL_COMMAND: workerCommand,
      },
      encoding: null,
    });

    assert.equal(result.status, 7);
    assert.deepEqual(result.stdout, Buffer.from(payloadMarker));
    assert.match(result.stderr.toString("utf8"), /request\.complete/);

    const logDir = join(homeDir, "ssh-session-logs", "pi");
    const entries = readdirSync(logDir);
    assert.equal(entries.length, 1);
    const logContent = readFileSync(join(logDir, entries[0]), "utf8");
    assert.match(logContent, /command: pi-ssh-file-worker protocol=1/);
    assert.match(logContent, /request\.complete/);
    assert.doesNotMatch(logContent, new RegExp(payloadMarker));
    assert.doesNotMatch(logContent, /printf/);
  });
});

test("pi-ssh-logger rejects marker lookalikes without executing or logging their payload", () => {
  withTempDir((homeDir) => {
    const trustedCommand = "PI_SSH_FILE_WORKER_PROTOCOL=1; export PI_SSH_FILE_WORKER_PROTOCOL; printf trusted";
    const payloadMarker = "PI_SSH_HASH_MISMATCH_PRIVATE_PAYLOAD";
    const lookalikeCommand = `${trustedCommand}; printf '${payloadMarker}'`;
    const renderedLogger = renderLoggerForCommand(homeDir, trustedCommand);
    const result = spawnSync("bash", [renderedLogger], {
      env: {
        ...process.env,
        HOME: homeDir,
        SHELL: "/bin/bash",
        SSH_CONNECTION: "203.0.113.4 5555 203.0.113.10 22",
        SSH_ORIGINAL_COMMAND: lookalikeCommand,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 126);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /launcher hash mismatch/);
    assert.doesNotMatch(result.stderr, new RegExp(payloadMarker));

    const logDir = join(homeDir, "ssh-session-logs", "pi");
    const entries = readdirSync(logDir);
    assert.equal(entries.length, 1);
    const logContent = readFileSync(join(logDir, entries[0]), "utf8");
    assert.match(logContent, /launcher hash mismatch/);
    assert.doesNotMatch(logContent, new RegExp(payloadMarker));
    assert.doesNotMatch(logContent, /printf/);
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
        "if command.startswith('PI_SSH_FILE_WORKER_PROTOCOL=1; export PI_SSH_FILE_WORKER_PROTOCOL; '):",
        "    sys.stdout.buffer.write(b'\\x00\\x00\\x00\\x20{\"kind\":\"hello\",\"version\":1}')",
        "    sys.stderr.write('[pi-ssh-logger] logging to: /remote/home/ssh-session-logs/pi/worker.log\\n')",
        "    sys.stderr.write('{\"event\":\"worker.ready\",\"protocolVersion\":1}\\n')",
        "    sys.exit(0)",
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
        "if args[-1].endswith('/remote/home/bin/pi-ssh-logger.new'):",
        "    with open(args[-2], 'r', encoding='utf-8') as fh:",
        "        content = fh.read()",
        "    if '__PI_SSH_FILE_WORKER_COMMAND_SHA256__' in content:",
        "        sys.stderr.write('logger hash placeholder was not rendered\\n')",
        "        sys.exit(98)",
        "    with open(log, 'a', encoding='utf-8') as fh:",
        "        fh.write('LOGGER_HASH_RENDERED=yes\\n')",
        "if any('ssh-session-logs/pi/worker.log' in arg for arg in args):",
        "    with open(args[-1], 'w', encoding='utf-8') as fh:",
        "        fh.write('[pi-ssh-logger] command: pi-ssh-file-worker protocol=1 sha256=test\\n')",
        "        fh.write('{\"event\":\"worker.ready\",\"protocolVersion\":1}\\n')",
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
    assert.match(calls, /LOGGER_HASH_RENDERED=yes/);
    assert.doesNotMatch(calls, /\/~\//);
    assert.match(calls, /SSH host=fake-host command=printf %s ok/);
    assert.match(calls, /SSH host=fake-host command=ls \/definitely-missing/);
    assert.match(calls, /SSH host=fake-host command=PI_SSH_FILE_WORKER_PROTOCOL=1/);
    assert.match(calls, /SCP -q -O fake-host:\/remote\/home\/ssh-session-logs\/pi\/worker\.log/);
  });
});
