---
name: regular-commits
description: |
  Use when: any implementation, docs, config, skill, extension, script, or test work changes files in a git repo, unless Tan explicitly asks not to commit yet. Treat this as default behavior for normal coding sessions, multi-step tracks, mixed edits, and requested commit/push operations.
  Don’t use when: there are zero file changes; Tan explicitly requests no commits yet; changes are only temporary logs/caches/runtime artifacts; or ownership of dirty files is unclear and cannot be staged safely.
  Outputs: local commits split by intent, explicit-path staging that preserves unrelated user changes, verification evidence, a clean repo for pi-owned changes when feasible, and a commit report. Do not push unless Tan explicitly asks.
---

# regular-commits

Use this skill whenever pi-owned work changes code, docs, scripts, skills, extensions, tests, or config in a git repo.

## Goal

Keep history easy to read and easy to revert:
- split commits by intent, not by file extension
- commit after each meaningful unit of completed work
- preserve unrelated user changes
- verify the staged diff before committing
- do not push unless Tan explicitly asks

## Default flow

1. Identify every touched git repo and its root.
2. Run `git status --short` before staging.
3. Decide which files/hunks are pi-owned for the current task.
4. Run the relevant verification before or immediately after committing.
5. Stage explicit paths or explicit hunks only.
6. Inspect `git diff --cached` and `git diff --cached --check`.
7. Commit with a Conventional Commit header.
8. Run `git status --short` again and report pending files.

## Ownership guard

Only commit files changed for the current task. Treat pre-existing dirty files as user-owned unless there is clear evidence they were produced by this task.

If a file contains both pi-owned and user-owned edits, use partial staging. If safe partial staging is not practical, leave the file uncommitted and report why.

Never commit temporary logs, caches, local runtime state, editor files, or generated artifacts unless they are explicitly part of the requested change.

## Staging safety

Prefer explicit staging:
- good: `git add path/to/file path/to/other-file`
- good: `git add -p path/to/file` when a file has mixed ownership
- avoid: `git add -A`, `git add .`, `git commit -a`

Broad staging is allowed only when the repo is clean except for pi-owned changes and you have checked `git status --short` first.

Before committing, inspect the staged diff. If the staged diff contains unrelated changes, unstage and fix the staging.

## Commit splitting

Use one commit per intent:
- behavior change + its regression test: same commit
- docs that explain the same behavior: same commit when tightly coupled
- unrelated cleanup: separate commit
- mechanical rename and behavior change: separate commits when feasible
- multiple repos: separate commits, one repo at a time

Do not create tiny commits for every file if they only make sense together. Do not combine unrelated fixes just because they were discovered in one session.

## Commit header contract

Format:

`<type>(<optional-scope>): <imperative summary>`

Allowed `type` values:
- `feat`, `fix`, `refactor`, `build`, `ci`, `chore`, `docs`, `style`, `perf`, `test`

Rules:
- use imperative mood: `fix`, `add`, `remove`, `document`
- name the intent, not just the file
- keep the subject specific and concise
- avoid `wip`, `update`, `misc`, `stuff`

## Verification

Always run:
- `git status --short` before staging
- `git diff --cached --check` before committing
- `git status --short` after committing

When code/tests/scripts changed, run the smallest meaningful test, lint, typecheck, or smoke command that proves the change.

When docs changed, run link/lattice/doc validation if the repo provides it. Otherwise, a diff inspection is enough.

When skills or extensions changed, run the relevant validator or targeted test. If `AGENTS.md` requires `/reload`, run it after the skill/extension update.

## Push policy

Do not push by default. Commit locally and report the commit hashes.

Push only when Tan explicitly asks. When pushing, report the remote, branch, and pushed commit range. If push is skipped, say that it was skipped because the default policy is no push.

## Multi-repo handling

When work touches multiple git repos, commit each repo separately. Report the repo path, branch, commit hash, verification, and remaining dirty state for each repo.

For bare repos, use the repo’s established invocation, such as `git --git-dir=... --work-tree=...`, and keep explicit-path staging.

## Response reporting contract

When commits happen, include:
- repo path and branch
- commit hash and subject
- whether anything was pushed
- verification commands run
- pending dirty files, labeled as unrelated or intentionally pending

Example:

```md
Committed:
- `/home/tan/vault` on `main`
  - `abc1234 docs(pi): clarify commit hygiene policy`

Pushed: no, per default no-push policy.

Verification:
- `python .pi/skills/skill-authoring/scripts/quick_validate.py .pi/skills/regular-commits`
- `git diff --cached --check`

Pending unrelated dirty files:
- `AGENTS.md`
- `lat-md/areas.md`
```
