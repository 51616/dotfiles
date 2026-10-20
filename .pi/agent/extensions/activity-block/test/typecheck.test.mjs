import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceDir = dirname(extensionDir);

// pi loads extensions with jiti, which strips types without checking them. A pi upgrade that renames or
// removes an extension API (as 1.x did for the patched transcript seams) would otherwise only fail at runtime.
test("activity-block typechecks against the workspace's pinned pi runtime", { timeout: 120_000 }, () => {
	const tsc = join(workspaceDir, "node_modules", "typescript", "bin", "tsc");
	let output = "";
	try {
		execFileSync(process.execPath, [tsc, "-p", join(extensionDir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" });
	} catch (error) {
		output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
	}
	assert.equal(output.trim(), "", `tsc reported errors:\n${output}`);
});
