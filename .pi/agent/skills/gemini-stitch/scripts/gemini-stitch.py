#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PLACEHOLDER_PATTERNS = [
    re.compile(r"coming soon", re.IGNORECASE),
    re.compile(r"this domain is coming soon", re.IGNORECASE),
    re.compile(r"contribution\.usercontent\.com", re.IGNORECASE),
]


@dataclass(frozen=True)
class Config:
    mode: str
    brief: str
    slug: str
    project_title: str
    reuse_project: bool
    project_id: str | None
    screen_id: str | None
    device: str
    output_dir: Path
    design_file: Path
    model: str
    fallback_models: tuple[str, ...]
    timeout_seconds: int
    attempts: int
    gemini_bin: str

    @property
    def png_path(self) -> Path:
        return self.output_dir / f"{self.slug}.png"

    @property
    def html_path(self) -> Path:
        return self.output_dir / f"{self.slug}.html"

    @property
    def expected_files(self) -> list[str]:
        return [
            self._rel_or_abs(self.png_path),
            self._rel_or_abs(self.html_path),
            self._rel_or_abs(self.design_file),
        ]

    @staticmethod
    def _rel_or_abs(path: Path) -> str:
        try:
            return str(path.relative_to(Path.cwd()))
        except ValueError:
            return str(path)


def slugify(text: str) -> str:
    lowered = text.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
    return slug[:64] or "stitch-screen"


def titleize_slug(slug: str) -> str:
    return " ".join(part.capitalize() for part in slug.split("-") if part) or "Stitch Design"


def parse_args() -> Config:
    parser = argparse.ArgumentParser(description="Run Gemini Stitch headlessly and validate the downloaded artifacts.")
    parser.add_argument("brief", help="UI design brief or targeted edit prompt for Gemini Stitch.")
    parser.add_argument("--mode", choices=["design", "edit"], default="design")
    parser.add_argument("--slug", help="Filename stem for the generated assets.")
    parser.add_argument("--project-title", help="Stitch project title to create or reuse in design mode.")
    parser.add_argument("--reuse-project", action="store_true", help="Reuse an existing Stitch project title if present; otherwise create a new project.")
    parser.add_argument("--project-id", help="Required in edit mode. Existing Stitch project id.")
    parser.add_argument("--screen-id", help="Required in edit mode. Existing Stitch screen id to edit.")
    parser.add_argument("--device", choices=["desktop", "mobile", "tablet"], default="desktop")
    parser.add_argument("--output-dir", default=".stitch/designs")
    parser.add_argument("--design-file", default=".stitch/DESIGN.md")
    parser.add_argument("--model", default="gemini-3-flash-preview")
    parser.add_argument("--fallback-model", action="append", default=[], help="Optional fallback model. May be repeated.")
    parser.add_argument("--timeout", type=int, default=900, dest="timeout_seconds")
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--gemini-bin", default="gemini")
    args = parser.parse_args()

    slug = args.slug or slugify(args.brief)
    project_title = args.project_title or titleize_slug(slug)

    if args.attempts < 1:
        parser.error("--attempts must be >= 1")
    if args.timeout_seconds < 30:
        parser.error("--timeout must be >= 30 seconds")
    if args.mode == "edit":
        if not args.project_id:
            parser.error("--project-id is required in --mode edit")
        if not args.screen_id:
            parser.error("--screen-id is required in --mode edit")
        if args.reuse_project:
            parser.error("--reuse-project is only valid in --mode design")

    return Config(
        mode=args.mode,
        brief=args.brief.strip(),
        slug=slug,
        project_title=project_title,
        reuse_project=args.reuse_project,
        project_id=args.project_id,
        screen_id=args.screen_id,
        device=args.device,
        output_dir=Path(args.output_dir),
        design_file=Path(args.design_file),
        model=args.model,
        fallback_models=tuple(dict.fromkeys(model for model in args.fallback_model if model and model != args.model)),
        timeout_seconds=args.timeout_seconds,
        attempts=args.attempts,
        gemini_bin=args.gemini_bin,
    )


