import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildRunSkillScriptCommand,
  prepareRunSkillScript,
  resolveRunSkillScriptRequest,
} from "../lib/run-skill-script.ts";
import { SkillRegistry, buildSkillUri, encodeSkillId } from "../lib/skill-uris.ts";

function buildRegistry(name, filePath) {
  const registry = new SkillRegistry();
  registry.updateFromPromptSkills(
    [
      {
        name,
        description: `${name} skill`,
        filePath,
      },
    ],
    {
      toRootPath: (value) => dirname(value),
      inferOriginHint: () => "project",
    },
  );
  return registry;
}

test("resolveRunSkillScriptRequest accepts any file under the skill root", async () => {
  const base = await mkdtemp(join(tmpdir(), "skill-uri-run-request-"));
  const skillRoot = join(base, "demo");
  await mkdir(join(skillRoot, "tools"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "demo\n", "utf-8");
  await writeFile(join(skillRoot, "tools", "bootstrap.py"), "print('ok')\n", "utf-8");

  const registry = buildRegistry("demo", join(skillRoot, "SKILL.md"));
  const request = resolveRunSkillScriptRequest(
    {
      script: buildSkillUri(encodeSkillId("demo"), "tools/bootstrap.py"),
      interpreter: "python3",
    },
    registry,
    false,
  );

  assert.equal(request.target, "local");
  assert.equal(request.normalizedRelativePath, "tools/bootstrap.py");
  assert.equal(request.resolvedScript.realPath, join(skillRoot, "tools", "bootstrap.py"));
});

test("resolveRunSkillScriptRequest rejects empty skill-root targets and legacy uris", async () => {
  const base = await mkdtemp(join(tmpdir(), "skill-uri-run-empty-"));
  const skillRoot = join(base, "demo");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "demo\n", "utf-8");

  const registry = buildRegistry("demo", join(skillRoot, "SKILL.md"));

  assert.throws(
    () =>
      resolveRunSkillScriptRequest(
        {
          script: buildSkillUri(encodeSkillId("demo"), ""),
          interpreter: "bash",
        },
        registry,
        false,
      ),
    /point to a file under the skill root/i,
  );

  assert.throws(
    () =>
      resolveRunSkillScriptRequest(
        {
          script: "skill://local/demo/tools/bootstrap.py",
          interpreter: "python3",
        },
        registry,
        false,
      ),
    /source-prefixed skill uris/i,
  );
});

test("prepareRunSkillScript keeps local execution local", async () => {
  const base = await mkdtemp(join(tmpdir(), "skill-uri-run-local-"));
  const skillRoot = join(base, "demo");
  await mkdir(join(skillRoot, "bin"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "demo\n", "utf-8");
  await writeFile(join(skillRoot, "bin", "run"), "#!/usr/bin/env bash\necho ok\n", "utf-8");

  const registry = buildRegistry("demo", join(skillRoot, "SKILL.md"));
  const request = resolveRunSkillScriptRequest(
    {
      script: buildSkillUri(encodeSkillId("demo"), "bin/run"),
      interpreter: "bash",
      target: "local",
    },
    registry,
    false,
  );

  const prepared = await prepareRunSkillScript(request, {
    assertLocalPathSafe: async () => {},
  });

  assert.equal(prepared.staged, false);
  assert.equal(prepared.executionPath, join(skillRoot, "bin", "run"));
});

test("prepareRunSkillScript stages the skill root for remote execution", async () => {
  const base = await mkdtemp(join(tmpdir(), "skill-uri-run-remote-"));
  const skillRoot = join(base, "demo");
  await mkdir(join(skillRoot, "tools"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "demo\n", "utf-8");
  await writeFile(join(skillRoot, "tools", "bootstrap.py"), "print('ok')\n", "utf-8");

  const registry = buildRegistry("demo", join(skillRoot, "SKILL.md"));
  const request = resolveRunSkillScriptRequest(
    {
      script: buildSkillUri(encodeSkillId("demo"), "tools/bootstrap.py"),
      interpreter: "python3",
      target: "remote",
    },
    registry,
    true,
  );

  const writes = [];
  const prepared = await prepareRunSkillScript(request, {
    remoteHome: "/remote/home",
    transport: {
      readFile: async () => {
        throw new Error("missing");
      },
      writeFile: async (path, content) => {
        writes.push({ path, content: content.toString("utf-8") });
      },
    },
    assertLocalPathSafe: async () => {},
  });

  assert.equal(prepared.staged, true);
  assert.match(prepared.executionPath, /^\/remote\/home\/\.cache\/pi\/skill-stage\/demo\//);
  assert.match(prepared.executionPath, /tools\/bootstrap\.py$/);
  assert.ok(writes.some((entry) => entry.path.endsWith("/SKILL.md")));
  assert.ok(writes.some((entry) => entry.path.endsWith("/tools/bootstrap.py")));
});

test("prepareRunSkillScript forwards symlink safety failures", async () => {
  const base = await mkdtemp(join(tmpdir(), "skill-uri-run-symlink-"));
  const skillRoot = join(base, "demo");
  await mkdir(join(skillRoot, "bin"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "demo\n", "utf-8");
  await writeFile(join(skillRoot, "bin", "run"), "echo ok\n", "utf-8");

  const registry = buildRegistry("demo", join(skillRoot, "SKILL.md"));
  const request = resolveRunSkillScriptRequest(
    {
      script: buildSkillUri(encodeSkillId("demo"), "bin/run"),
      interpreter: "bash",
      target: "local",
    },
    registry,
    false,
  );

  await assert.rejects(
    () =>
      prepareRunSkillScript(request, {
        assertLocalPathSafe: async () => {
          throw new Error("Skill path escapes root via symlink: bin/run");
        },
      }),
    /escapes root via symlink/i,
  );
});

test("buildRunSkillScriptCommand quotes the target path and arguments", () => {
  const command = buildRunSkillScriptCommand("python3", "/tmp/my skill.py", ["--name", "Tan's test"]);
  assert.equal(command, "python3 '/tmp/my skill.py' '--name' 'Tan'\"'\"'s test'");
});

test("staged marker reuse avoids uploading the same skill twice", async () => {
  const base = await mkdtemp(join(tmpdir(), "skill-uri-run-cache-"));
  const skillRoot = join(base, "demo");
  await mkdir(join(skillRoot, "bin"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "demo\n", "utf-8");
  await writeFile(join(skillRoot, "bin", "run"), "echo ok\n", "utf-8");

  const registry = buildRegistry("demo", join(skillRoot, "SKILL.md"));
  const request = resolveRunSkillScriptRequest(
    {
      script: buildSkillUri(encodeSkillId("demo"), "bin/run"),
      interpreter: "bash",
      target: "remote",
    },
    registry,
    true,
  );

  const writes = [];
  const prepared = await prepareRunSkillScript(request, {
    remoteHome: "/remote/home",
    transport: {
      readFile: async (path) => {
        if (path.endsWith(".pi-stage-complete.json")) {
          return Buffer.from("{}", "utf-8");
        }
        return await readFile(path);
      },
      writeFile: async (path, content) => {
        writes.push({ path, content });
      },
    },
    assertLocalPathSafe: async () => {},
  });

  assert.equal(prepared.staged, false);
  assert.equal(writes.length, 0);
});
