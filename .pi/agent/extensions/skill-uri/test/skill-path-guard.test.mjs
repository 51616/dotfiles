import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillPathGuard } from "../lib/skill-path-guard.ts";

test("SkillPathGuard rejects symlink escapes", async () => {
  if (process.platform === "win32") {
    // Symlink behavior/permissions vary; skip on Windows.
    return;
  }

  const base = await mkdtemp(join(tmpdir(), "pi-ssh-skill-guard-"));
  const skillRoot = join(base, "skill");
  const outside = join(base, "outside");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n", "utf-8");
  await writeFile(join(outside, "secret.txt"), "nope", "utf-8");

  const linkPath = join(skillRoot, "link");
  try {
    await symlink(outside, linkPath, "dir");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error).code;
      if (code === "EPERM") {
        // Environment disallows symlinks.
        return;
      }
    }
    throw error;
  }

  const guard = new SkillPathGuard();

  await guard.assertNoSymlinkEscape(skillRoot, "SKILL.md");

  await assert.rejects(
    () => guard.assertNoSymlinkEscape(skillRoot, "link/secret.txt"),
    /escapes root via symlink/i,
  );
});
