---
name: pi-remote-sync-and-run
description: |
  Use when: syncing a local repo under `~/research/` to the mirrored path on a remote host, running commands or experiments there through the pi SSH alias. Typical triggers: “sync this project to the cluster”, “run this experiment remotely”, “push my local code and execute it on the GPU box”, “update the remote checkout and run from there”, or “show me the remote sync status”.
  Don’t use when: you want ad-hoc direct SSH access or manual server administration; use `pi-ssh` instead.
---

# pi-remote-sync-and-run

This skill is the direct-sync workflow for repos under `~/research/`.

It assumes:
- the local repo path is mirrored on the remote host under `~/research/...`
- local is the source of truth for logic files
- remote-only data, results, checkpoints, and logs may live inside the same repo tree, so the sync tool must protect them
- `uv` manages environment freshness itself; this skill does not sync or refresh `.venv`

The workflow is intentionally mutable. It updates the remote repo in place. That is fast and convenient. It is not an immutable provenance workflow.

## Flow

1) Build a manifest of sync-owned files from the local git repo.
2) Sync only those files into the mirrored remote repo path.
3) Prune only files that were previously sync-owned but are no longer in the manifest.
4) Never prune protected remote-owned paths like `results/**`, `data/**`, `checkpoints/**`, or `logs/**`.
5) Optionally run a remote command from the synced repo root.

## Scripts

Main CLI:
- `scripts/pi-remote-sync-and-run.py`

Convenience wrappers:
- `scripts/pi-remote-init-config`
- `scripts/pi-remote-status`
- `scripts/pi-remote-sync`
- `scripts/pi-remote-run`

Template config:
- `templates/pi-remote-sync.toml.template`

## Typical usage

Initialize a repo-local config for the current project:
```bash
bash ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-init-config --host gcp_slurm_sakana_eu-pi-agent
```


Show inferred paths and last remote sync metadata:
```bash
bash ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-status --host gcp_slurm_sakana_eu-pi-agent
```

Dry-run a sync:
```bash
bash ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-sync --host gcp_slurm_sakana_eu-pi-agent --dry-run
```

Sync tracked code/config files into the mirrored remote repo:
```bash
bash ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-sync --host gcp_slurm_sakana_eu-pi-agent
```

Sync, then run a remote command from the repo root:
```bash
bash ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-run --host gcp_slurm_sakana_eu-pi-agent -- uv run python examples/ed_mnist/evaluate.py
```

Skip sync and just run from the already-synced remote repo:
```bash
bash ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-run --host gcp_slurm_sakana_eu-pi-agent --no-sync -- uv run python examples/ed_mnist/evaluate.py
```

## Config

For a new project under `~/research/...`, initialize the repo-local config from the template:

```bash
bash ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-init-config --host gcp_slurm_sakana_eu-pi-agent
```

That writes `./.pi-remote-sync.toml` in the current git repo root. Use `--force` to overwrite an existing config.

Then edit:
- `sync.include` for sync-owned logic paths
- `sync.exclude` for local junk that should never sync
- `sync.protect` for remote-owned paths that must never be pruned
- `default_host` if one remote is the normal default

Pattern for other projects:
- keep `sync.include` narrow and code-focused
- list stable remote-only prefixes in `sync.protect`
- avoid broad root-level delete ownership over anything that may hold experiment outputs
- leave `include_untracked = false` unless you explicitly need local untracked files on the remote host

If no config file exists, the tool syncs git-tracked files by default, excludes common junk, and protects common result/data prefixes.

## Safety rules

- Use the `-pi-agent` SSH alias when possible.
- Do not store valuable remote-only artifacts outside stable protected prefixes.
- Do not treat this workflow as immutable; later syncs can change what queued jobs will see.
- Do not edit sync-owned files directly on the remote host unless you are fine with them being overwritten later.

## Verification

Run all of these from a repo under `~/research/...`:

```bash
python3 ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-sync-and-run.py init-config --host gcp_slurm_sakana_eu-pi-agent --force
python3 ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-sync-and-run.py status --host gcp_slurm_sakana_eu-pi-agent --json
python3 ~/.pi/agent/skills/pi-remote-sync-and-run/scripts/pi-remote-sync-and-run.py sync --host gcp_slurm_sakana_eu-pi-agent --dry-run --json
```

Expected result:
- the remote repo path resolves under the mirrored `~/research/...` path
- the manifest is non-empty
- dry-run prints a sync id and change summary without mutating the remote repo
