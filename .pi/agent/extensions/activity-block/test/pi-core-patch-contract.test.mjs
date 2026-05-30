import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readPatch(version) {
	return readFileSync(join(extensionRoot, "patches", version, "pi-core-local-extension-seams.patch"), "utf8");
}

test("v0.78.0 core patch suppresses live tool_execution_start rows", () => {
	const patch = readPatch("v0.78.0");
	const hunk = patch.match(/case "tool_execution_start": \{[\s\S]{0,500}?let component = this\.pendingTools\.get\(event\.toolCallId\);/)?.[0] ?? "";

	assert.match(hunk, /\+\s*if \(!this\.shouldShowLiveToolRows\(\)\) \{/);
	assert.match(hunk, /\+\s*break;/);
	assert.match(hunk, /let component = this\.pendingTools\.get\(event\.toolCallId\);/);
});
