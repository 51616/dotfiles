#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import fnmatch
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Sequence

METADATA_DIRNAME = ".pi-remote-sync"
CONFIG_FILENAME = ".pi-remote-sync.toml"
DEFAULT_PROTECT = [
    "results/**",
    "output/**",
    "outputs/**",
    "data/**",
    "datasets/**",
    "artifacts/**",
    "runs/**",
    "checkpoints/**",
    "logs/**",
    "wandb/**",
    "mlruns/**",
]
DEFAULT_EXCLUDE = [
    ".git/**",
    ".venv/**",
    "venv/**",
    "__pycache__/**",
    ".pytest_cache/**",
    ".mypy_cache/**",
    ".ruff_cache/**",
    "node_modules/**",
    ".pi/**",
    f"{METADATA_DIRNAME}/**",
    "*.log",
]
REMOTE_FINALIZE_SCRIPT = r'''
from __future__ import annotations
import fnmatch
import json
import os
import pathlib
import shutil
import sys

repo_root = pathlib.Path(sys.argv[1]).resolve()
meta_dir = repo_root / sys.argv[2]
protect_patterns = json.loads(sys.argv[3])
dry_run = sys.argv[4] == "1"

current_path = meta_dir / "current-manifest.txt"
next_path = meta_dir / "current-manifest.txt.next"
status_next_path = meta_dir / "last-sync.json.next"
status_path = meta_dir / "last-sync.json"

meta_dir.mkdir(parents=True, exist_ok=True)


def load_manifest(path: pathlib.Path) -> set[str]:
    if not path.exists():
        return set()
    out: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        norm = pathlib.PurePosixPath(raw)
        if norm.is_absolute() or ".." in norm.parts:
            continue
        out.add(norm.as_posix())
    return out


def matches(patterns: list[str], rel: str) -> bool:
    return any(fnmatch.fnmatchcase(rel, pattern) for pattern in patterns)


def is_safe_target(target: pathlib.Path) -> bool:
    try:
        target.relative_to(repo_root)
        return True
    except ValueError:
        return False


def cleanup_empty_parents(path: pathlib.Path) -> None:
    parent = path.parent
    while parent != repo_root and parent != meta_dir and is_safe_target(parent):
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


current = load_manifest(current_path)
next_manifest = load_manifest(next_path)

removed = 0
protected = 0
missing = 0
errors: list[str] = []

for rel in sorted(current - next_manifest):
    if matches(protect_patterns, rel):
        protected += 1
        continue
    target = (repo_root / rel).resolve(strict=False)
    if not is_safe_target(target):
        errors.append(f"unsafe:{rel}")
        continue
    if not target.exists() and not target.is_symlink():
        missing += 1
        continue
    if dry_run:
        removed += 1
        continue
    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
        cleanup_empty_parents(target)
        removed += 1
    except Exception as exc:
        errors.append(f"{rel}: {exc}")

if not dry_run:
    os.replace(next_path, current_path)
    if status_next_path.exists():
        os.replace(status_next_path, status_path)

print(json.dumps({
    "removed": removed,
    "protected": protected,
    "missing": missing,
    "errors": errors,
    "previous_count": len(current),
    "current_count": len(next_manifest),
    "dry_run": dry_run,
}, sort_keys=True))
'''


@dataclass(slots=True)
class SyncConfig:
    default_host: str | None = None
    mirrored_root: str = "~/research"
    include: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)
    protect: list[str] = field(default_factory=lambda: DEFAULT_PROTECT.copy())
    include_untracked: bool = False
    extra_untracked: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RepoContext:
    repo_root: Path
    repo_rel: PurePosixPath
    host: str
    remote_home: str
    remote_repo: str
    metadata_dir: str
    config: SyncConfig


def fail(message: str, code: int = 2) -> "None":
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_local(cmd: Sequence[str], *, cwd: Path | None = None, check: bool = True, capture_output: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        check=check,
        capture_output=capture_output,
        text=True,
    )


def ssh_base(host: str) -> list[str]:
    return ["ssh", "-o", "BatchMode=yes", host]


def quote_argv(argv: Sequence[str]) -> str:
    return " ".join(shlex.quote(part) for part in argv)


