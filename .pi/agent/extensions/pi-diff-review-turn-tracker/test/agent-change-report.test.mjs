// @lat: [[tests#Agent change report validation keeps canonical-vs-advisory boundaries exact]]

import test from "node:test";
import assert from "node:assert/strict";

import { buildPersistedAgentChangeReport, buildSummarizerPayload } from "../lib/agent-change-report.ts";

function repoMetadata(overrides = {}) {
  return {
    saved_at: "2026-03-31T00:00:00.000Z",
    session_id: "session-1",
    turn_id: "turn-1",
    source: "last_turn_repo_snapshot",
    review_source: "last turn (repo snapshot)",
    repo_root: "/repo",
    repo_key: "repo-demo",
    touched_paths: ["src/a.ts", "src/b.ts"],
    observed_changed_paths: ["src/a.ts"],
    has_bash_calls: false,
    workspace: false,
    ...overrides,
  };
}

test("buildPersistedAgentChangeReport computes exact mismatch arrays and ignores model-supplied ones", () => {
  const report = buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [
        { path: "src/a.ts", summary: "Updated the implementation." },
        { path: "docs/notes.md", summary: "Documented the change." },
      ],
    },
    metadata: repoMetadata({ touched_paths: ["src/a.ts", "src/b.ts", "docs/notes.md"] }),
    generatedAt: "2026-03-31T00:00:01.000Z",
  });

  assert.deepEqual(report.files, [
    { path: "src/a.ts", summary: "Updated the implementation." },
    { path: "docs/notes.md", summary: "Documented the change." },
  ]);
  assert.deepEqual(report.missing_from_observed, ["docs/notes.md"]);
  assert.deepEqual(report.missing_from_agent_report, []);
});

test("buildPersistedAgentChangeReport rejects invalid paths, non-candidate paths, and non-empty empty-turn reports", () => {
  assert.equal(buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [{ path: "../escape.ts", summary: "bad" }],
    },
    metadata: repoMetadata(),
    generatedAt: "2026-03-31T00:00:01.000Z",
  }), null);

  assert.equal(buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [{ path: "a/src/a.ts", summary: "patch-prefixed hallucination" }],
    },
    metadata: repoMetadata(),
    generatedAt: "2026-03-31T00:00:01.000Z",
  }), null);

  assert.equal(buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [{ path: "src/a.ts", summary: "bad" }],
    },
    metadata: repoMetadata({ observed_changed_paths: [] }),
    generatedAt: "2026-03-31T00:00:01.000Z",
  }), null);
});

test("buildPersistedAgentChangeReport requires workspace-prefixed paths for workspace artifacts", () => {
  const report = buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [
        { path: "repo-a/src/a.ts", summary: "repo a change" },
        { path: "repo-b/docs/b.md", summary: "repo b change" },
      ],
    },
    metadata: {
      ...repoMetadata({
        repo_root: "workspace",
        repo_key: "workspace",
        workspace: true,
        touched_paths: ["repo-a/src/a.ts", "repo-b/docs/b.md"],
        observed_changed_paths: ["repo-a/src/a.ts"],
        repos: [
          { repo_key: "repo-a", repo_root: "/repo-a", touched_paths: ["src/a.ts"], observed_changed_paths: ["src/a.ts"] },
          { repo_key: "repo-b", repo_root: "/repo-b", touched_paths: ["docs/b.md"], observed_changed_paths: [] },
        ],
      }),
    },
    generatedAt: "2026-03-31T00:00:01.000Z",
  });

  assert.deepEqual(report.missing_from_observed, ["repo-b/docs/b.md"]);
  assert.deepEqual(report.missing_from_agent_report, []);
  assert.equal(buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [{ path: "src/a.ts", summary: "missing repo prefix" }],
    },
    metadata: {
      ...repoMetadata({
        repo_root: "workspace",
        repo_key: "workspace",
        workspace: true,
        observed_changed_paths: ["repo-a/src/a.ts"],
        repos: [{ repo_key: "repo-a", repo_root: "/repo-a", touched_paths: ["src/a.ts"], observed_changed_paths: ["src/a.ts"] }],
      }),
    },
    generatedAt: "2026-03-31T00:00:01.000Z",
  }), null);

  assert.equal(buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [{ path: "repo-a/:(glob)src/a.ts", summary: "git pathspec magic is not allowed" }],
    },
    metadata: {
      ...repoMetadata({
        repo_root: "workspace",
        repo_key: "workspace",
        workspace: true,
        observed_changed_paths: ["repo-a/src/a.ts"],
        repos: [{ repo_key: "repo-a", repo_root: "/repo-a", touched_paths: ["src/a.ts"], observed_changed_paths: ["src/a.ts"] }],
      }),
    },
    generatedAt: "2026-03-31T00:00:01.000Z",
  }), null);
});

test("buildPersistedAgentChangeReport only accepts paths that survived payload bounding", () => {
  const manyPaths = Array.from({ length: 60 }, (_, index) => `src/file-${index + 1}.ts`);
  const report = buildPersistedAgentChangeReport({
    draft: {
      generator: "mock-codex",
      files: [{ path: "src/file-60.ts", summary: "Out-of-payload path." }],
    },
    metadata: repoMetadata({
      touched_paths: manyPaths,
      observed_changed_paths: [],
    }),
    generatedAt: "2026-03-31T00:00:01.000Z",
  });

  assert.equal(report, null);
});

test("buildSummarizerPayload keeps input bounded and includes canonical context", () => {
  const payload = buildSummarizerPayload({
    metadata: repoMetadata({ note: "No repo changes were observed during the last turn." }),
    patchText: [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n"),
  });

  assert.deepEqual(payload.observed_changed_paths, ["src/a.ts"]);
  assert.deepEqual(payload.touched_paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(payload.patch_sections.length, 1);
  assert.match(payload.patch_sections[0].patch, /diff --git a\/src\/a.ts b\/src\/a.ts/);
  assert.match(payload.note, /No repo changes were observed/);
});