def build_prompt(cfg: Config) -> str:
    device = cfg.device.upper()
    png_path = Config._rel_or_abs(cfg.png_path)
    html_path = Config._rel_or_abs(cfg.html_path)
    design_path = Config._rel_or_abs(cfg.design_file)
    contract = {
        "project": "projects/...",
        "screen": "...",
        "files": [png_path, html_path, design_path],
    }

    if cfg.mode == "edit":
        body = f"""1. Use the existing Stitch project id {json.dumps(cfg.project_id)} and existing screen id {json.dumps(cfg.screen_id)}.
2. Edit that screen with this targeted prompt:
   {json.dumps(cfg.brief)}
3. Use the direct Stitch edit_screens tool with the provided project id and screen id. Do not create a new project. Do not generate a second screen.
4. Immediately call the direct Stitch get_screen tool for that same screen id after editing.
5. From that fetched screen object, use the exact screenshot.downloadUrl and exact htmlCode.downloadUrl values without rewriting the host, path, or query string. Preserve the host exactly, including any `.google.com` suffix when present.
6. Download both assets with a normal shell command using curl -L -o. Write them to:
   - {png_path}
   - {html_path}
7. Validate the HTML download before you finish. It must not be a placeholder page and must look like the generated screen HTML. If validation fails, stop with a clear error instead of pretending success.
8. Write {design_path} with a short reusable design-system summary for the edited screen.
9. Return exactly this JSON and nothing else:
   {json.dumps(contract, separators=(",", ":"))}
"""
    else:
        project_step = (
            f'1. Look for an existing Stitch project titled {json.dumps(cfg.project_title)}. If present, use it. Otherwise create it.'
            if cfg.reuse_project
            else f'1. Create a new Stitch project titled {json.dumps(cfg.project_title)}. Do not search for existing projects.'
        )
        body = f"""{project_step}
2. Generate one {device} screen for that project with this brief:
   {json.dumps(cfg.brief)}
3. From the generate_screen_from_text result, take the exact screen id for the newly generated screen. Immediately call the direct Stitch get_screen tool for that same screen id.
4. From that fetched screen object, use the exact screenshot.downloadUrl and exact htmlCode.downloadUrl values without rewriting the host, path, or query string. Preserve the host exactly, including any `.google.com` suffix when present.
5. Download both assets with a normal shell command using curl -L -o. Write them to:
   - {png_path}
   - {html_path}
6. Validate the HTML download before you finish. It must not be a placeholder page and must look like the generated screen HTML. If validation fails, stop with a clear error instead of pretending success.
7. Write {design_path} with a short reusable design-system summary for the generated screen.
8. Return exactly this JSON and nothing else:
   {json.dumps(contract, separators=(",", ":"))}
"""

    return f"""Use only direct Stitch MCP tools plus normal file or shell tools. Do not delegate to any sub-agent.
Do not use web_fetch, Browse, google_web_search, or any research tool.
Do not call list_screens.
Do not inspect or reuse any older screen unless the request is explicit edit mode.
Do not create a second fallback project or second fallback screen.
If any required step fails, stop and return a clear error instead of improvising.

Do this entire task in one turn:
{body}"""


def run_once(cfg: Config, prompt: str, model: str) -> subprocess.CompletedProcess[str]:
    command = [
        cfg.gemini_bin,
        "-m",
        model,
        "-p",
        prompt,
        "--approval-mode",
        "yolo",
        "--output-format",
        "json",
        "-e",
        "Stitch",
    ]
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=cfg.timeout_seconds,
        check=False,
    )