def run_remote_argv(host: str, argv: Sequence[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ssh_base(host) + [quote_argv(argv)],
        check=check,
        capture_output=True,
        text=True,
    )


def run_remote_shell(host: str, shell_script: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run_remote_argv(host, ["bash", "-lc", shell_script], check=check)


def run_remote_python(host: str, script: str, args: Sequence[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    bootstrap = "import base64,sys; payload=sys.argv.pop(1); exec(compile(base64.b64decode(payload).decode(), '<pi-remote-sync>', 'exec'))"
    payload = base64.b64encode(script.encode("utf-8")).decode("ascii")
    return run_remote_argv(host, ["python3", "-c", bootstrap, payload, *args], check=check)


def parse_path_list(raw: str) -> list[str]:
    if not raw:
        return []
    return [item for item in raw.split("\0") if item]


def normalize_relpath(path_str: str) -> str:
    path = PurePosixPath(path_str)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe relative path: {path_str!r}")
    return path.as_posix()


def matches_any(path_str: str, patterns: Sequence[str]) -> bool:
    return any(fnmatch.fnmatchcase(path_str, pattern) for pattern in patterns)


def load_config(repo_root: Path) -> SyncConfig:
    config = SyncConfig()
    path = repo_root / CONFIG_FILENAME
    if not path.exists():
        return config
    with path.open("rb") as handle:
        raw = tomllib.load(handle)
    config.default_host = raw.get("default_host") or None
    config.mirrored_root = raw.get("mirrored_root", config.mirrored_root)
    sync_section = raw.get("sync", {})
    config.include = [str(x) for x in sync_section.get("include", [])]
    config.exclude = [str(x) for x in sync_section.get("exclude", [])]
    protect = sync_section.get("protect")
    if protect is not None:
        config.protect = [str(x) for x in protect]
    config.include_untracked = bool(sync_section.get("include_untracked", config.include_untracked))
    config.extra_untracked = [str(x) for x in sync_section.get("extra_untracked", [])]
    return config


def discover_repo_root() -> Path:
    proc = run_local(["git", "rev-parse", "--show-toplevel"])
    return Path(proc.stdout.strip()).resolve()


def discover_host(config: SyncConfig, cli_host: str | None) -> str:
    if cli_host:
        return cli_host
    if config.default_host:
        return config.default_host
    env_host = os.environ.get("PI_REMOTE_SYNC_HOST", "").strip()
    if env_host:
        return env_host
    fail("missing host. Pass --host, set default_host in .pi-remote-sync.toml, or set PI_REMOTE_SYNC_HOST")


def parse_mirrored_root(raw: str) -> PurePosixPath:
    path = PurePosixPath(raw.replace("~", "", 1).lstrip("/"))
    if ".." in path.parts:
        fail(f"invalid mirrored_root: {raw!r}")
    return path


def build_context(cli_host: str | None) -> RepoContext:
    repo_root = discover_repo_root()
    config = load_config(repo_root)
    host = discover_host(config, cli_host)

    local_research_root = Path.home() / "research"
    try:
        repo_rel = PurePosixPath(repo_root.relative_to(local_research_root).as_posix())
    except ValueError as exc:
        fail(f"repo must live under {local_research_root}: {exc}")

    remote_home = run_remote_shell(host, 'printf "%s\\n" "$HOME"').stdout.strip().splitlines()[-1]
    if not remote_home:
        fail(f"failed to resolve remote home for host {host}")

    mirrored_root = parse_mirrored_root(config.mirrored_root)
    remote_repo = str(PurePosixPath(remote_home).joinpath(mirrored_root, repo_rel))
    metadata_dir = str(PurePosixPath(remote_repo, METADATA_DIRNAME))

    return RepoContext(
        repo_root=repo_root,
        repo_rel=repo_rel,
        host=host,
        remote_home=remote_home,
        remote_repo=remote_repo,
        metadata_dir=metadata_dir,
        config=config,
    )


def ensure_remote_repo_exists(ctx: RepoContext) -> None:
    proc = run_remote_shell(ctx.host, f"test -d {shlex.quote(ctx.remote_repo)}", check=False)
    if proc.returncode != 0:
        fail(f"remote repo path does not exist: {ctx.host}:{ctx.remote_repo}")


def git_tracked_paths(repo_root: Path) -> list[str]:
    proc = run_local(["git", "ls-files", "-z"], cwd=repo_root)
    return parse_path_list(proc.stdout)


def git_untracked_paths(repo_root: Path) -> list[str]:
    proc = run_local(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=repo_root)
    return parse_path_list(proc.stdout)


def build_manifest(ctx: RepoContext, *, include_untracked_override: bool | None = None) -> list[str]:
    include_untracked = ctx.config.include_untracked if include_untracked_override is None else include_untracked_override
    candidates = git_tracked_paths(ctx.repo_root)
    if include_untracked:
        candidates.extend(git_untracked_paths(ctx.repo_root))
    candidates.extend(ctx.config.extra_untracked)

    ordered: list[str] = []
    seen: set[str] = set()
    excludes = DEFAULT_EXCLUDE + ctx.config.exclude
    protect = ctx.config.protect
    includes = ctx.config.include

    for raw in candidates:
        rel = normalize_relpath(raw)
        if rel in seen:
            continue
        seen.add(rel)
        if matches_any(rel, excludes):
            continue
        if matches_any(rel, protect):
            continue
        if includes and not matches_any(rel, includes):
            continue
        local_path = ctx.repo_root / rel
        if not local_path.is_file() and not local_path.is_symlink():
            continue
        ordered.append(rel)
    ordered.sort()
    return ordered


def compute_sync_id(repo_root: Path, manifest: Sequence[str]) -> str:
    digest = hashlib.sha256()
    for rel in manifest:
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        path = repo_root / rel
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()[:16]


def write_manifest_file(temp_dir: Path, manifest: Sequence[str]) -> Path:
    path = temp_dir / "manifest.zlist"
    with path.open("wb") as handle:
        for rel in manifest:
            handle.write(rel.encode("utf-8"))
            handle.write(b"\0")
    return path


def count_rsync_changes(stdout: str) -> tuple[int, list[str]]:
    lines = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped in {"sending incremental file list", "sent", "total size is", "receiving incremental file list"}:
            continue
        lines.append(line)
    return len(lines), lines[:20]


def remote_manifest(ctx: RepoContext) -> set[str]:
    proc = run_remote_shell(
        ctx.host,
        f"if test -f {shlex.quote(ctx.metadata_dir)}/current-manifest.txt; then cat {shlex.quote(ctx.metadata_dir)}/current-manifest.txt; fi",
        check=False,
    )
    out: set[str] = set()
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        out.add(normalize_relpath(line))
    return out


def remote_last_sync(ctx: RepoContext) -> dict[str, object] | None:
    proc = run_remote_shell(
        ctx.host,
        f"if test -f {shlex.quote(ctx.metadata_dir)}/last-sync.json; then cat {shlex.quote(ctx.metadata_dir)}/last-sync.json; fi",
        check=False,
    )
    raw = proc.stdout.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def rsync_manifest(ctx: RepoContext, manifest_file: Path, *, dry_run: bool) -> subprocess.CompletedProcess[str]:
    cmd = [
        "rsync",
        "-a",
        "--itemize-changes",
        "--files-from",
        str(manifest_file),
        "--from0",
    ]
    if dry_run:
        cmd.append("--dry-run")
    cmd.extend([f"{ctx.repo_root}/", f"{ctx.host}:{ctx.remote_repo}/"])
    return run_local(cmd, check=True)


def upload_metadata(ctx: RepoContext, temp_dir: Path) -> None:
    run_remote_shell(ctx.host, f"mkdir -p {shlex.quote(ctx.metadata_dir)}")
    run_local([
        "rsync",
        "-a",
        f"{temp_dir}/",
        f"{ctx.host}:{ctx.metadata_dir}/",
    ])


def finalize_remote_manifest(ctx: RepoContext, *, dry_run: bool) -> dict[str, object]:
    proc = run_remote_python(
        ctx.host,
        REMOTE_FINALIZE_SCRIPT,
        [ctx.remote_repo, METADATA_DIRNAME, json.dumps(ctx.config.protect), "1" if dry_run else "0"],
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        fail("remote finalize step returned no output")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        fail(f"failed to parse remote finalize output: {exc}: {lines[-1]!r}")


def build_status_payload(ctx: RepoContext, manifest: Sequence[str], sync_id: str) -> dict[str, object]:
    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "host": ctx.host,
        "local_repo": str(ctx.repo_root),
        "remote_repo": ctx.remote_repo,
        "repo_rel": ctx.repo_rel.as_posix(),
        "sync_id": sync_id,
        "file_count": len(manifest),
        "include_untracked": ctx.config.include_untracked,
        "protect": ctx.config.protect,
    }


def print_status(payload: dict[str, object]) -> None:
    for key in ["host", "local_repo", "remote_repo", "sync_id", "file_count", "remote_manifest_count", "last_remote_sync_id", "last_remote_sync_ts"]:
        if key in payload:
            print(f"{key}: {payload[key]}")


def cmd_status(args: argparse.Namespace) -> int:
    ctx = build_context(args.host)
    ensure_remote_repo_exists(ctx)
    manifest = build_manifest(ctx, include_untracked_override=args.include_untracked)
    sync_id = compute_sync_id(ctx.repo_root, manifest)
    last_sync = remote_last_sync(ctx) or {}
    payload = {
        "host": ctx.host,
        "local_repo": str(ctx.repo_root),
        "remote_repo": ctx.remote_repo,
        "sync_id": sync_id,
        "file_count": len(manifest),
        "remote_manifest_count": len(remote_manifest(ctx)),
        "last_remote_sync_id": last_sync.get("sync_id", "<none>"),
        "last_remote_sync_ts": last_sync.get("timestamp", "<none>"),
    }
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print_status(payload)
    return 0


def cmd_init_config(args: argparse.Namespace) -> int:
    repo_root = discover_repo_root()
    target = repo_root / CONFIG_FILENAME
    if target.exists() and not args.force:
        fail(f"config already exists: {target}. Use --force to overwrite")

    template_path = Path(__file__).resolve().parent.parent / "templates" / "pi-remote-sync.toml.template"
    if not template_path.exists():
        fail(f"missing template: {template_path}")

    content = template_path.read_text(encoding="utf-8")
    if args.host:
        lines = content.splitlines()
        rewritten: list[str] = []
        replaced = False
        for line in lines:
            if line.startswith("default_host = "):
                rewritten.append(f'default_host = "{args.host}"')
                replaced = True
            else:
                rewritten.append(line)
        if not replaced:
            rewritten.insert(0, f'default_host = "{args.host}"')
        content = "\n".join(rewritten) + "\n"

    target.write_text(content, encoding="utf-8")
    print(f"wrote: {target}")
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    ctx = build_context(args.host)
    ensure_remote_repo_exists(ctx)
    manifest = build_manifest(ctx, include_untracked_override=args.include_untracked)
    if not manifest:
        fail("manifest is empty; refusing to sync nothing")
    sync_id = compute_sync_id(ctx.repo_root, manifest)
    previous_manifest = remote_manifest(ctx)

    with tempfile.TemporaryDirectory(prefix="pi-remote-sync-") as tmp:
        tmp_dir = Path(tmp)
        manifest_file = write_manifest_file(tmp_dir, manifest)
        rsync_proc = rsync_manifest(ctx, manifest_file, dry_run=args.dry_run)
        changed_count, sample_changes = count_rsync_changes(rsync_proc.stdout)
        current_manifest_text = "\n".join(manifest) + "\n"
        metadata_payload = build_status_payload(ctx, manifest, sync_id)
        metadata_payload.update(
            {
                "changed_count": changed_count,
                "previous_manifest_count": len(previous_manifest),
            }
        )

        if args.dry_run:
            stale = sorted(previous_manifest - set(manifest))
            protected = sum(1 for rel in stale if matches_any(rel, ctx.config.protect))
            payload = {
                **metadata_payload,
                "dry_run": True,
                "stale_count": len(stale),
                "protected_stale_count": protected,
                "rsync_sample": sample_changes,
            }
            if args.json:
                print(json.dumps(payload, indent=2, sort_keys=True))
            else:
                print(f"dry_run: true")
                print(f"host: {ctx.host}")
                print(f"local_repo: {ctx.repo_root}")
                print(f"remote_repo: {ctx.remote_repo}")
                print(f"sync_id: {sync_id}")
                print(f"file_count: {len(manifest)}")
                print(f"changed_count: {changed_count}")
                print(f"stale_count: {len(stale)}")
                print(f"protected_stale_count: {protected}")
                if sample_changes:
                    print("sample_changes:")
                    for line in sample_changes:
                        print(f"  {line}")
            return 0

        (tmp_dir / "current-manifest.txt.next").write_text(current_manifest_text, encoding="utf-8")
        (tmp_dir / "last-sync.json.next").write_text(json.dumps(metadata_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        upload_metadata(ctx, tmp_dir)
        finalize = finalize_remote_manifest(ctx, dry_run=False)

    payload = {
        **metadata_payload,
        "removed_count": finalize.get("removed", 0),
        "protected_count": finalize.get("protected", 0),
        "finalize_errors": finalize.get("errors", []),
        "rsync_sample": sample_changes,
    }
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"host: {ctx.host}")
        print(f"local_repo: {ctx.repo_root}")
        print(f"remote_repo: {ctx.remote_repo}")
        print(f"sync_id: {sync_id}")
        print(f"file_count: {len(manifest)}")
        print(f"changed_count: {changed_count}")
        print(f"removed_count: {payload['removed_count']}")
        print(f"protected_count: {payload['protected_count']}")
        if payload["finalize_errors"]:
            print("finalize_errors:")
            for item in payload["finalize_errors"]:
                print(f"  {item}")
    return 0


def build_remote_run_script(remote_repo: str, command_argv: Sequence[str], sync_id: str | None) -> str:
    command = " ".join(shlex.quote(part) for part in command_argv)
    exports = []
    if sync_id:
        exports.append(f"export PI_REMOTE_SYNC_ID={shlex.quote(sync_id)}")
    exports.append(f"cd {shlex.quote(remote_repo)}")
    exports.append(command)
    return " && ".join(exports)


def cmd_run(args: argparse.Namespace) -> int:
    if not args.command:
        fail("run requires a command after --")
    ctx = build_context(args.host)
    ensure_remote_repo_exists(ctx)

    sync_id: str | None = None
    if not args.no_sync:
        manifest = build_manifest(ctx, include_untracked_override=args.include_untracked)
        if not manifest:
            fail("manifest is empty; refusing to sync before run")
        sync_id = compute_sync_id(ctx.repo_root, manifest)
        sync_args = argparse.Namespace(
            host=ctx.host,
            include_untracked=args.include_untracked,
            dry_run=False,
            json=False,
        )
        cmd_sync(sync_args)

    remote_script = build_remote_run_script(ctx.remote_repo, args.command, sync_id)
    proc = run_remote_shell(ctx.host, remote_script, check=False)
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="", file=sys.stderr)
    return proc.returncode


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync local repo logic to a mirrored remote repo path and optionally run a remote command")
    sub = parser.add_subparsers(dest="subcommand", required=True)

    init_cfg = sub.add_parser("init-config", help="write a repo-local .pi-remote-sync.toml from the skill template")
    init_cfg.add_argument("--host", help="set default_host in the generated config")
    init_cfg.add_argument("--force", action="store_true", help="overwrite an existing config file")
    init_cfg.set_defaults(func=cmd_init_config)

    status = sub.add_parser("status", help="show inferred paths and last remote sync metadata")
    status.add_argument("--host", help="SSH host alias, preferably the -pi-agent alias")
    status.add_argument("--include-untracked", action="store_true", help="include local untracked files when building the manifest")
    status.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    status.set_defaults(func=cmd_status)

    sync = sub.add_parser("sync", help="sync the current repo to the mirrored remote path")
    sync.add_argument("--host", help="SSH host alias, preferably the -pi-agent alias")
    sync.add_argument("--include-untracked", action="store_true", help="include local untracked files when building the manifest")
    sync.add_argument("--dry-run", action="store_true", help="show what would change without mutating the remote repo")
    sync.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    sync.set_defaults(func=cmd_sync)

    run = sub.add_parser("run", help="sync, then run a command from the mirrored remote repo path")
    run.add_argument("--host", help="SSH host alias, preferably the -pi-agent alias")
    run.add_argument("--include-untracked", action="store_true", help="include local untracked files when building the manifest")
    run.add_argument("--no-sync", action="store_true", help="skip the sync step and just run remotely")
    run.add_argument("command", nargs=argparse.REMAINDER, help="command to run remotely; pass it after --")
    run.set_defaults(func=cmd_run)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if getattr(args, "command", None) and args.command and args.command[0] == "--":
        args.command = args.command[1:]
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
