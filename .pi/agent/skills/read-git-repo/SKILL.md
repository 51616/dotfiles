---
name: read-git-repo
description: |
  Use when:
  - You want to read from a git repo. 
  - Tan gives you a Git URL (GitHub/GitLab/etc.) and wants you to inspect, debug, review, or modify the code.
  - Tan says “read this repo”, “look at this repository”, “clone it and check…”, or similar.

  Don’t use when:
  - The task is primarily reading a web page or online docs (use `codex-browse`).
---

# read-git-repo

## Flow

1) Pick a unique clone dir under `/tmp/`.
   - Prefer something like: `/tmp/pi-repos/<repo-name>-<yyyyMMdd-HHmmss>`.

2) Clone the repo.
   - Default: shallow clone for speed:
     - `git clone --depth 1 <url> <dir>`
   - If you need history (bisect/blame across older commits), do a full clone (omit `--depth 1`).

3) Verify you’re in the repo root.
   - `git -C <dir> rev-parse --show-toplevel`

4) Navigate + search locally.
   - Source code search (default): `ast-grep`.
     - Use it for structure-aware queries/refactors.
     - Examples:
       - Find function calls: `ast-grep -p 'foo($$A)' -l ts,tsx,js,jsx <dir>`
       - Find imports: `ast-grep -p "import $$A from '$$B'" -l ts,tsx,js,jsx <dir>`
   - Plaintext search (docs/config/logs): `rg`.

5) Open files using the `read` tool (not `cat`).

6) Verify changes locally.
   - Run the project’s tests/lint/build when feasible.

7) (Optional) Cleanup.
   - `/tmp` is ephemeral, but if the clone is large, remove it when done.

## Verification

- Validate the skill frontmatter:
  - `python3 /home/tan/.pi/agent/skills/skill-authoring/scripts/quick_validate.py /home/tan/.pi/agent/skills/read-git-repo`
