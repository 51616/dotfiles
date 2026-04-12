export const PI_DIFF_REVIEW_SSH_HELPER_PROTOCOL_VERSION = 1 as const;

export const PI_DIFF_REVIEW_SSH_HELPER_PY = String.raw`# pi-diff-review ssh helper
#
# Line-delimited JSON RPC over stdin/stdout.
#
# This helper intentionally exposes a tiny allowlisted surface.
# It is not a general remote shell.

import base64
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple, List

PROTOCOL_VERSION = 1
HELPER_VERSION = "v1"

LOG_PATH = os.path.join(os.path.expanduser("~"), ".pi", "logs", "pi-diff-review-helper.log")
LOG_MAX_BYTES = 1024 * 1024
LOG_KEEP_BYTES = 256 * 1024
_log_f = None
_log_count = 0


def _log(msg: str) -> None:
    global _log_f
    global _log_count

    try:
        if _log_f is None:
            os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
            _log_f = open(LOG_PATH, "a", encoding="utf-8")
    except Exception:
        _log_f = None
        return

    try:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _log_f.write(f"{ts} {msg}\n")
        _log_f.flush()
        _log_count += 1

        # Periodic truncate to keep log from growing unbounded.
        if _log_count % 50 == 0:
            try:
                size = os.path.getsize(LOG_PATH)
                if size > LOG_MAX_BYTES:
                    with open(LOG_PATH, "rb") as f:
                        if size > LOG_KEEP_BYTES:
                            f.seek(-LOG_KEEP_BYTES, os.SEEK_END)
                        tail = f.read().decode("utf-8", errors="replace")
                    with open(LOG_PATH, "w", encoding="utf-8") as f2:
                        f2.write(tail)
            except Exception:
                pass
    except Exception:
        return


def _now_ms() -> int:
    return int(time.time() * 1000)


def _write(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _err(code: str, message: str, details: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "details": details or {},
    }


def _run(argv: List[str], cwd: Optional[str] = None, stdin_bytes: Optional[bytes] = None, allow_failure: bool = False) -> Tuple[int, bytes, bytes]:
    env = os.environ.copy()
    env.setdefault("GIT_PAGER", "cat")
    env.setdefault("PAGER", "cat")
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    # Avoid any interactive credential helpers from hanging the helper.
    env.setdefault("GIT_ASKPASS", "true")
    try:
        p = subprocess.run(
            argv,
            cwd=cwd,
            input=stdin_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        if (not allow_failure) and p.returncode != 0:
            return p.returncode, p.stdout, p.stderr
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, b"", ("command not found: " + argv[0]).encode("utf-8")
    except Exception as e:
        return 1, b"", ("exec failed: " + str(e)).encode("utf-8")


def _split_patch_sections(patch_text: str) -> List[str]:
    text = patch_text.replace("\r\n", "\n").rstrip("\n")
    if not text.strip():
        return []
    lines = text.split("\n")
    sections: List[str] = []
    cur: List[str] = []
    for line in lines:
        if line.startswith("diff --git ") and cur:
            sections.append("\n".join(cur))
            cur = [line]
        else:
            cur.append(line)
    if cur:
        sections.append("\n".join(cur))
    return sections


def _parse_diff_git_paths(section: str) -> Tuple[Optional[str], Optional[str]]:
    first = None
    for line in section.split("\n"):
        if line.startswith("diff --git "):
            first = line
            break
    if not first:
        return None, None
    # diff --git a/foo b/bar
    parts = first.split(" ")
    if len(parts) < 4:
        return None, None
    a = parts[2]
    b = parts[3]
    if a.startswith("a/"):
        a = a[2:]
    if b.startswith("b/"):
        b = b[2:]
    return a or None, b or None


def _synthetic_omitted_patch(old_path: Optional[str], new_path: Optional[str], reason: str, size_bytes: Optional[int] = None) -> str:
    path_for_header = new_path or old_path or "unknown"
    old_line = "--- /dev/null" if old_path is None else f"--- a/{old_path}"
    new_line = "+++ /dev/null" if new_path is None else f"+++ b/{new_path}"
    size = f", size={size_bytes}" if isinstance(size_bytes, int) else ""
    return "\n".join([
        f"diff --git a/{old_path or path_for_header} b/{new_path or path_for_header}",
        old_line,
        new_line,
        f"pi-diff-review: diff omitted (reason={reason}{size})",
    ])


def _git_head(repo_root: str) -> Optional[str]:
    code, out, _errb = _run(["git", "rev-parse", "--verify", "HEAD"], cwd=repo_root, allow_failure=True)
    if code != 0:
        return None
    head = out.decode("utf-8", errors="replace").strip()
    return head or None


def _git_is_untracked(repo_root: str, repo_rel_path: str) -> bool:
    code, out, _errb = _run(["git", "ls-files", "--others", "--exclude-standard", "--", repo_rel_path], cwd=repo_root, allow_failure=True)
    if code != 0:
        return False
    return bool(out.decode("utf-8", errors="replace").strip())


def _git_current_patch_for_path(repo_root: str, repo_rel_path: str) -> str:
    head = _git_head(repo_root)
    if head:
        _c1, out1, _e1 = _run(["git", "diff", "--no-color", "--find-renames", "-M", "--binary", head, "--", repo_rel_path], cwd=repo_root, allow_failure=True)
        _c2, out2, _e2 = _run(["git", "diff", "--cached", "--no-color", "--find-renames", "-M", "--binary", head, "--", repo_rel_path], cwd=repo_root, allow_failure=True)
        joined = (out1 + b"\n" + out2).decode("utf-8", errors="replace").replace("\r\n", "\n").strip()
        if joined:
            return joined
    if _git_is_untracked(repo_root, repo_rel_path):
        _c, out, _e = _run(["git", "diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", repo_rel_path], cwd=repo_root, allow_failure=True)
        return out.decode("utf-8", errors="replace").replace("\r\n", "\n").strip()
    return ""


def _validate_repo_rel_path(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    v = value.strip().replace("\\", "/")
    if not v:
        return None
    if v.startswith("/"):
        return None
    parts = [p for p in v.split("/") if p]
    if not parts:
        return None
    if any(p in (".", "..") for p in parts):
        return None
    if "\x00" in v:
        return None
    return "/".join(parts)


def _ensure_confined_path(repo_root: str, abs_path: str) -> str:
    """Resolve symlinks and ensure the final path remains under repo_root."""
    root_real = os.path.realpath(repo_root)
    path_real = os.path.realpath(abs_path)
    prefix = root_real if root_real.endswith(os.sep) else root_real + os.sep
    if not (path_real == root_real or path_real.startswith(prefix)):
        raise RuntimeError("path escapes repo_root")
    return path_real


def _file_stat(repo_root: str, repo_rel_path: str) -> Dict[str, Any]:
    abs_path = os.path.join(repo_root, repo_rel_path)
    try:
        st = os.stat(abs_path)
    except FileNotFoundError:
        return {"exists": False, "is_file": False}
    except Exception as e:
        return {"exists": True, "is_file": False, "error": str(e)}

    # Fail closed if the path resolves outside the repo via symlinks.
    _ensure_confined_path(repo_root, abs_path)

    return {
        "exists": True,
        "is_file": os.path.isfile(abs_path),
        "size_bytes": int(st.st_size),
        "mtime_ms": int(st.st_mtime * 1000),
    }


def _file_read(repo_root: str, repo_rel_path: str, max_bytes: int) -> Dict[str, Any]:
    abs_path = os.path.join(repo_root, repo_rel_path)
    # Fail closed if the path resolves outside the repo via symlinks.
    _ensure_confined_path(repo_root, abs_path)

    try:
        with open(abs_path, "rb") as f:
            data = f.read(max_bytes + 1)
    except FileNotFoundError:
        return {"exists": False, "bytes_base64": "", "text_base64": "", "truncated": False}
    except Exception as e:
        raise RuntimeError(f"read failed: {e}")

    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]

    b64 = base64.b64encode(data).decode("ascii")
    return {
        "exists": True,
        "bytes_base64": b64,
        # Back-compat with spec naming; content is raw bytes (not validated utf-8).
        "text_base64": b64,
        "truncated": truncated,
        "size_bytes": len(data),
    }


def _git_diff_workspace(repo_root: str, limits: Dict[str, Any]) -> Dict[str, Any]:
    max_patch_bytes_per_file = int(limits.get("max_patch_bytes_per_file") or (512 * 1024))
    max_total_patch_bytes = int(limits.get("max_total_patch_bytes") or (10 * 1024 * 1024))
    max_files = int(limits.get("max_files") or 800)

    head = _git_head(repo_root)

    patch_chunks: List[str] = []
    name_status_chunks: List[str] = []

    if head:
        _c1, out1, _e1 = _run(["git", "diff", "--no-color", "--find-renames", "-M", "--binary", head, "--"], cwd=repo_root, allow_failure=True)
        _c2, out2, _e2 = _run(["git", "diff", "--cached", "--no-color", "--find-renames", "-M", "--binary", head, "--"], cwd=repo_root, allow_failure=True)
        patch_chunks.append(out1.decode("utf-8", errors="replace"))
        patch_chunks.append(out2.decode("utf-8", errors="replace"))

        _n1, ns1, _ne1 = _run(["git", "diff", "--name-status", "--find-renames", "-M", head, "--"], cwd=repo_root, allow_failure=True)
        _n2, ns2, _ne2 = _run(["git", "diff", "--cached", "--name-status", "--find-renames", "-M", head, "--"], cwd=repo_root, allow_failure=True)
        name_status_chunks.append(ns1.decode("utf-8", errors="replace"))
        name_status_chunks.append(ns2.decode("utf-8", errors="replace"))

        _u, untracked_out, _ue = _run(["git", "ls-files", "--others", "--exclude-standard"], cwd=repo_root, allow_failure=True)
        untracked = [line.strip() for line in untracked_out.decode("utf-8", errors="replace").replace("\r\n", "\n").split("\n") if line.strip()]
        for rel in untracked:
            _c, out, _e = _run(["git", "diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", rel], cwd=repo_root, allow_failure=True)
            txt = out.decode("utf-8", errors="replace").strip()
            if txt:
                patch_chunks.append(txt)
            name_status_chunks.append(f"A\t{rel}\n")
    else:
        # Repo without HEAD: treat all workspace files as added.
        _l, ls_out, _le = _run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=repo_root, allow_failure=True)
        paths = [line.strip() for line in ls_out.decode("utf-8", errors="replace").replace("\r\n", "\n").split("\n") if line.strip()]
        for rel in paths[:max_files]:
            _c, out, _e = _run(["git", "diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", rel], cwd=repo_root, allow_failure=True)
            txt = out.decode("utf-8", errors="replace").strip()
            if txt:
                patch_chunks.append(txt)
            name_status_chunks.append(f"A\t{rel}\n")

    patch_text = "\n".join([c.strip() for c in patch_chunks if c and c.strip()]).replace("\r\n", "\n").strip()
    sections = _split_patch_sections(patch_text)

    omitted_paths: Dict[str, Dict[str, Any]] = {}
    out_sections: List[str] = []
    total_bytes = 0
    count = 0

    for section in sections:
        count += 1
        old_path, new_path = _parse_diff_git_paths(section)
        key_path = new_path or old_path or "unknown"
        sec_bytes = len(section.encode("utf-8", errors="replace"))

        if count > max_files:
            omitted_paths[key_path] = {"reason": "total_cap_exceeded", "size_bytes": sec_bytes}
            out = _synthetic_omitted_patch(old_path, new_path, "file_cap", sec_bytes)
        elif sec_bytes > max_patch_bytes_per_file:
            omitted_paths[key_path] = {"reason": "too_large", "size_bytes": sec_bytes}
            out = _synthetic_omitted_patch(old_path, new_path, "too_large", sec_bytes)
        else:
            out = section

        out_len = len(out.encode("utf-8", errors="replace"))
        if total_bytes + out_len > max_total_patch_bytes:
            omitted_paths[key_path] = {"reason": "total_cap_exceeded", "size_bytes": sec_bytes}
            out = _synthetic_omitted_patch(old_path, new_path, "total_cap", sec_bytes)
            out_len = len(out.encode("utf-8", errors="replace"))
            if total_bytes + out_len > max_total_patch_bytes:
                # If we still can't fit even the synthetic stub, stop.
                break

        out_sections.append(out.strip())
        total_bytes += out_len

    trimmed_patch = "\n\n".join([s for s in out_sections if s.strip()]).strip()
    if trimmed_patch:
        trimmed_patch += "\n"

    name_status = "".join(name_status_chunks).replace("\r\n", "\n")

    return {
        "repo_root": repo_root,
        "head": head,
        "patch_text": trimmed_patch,
        "name_status": name_status,
        "omitted_paths": omitted_paths,
        "limits": {
            "max_patch_bytes_per_file": max_patch_bytes_per_file,
            "max_total_patch_bytes": max_total_patch_bytes,
            "max_files": max_files,
        },
    }


def _git_apply_reverse(repo_root: str, patch_text: str, strategy: str) -> Dict[str, Any]:
    patch_bytes = patch_text.replace("\r\n", "\n").encode("utf-8")

    def try_apply(argv: List[str]) -> Tuple[bool, str]:
        c1, o1, e1 = _run(["git", *argv, "--check", "-"], cwd=repo_root, stdin_bytes=patch_bytes, allow_failure=True)
        if c1 != 0:
            return False, (o1 + e1).decode("utf-8", errors="replace").strip()
        c2, o2, e2 = _run(["git", *argv, "-"], cwd=repo_root, stdin_bytes=patch_bytes, allow_failure=True)
        if c2 != 0:
            return False, (o2 + e2).decode("utf-8", errors="replace").strip()
        return True, (o2 + e2).decode("utf-8", errors="replace").strip()

    if strategy not in ("auto", "direct", "3way"):
        strategy = "auto"

    if strategy in ("auto", "direct"):
        ok, out = try_apply(["apply", "-R"])
        if ok:
            return {"ok": True, "strategy_used": "direct", "output": out}
        if strategy == "direct":
            return {"ok": False, "strategy_used": None, "output": out}

    ok3, out3 = try_apply(["apply", "-R", "-3"])
    if ok3:
        return {"ok": True, "strategy_used": "3way", "output": out3}
    return {"ok": False, "strategy_used": None, "output": out3}


def handle(method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if method == "probe":
        return {
            "protocol_version": PROTOCOL_VERSION,
            "helper_version": HELPER_VERSION,
            "capabilities": [
                "repo.root",
                "git.diff_workspace",
                "git.apply_reverse",
                "git.patch_for_path",
                "file.stat",
                "file.read",
            ],
            "remote_home": os.path.expanduser("~"),
            "remote_cwd": os.getcwd(),
        }

    if method == "repo.root":
        cwd = params.get("cwd")
        if not isinstance(cwd, str) or not cwd.strip():
            cwd = os.getcwd()
        code, out, errb = _run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], allow_failure=True)
        if code != 0:
            raise RuntimeError("Not inside a git repository.")
        return {"repo_root": out.decode("utf-8", errors="replace").strip()}

    if method == "git.diff_workspace":
        repo_root = params.get("repo_root")
        if not isinstance(repo_root, str) or not repo_root.strip():
            raise RuntimeError("Missing repo_root")
        limits = params.get("limits") or {}
        if not isinstance(limits, dict):
            limits = {}
        return _git_diff_workspace(repo_root, limits)

    if method == "git.apply_reverse":
        repo_root = params.get("repo_root")
        patch_text = params.get("patch_text")
        strategy = params.get("strategy") or "auto"
        if not isinstance(repo_root, str) or not repo_root.strip():
            raise RuntimeError("Missing repo_root")
        if not isinstance(patch_text, str):
            raise RuntimeError("Missing patch_text")
        return _git_apply_reverse(repo_root, patch_text, str(strategy))

    if method == "git.patch_for_path":
        repo_root = params.get("repo_root")
        repo_rel = _validate_repo_rel_path(params.get("repo_rel_path"))
        if not isinstance(repo_root, str) or not repo_root.strip():
            raise RuntimeError("Missing repo_root")
        if not repo_rel:
            raise RuntimeError("Invalid repo_rel_path")
        return {"patch_text": _git_current_patch_for_path(repo_root, repo_rel)}

    if method == "file.stat":
        repo_root = params.get("repo_root")
        repo_rel = _validate_repo_rel_path(params.get("repo_rel_path"))
        if not isinstance(repo_root, str) or not repo_root.strip():
            raise RuntimeError("Missing repo_root")
        if not repo_rel:
            raise RuntimeError("Invalid repo_rel_path")
        return _file_stat(repo_root, repo_rel)

    if method == "file.read":
        repo_root = params.get("repo_root")
        repo_rel = _validate_repo_rel_path(params.get("repo_rel_path"))
        max_bytes = params.get("max_bytes")
        if not isinstance(repo_root, str) or not repo_root.strip():
            raise RuntimeError("Missing repo_root")
        if not repo_rel:
            raise RuntimeError("Invalid repo_rel_path")
        if not isinstance(max_bytes, int) or max_bytes <= 0:
            max_bytes = 1024 * 1024
        return _file_read(repo_root, repo_rel, max_bytes)

    raise RuntimeError("Unknown method")


def main() -> None:
    _log("helper_start")
    for line in sys.stdin:
        started = _now_ms()
        raw = line.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:
            _log(f"parse_error err={e}")
            _write({"id": None, "ok": False, "error": _err("parse_error", str(e))})
            continue

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        if not isinstance(method, str):
            _log(f"bad_request id={req_id} missing_method")
            _write({"id": req_id, "ok": False, "error": _err("bad_request", "missing method")})
            continue
        if not isinstance(params, dict):
            params = {}

        _log(f"req id={req_id} method={method}")
        try:
            result = handle(method, params)
            elapsed = _now_ms() - started
            _log(f"res id={req_id} method={method} ok=1 ms={elapsed}")
            _write({"id": req_id, "ok": True, "result": result})
        except Exception as e:
            elapsed = _now_ms() - started
            _log(f"res id={req_id} method={method} ok=0 ms={elapsed} err={e}")
            _write({"id": req_id, "ok": False, "error": _err("request_failed", str(e))})


if __name__ == "__main__":
    main()
`;
