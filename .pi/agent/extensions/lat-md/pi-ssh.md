# pi-ssh

This extension keeps the pi process, model access, auth, and billing local while delegating coding-tool work to a remote host over SSH.

## Responsibilities

When `--ssh` is set, it overrides `read`, `write`, `edit`, and `bash`, plus user `!` shell commands, so file and shell work happen on the remote host.

It maintains one remote shell session for bash-style work, publishes remote footer state so the interactive cwd line becomes ` <user>@<host>:<remote-path>` after SSH connects, omits branch text from that footer path, and injects remote prompt context from the exact remote working directory when `AGENTS.md` or `CLAUDE.md` exists there.

It also owns the shared SSH session contract at `pi-ssh/lib/pi-ssh-session-runtime.ts`. Other extensions should consume that module instead of importing `skill-uri` internals when they need remote workspace ops, repo-root lookup, local→remote path mapping, exact one-shot SSH probes, low-latency persistent text commands, or remote exists/stat checks. `execText()` is the text-oriented low-latency path; `stat()` should stay on stdout-only exact capture so JSON helpers do not depend on PTY-clean output.

`skill-uri`, `self-checkpointing`, and the `pi-diff-review-*` extensions now all share that single runtime boundary.

## Invariants

Without `--ssh`, the extension must stay inert and preserve normal local tool behavior.

In SSH mode, the interactive footer cwd line should replace the local session cwd with ` <user>@<host>:<remote-path>`, immediately after connect.

If [[tui-broker]] is installed, `pi-ssh` must not replace the footer. It should publish remote footer state through its runtime store, register a footer-path contribution with [[tui-broker/lib/runtime.ts]], and let [[tui-broker]] render the remote cwd inside the canonical footer layout.

In SSH mode, branch text stays out of the footer path. `git-state` owns branch visibility elsewhere, so `pi-ssh` should not fall back to the local branch display.

Remote prompt-context pickup is exact-directory only: probe `remoteCwd/AGENTS.md` first, then `remoteCwd/CLAUDE.md`, and do not walk parent or child directories.

Unreadable remote prompt-context files should fail closed with warnings instead of silently injecting partial or guessed content.

When other extensions validate artifact paths against the SSH workspace, they should use an SSH-aware probe instead of assuming the path exists on the local filesystem. `self-checkpointing` depends on this for footer validation and pending resume.

## Failure and recovery

If SSH connection setup fails, fail clearly instead of silently falling back to local execution for a session that was explicitly started in SSH mode.

If remote prompt-context probing fails, keep the session usable, surface the warning, and avoid injecting broken context into the system prompt.

## Change guidance

If you change prompt-context probing or injection, keep the remote-context test honest because that contract is easy to regress and hard to spot manually.

If you broaden the remote-tool surface beyond the current coding tools and `!` commands, inspect tool rendering and wrapper assumptions so the SSH session remains consistent end to end.

## Verification

Use these checks after changing SSH prompt-context handling, shared session runtime behavior, or remote tool wiring.

- `node --test pi-ssh/test/session-runtime.test.mjs pi-ssh/test/remote-context.test.mjs pi-ssh/test/abort-recovery.test.mjs`
- `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