def parse_outer_output(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    if not text:
        raise ValueError("Gemini returned empty stdout")
    return json.loads(text)


def parse_error_payload(payload: dict[str, Any]) -> str | None:
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    message = error.get("message")
    return message if isinstance(message, str) and message.strip() else json.dumps(error)


def parse_inner_response(payload: dict[str, Any]) -> dict[str, Any]:
    response = payload.get("response")
    if not isinstance(response, str) or not response.strip():
        raise ValueError("Gemini JSON payload did not include a string 'response'")
    inner = json.loads(response)
    if not isinstance(inner, dict):
        raise ValueError("Gemini response JSON was not an object")
    return inner


def validate_contract(cfg: Config, result: dict[str, Any]) -> None:
    project = result.get("project")
    screen = result.get("screen")
    files = result.get("files")

    if not isinstance(project, str) or not project.startswith("projects/"):
        raise ValueError(f"Invalid project field: {project!r}")
    if not isinstance(screen, str) or not screen:
        raise ValueError(f"Invalid screen field: {screen!r}")
    if files != cfg.expected_files:
        raise ValueError(f"Returned files did not match expected paths. Expected {cfg.expected_files!r}, got {files!r}")


def validate_png(path: Path) -> None:
    if not path.exists():
        raise ValueError(f"Missing screenshot: {path}")
    if path.stat().st_size < 10_000:
        raise ValueError(f"Screenshot looks too small to be real: {path} ({path.stat().st_size} bytes)")


def validate_html(path: Path) -> None:
    if not path.exists():
        raise ValueError(f"Missing HTML export: {path}")
    text = path.read_text(encoding="utf-8", errors="ignore")
    lowered = text.lower()
    if path.stat().st_size < 2_000:
        raise ValueError(f"HTML export is suspiciously small: {path} ({path.stat().st_size} bytes)")
    if "<html" not in lowered or "<body" not in lowered:
        raise ValueError(f"HTML export does not look like HTML: {path}")
    if not any(token in lowered for token in ("tailwind", "class=", "font", "bg-", "text-")):
        raise ValueError(f"HTML export does not look like a UI screen export: {path}")
    for pattern in PLACEHOLDER_PATTERNS:
        if pattern.search(text):
            raise ValueError(f"HTML export matched placeholder pattern {pattern.pattern!r}: {path}")


def validate_design_file(path: Path) -> None:
    if not path.exists():
        raise ValueError(f"Missing design summary: {path}")
    if path.stat().st_size < 100:
        raise ValueError(f"Design summary is too small: {path} ({path.stat().st_size} bytes)")


def ensure_parent_dirs(cfg: Config) -> None:
    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    cfg.design_file.parent.mkdir(parents=True, exist_ok=True)


def should_retry(error: Exception | None, completed: subprocess.CompletedProcess[str] | None) -> bool:
    if error is not None:
        message = str(error).lower()
        retry_markers = [
            "service is currently unavailable",
            "backenderror",
            "timed out",
            "empty stdout",
            "could not parse",
            "429",
            "rate limit",
            "rateLimitExceeded".lower(),
            "resource exhausted",
            "resource_exhausted",
            "no capacity available",
        ]
        return any(marker in message for marker in retry_markers)

    if completed is None:
        return False

    stderr = (completed.stderr or "").lower()
    retry_markers = [
        "service is currently unavailable",
        "backenderror",
        "503",
        "timed out",
        "429",
        "rate limit",
        "resource exhausted",
        "resource_exhausted",
        "no capacity available",
    ]
    return any(marker in stderr for marker in retry_markers)


def main() -> int:
    cfg = parse_args()
    ensure_parent_dirs(cfg)
    prompt = build_prompt(cfg)
    models = (cfg.model, *cfg.fallback_models)

    last_error: Exception | None = None
    last_completed: subprocess.CompletedProcess[str] | None = None

    for model in models:
        for attempt in range(1, cfg.attempts + 1):
            try:
                completed = run_once(cfg, prompt, model)
                last_completed = completed
                outer = parse_outer_output(completed.stdout) if completed.stdout.strip() else {}
                error_message = parse_error_payload(outer) if outer else None
                if completed.returncode != 0:
                    if error_message:
                        raise RuntimeError(f"Gemini returned an error payload: {error_message}")
                    raise RuntimeError(
                        f"Gemini exited with code {completed.returncode}. stderr:\n{completed.stderr.strip()}"
                    )
                if error_message:
                    raise RuntimeError(f"Gemini returned an error payload: {error_message}")

                result = parse_inner_response(outer)
                validate_contract(cfg, result)
                validate_png(cfg.png_path)
                validate_html(cfg.html_path)
                validate_design_file(cfg.design_file)

                print(json.dumps(result, ensure_ascii=False))
                return 0
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt >= cfg.attempts or not should_retry(exc, last_completed):
                    break
                time.sleep(min(10 * attempt, 30))

    message = [f"gemini-stitch failed after {cfg.attempts} attempt(s) across {len(models)} model(s)."]
    if last_error is not None:
        message.append(str(last_error))
    if last_completed is not None and last_completed.stderr.strip():
        message.append("Gemini stderr:")
        message.append(last_completed.stderr.strip())
    print("\n\n".join(message), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
