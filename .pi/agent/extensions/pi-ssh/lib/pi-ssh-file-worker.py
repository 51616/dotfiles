#!/usr/bin/env python3
"""Persistent, dependency-free remote filesystem worker for pi-ssh."""

# @lat: [[extensions#Persistent SSH file worker]]

from __future__ import annotations

import difflib
import json
import os
import re
import stat
import struct
import sys
import tempfile
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, BinaryIO

PROTOCOL_VERSION = 1
MAX_HEADER_BYTES = 8 * 1024 * 1024
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
MAX_READ_SOURCE_BYTES = 512 * 1024 * 1024
MAX_DIFF_BYTES = 256 * 1024
DEFAULT_MAX_LINES = 2_000
DEFAULT_MAX_BYTES = 50 * 1024
MAX_WORKERS = 4

STDIN: BinaryIO = sys.stdin.buffer
STDOUT: BinaryIO = sys.stdout.buffer
WRITE_LOCK = threading.Lock()
PATH_LOCKS_LOCK = threading.Lock()
PATH_LOCKS: dict[str, threading.Lock] = {}


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class OperationResult:
    metadata: dict[str, Any]
    payload: bytes = b""
    bytes_read: int = 0
    bytes_written: int = 0


def log_event(event: str, **details: Any) -> None:
    record = {"event": event, **details}
    print(
        "[pi-ssh-file-worker] " + json.dumps(record, separators=(",", ":"), ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )


def read_exact(stream: BinaryIO, length: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            if not chunks:
                return None
            raise WorkerError("protocol_eof", f"Unexpected EOF with {remaining} frame bytes remaining")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def bounded_length(value: Any, name: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise WorkerError("protocol_invalid", f"Invalid {name}")
    if value > maximum:
        raise WorkerError("protocol_oversized", f"{name} {value} exceeds limit {maximum}")
    return value


def encode_header(header: dict[str, Any], payload: bytes) -> bytes:
    complete = {**header, "payloadLength": len(payload)}
    encoded = json.dumps(complete, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_HEADER_BYTES:
        raise WorkerError("response_header_oversized", f"Response header exceeds {MAX_HEADER_BYTES} bytes")
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise WorkerError("response_payload_oversized", f"Response payload exceeds {MAX_PAYLOAD_BYTES} bytes")
    return struct.pack(">I", len(encoded)) + encoded + payload


def send_frame(header: dict[str, Any], payload: bytes = b"") -> None:
    frame = encode_header(header, payload)
    with WRITE_LOCK:
        STDOUT.write(frame)
        STDOUT.flush()


def send_response(request_id: int, result: OperationResult) -> None:
    send_frame(
        {
            "version": PROTOCOL_VERSION,
            "kind": "response",
            "id": request_id,
            "ok": True,
            **result.metadata,
        },
        result.payload,
    )


def send_error(request_id: int, error: WorkerError) -> None:
    send_frame(
        {
            "version": PROTOCOL_VERSION,
            "kind": "response",
            "id": request_id,
            "ok": False,
            "error": {"code": error.code, "message": str(error)},
        }
    )


def require_string(header: dict[str, Any], name: str) -> str:
    value = header.get(name)
    if not isinstance(value, str) or not value:
        raise WorkerError("invalid_request", f"{name} must be a non-empty string")
    return value


def require_absolute_path(header: dict[str, Any]) -> str:
    path = require_string(header, "path")
    if not os.path.isabs(path):
        raise WorkerError("invalid_path", f"Remote file path must be absolute: {path}")
    return os.path.normpath(path)


def optional_positive_integer(header: dict[str, Any], name: str) -> int | None:
    value = header.get(name)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise WorkerError("invalid_request", f"{name} must be a positive integer")
    return value


def read_file_bytes(path: str) -> bytes:
    descriptor: int | None = None
    try:
        # Open once with O_NONBLOCK, then validate that exact descriptor. A
        # pathname stat followed by open is racy and can block on a swapped FIFO.
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise WorkerError("not_file", f"Not a regular file: {path}")
        if info.st_size > MAX_READ_SOURCE_BYTES:
            raise WorkerError(
                "source_too_large",
                f"File is {info.st_size} bytes; remote read limit is {MAX_READ_SOURCE_BYTES} bytes: {path}",
            )
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            content = handle.read(MAX_READ_SOURCE_BYTES + 1)
        if len(content) > MAX_READ_SOURCE_BYTES:
            raise WorkerError(
                "source_too_large",
                f"File grew beyond remote read limit {MAX_READ_SOURCE_BYTES} bytes: {path}",
            )
        return content
    except WorkerError:
        raise
    except FileNotFoundError as error:
        raise WorkerError("not_found", f"File not found: {path}") from error
    except PermissionError as error:
        raise WorkerError("permission_denied", f"File is not readable: {path}") from error
    except IsADirectoryError as error:
        raise WorkerError("not_file", f"Not a regular file: {path}") from error
    except OSError as error:
        raise WorkerError("read_failed", f"Could not read {path}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def detect_image_mime(content: bytes) -> str | None:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def utf8_length(value: str) -> int:
    return len(value.encode("utf-8"))


def truncate_head(content: str, max_lines: int, max_bytes: int) -> dict[str, Any]:
    total_bytes = utf8_length(content)
    lines = content.split("\n")
    total_lines = len(lines)
    base = {
        "totalLines": total_lines,
        "totalBytes": total_bytes,
        "lastLinePartial": False,
        "maxLines": max_lines,
        "maxBytes": max_bytes,
    }
    if total_lines <= max_lines and total_bytes <= max_bytes:
        return {
            **base,
            "content": content,
            "truncated": False,
            "truncatedBy": None,
            "outputLines": total_lines,
            "outputBytes": total_bytes,
            "firstLineExceedsLimit": False,
        }

    first_line_bytes = utf8_length(lines[0])
    if first_line_bytes > max_bytes:
        return {
            **base,
            "content": "",
            "truncated": True,
            "truncatedBy": "bytes",
            "outputLines": 0,
            "outputBytes": 0,
            "firstLineExceedsLimit": True,
        }

    output_lines: list[str] = []
    output_bytes = 0
    truncated_by = "lines"
    for index, line in enumerate(lines[:max_lines]):
        line_bytes = utf8_length(line) + (1 if index > 0 else 0)
        if output_bytes + line_bytes > max_bytes:
            truncated_by = "bytes"
            break
        output_lines.append(line)
        output_bytes += line_bytes
    if len(output_lines) >= max_lines and output_bytes <= max_bytes:
        truncated_by = "lines"
    output = "\n".join(output_lines)
    return {
        **base,
        "content": output,
        "truncated": True,
        "truncatedBy": truncated_by,
        "outputLines": len(output_lines),
        "outputBytes": utf8_length(output),
        "firstLineExceedsLimit": False,
    }


def operation_read_workspace(header: dict[str, Any]) -> OperationResult:
    path = require_absolute_path(header)
    offset = optional_positive_integer(header, "offset")
    limit = optional_positive_integer(header, "limit")
    max_lines = optional_positive_integer(header, "maxLines") or DEFAULT_MAX_LINES
    max_bytes = optional_positive_integer(header, "maxBytes") or DEFAULT_MAX_BYTES
    content = read_file_bytes(path)
    mime = detect_image_mime(content)
    if mime:
        return OperationResult(
            metadata={"fileKind": "image", "mimeType": mime, "sourceBytes": len(content)},
            payload=content,
            bytes_read=len(content),
        )

    text = content.decode("utf-8", errors="replace")
    all_lines = text.split("\n")
    start = (offset - 1) if offset is not None else 0
    if start >= len(all_lines):
        raise WorkerError(
            "offset_out_of_bounds",
            f"Offset {offset} is beyond end of file ({len(all_lines)} lines total)",
        )
    if limit is None:
        selected_lines = all_lines[start:]
        user_limited_lines: int | None = None
    else:
        end = min(start + limit, len(all_lines))
        selected_lines = all_lines[start:end]
        user_limited_lines = end - start
    selected = "\n".join(selected_lines)
    truncation = truncate_head(selected, max_lines, max_bytes)
    output = truncation.pop("content")
    has_more_after_user_limit = (
        user_limited_lines is not None and start + user_limited_lines < len(all_lines)
    )
    return OperationResult(
        metadata={
            "fileKind": "text",
            "sourceBytes": len(content),
            "totalFileLines": len(all_lines),
            "startLineDisplay": start + 1,
            "userLimitedLines": user_limited_lines,
            "hasMoreAfterUserLimit": has_more_after_user_limit,
            "firstLineBytes": utf8_length(all_lines[start]),
            "truncation": truncation,
        },
        payload=output.encode("utf-8"),
        bytes_read=len(content),
    )


def path_lock(path: str) -> threading.Lock:
    key = os.path.realpath(path)
    with PATH_LOCKS_LOCK:
        lock = PATH_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            PATH_LOCKS[key] = lock
        return lock


def write_file_bytes(path: str, payload: bytes) -> None:
    parent = os.path.dirname(path) or "/"
    descriptor: int | None = None
    try:
        os.makedirs(parent, exist_ok=True)
        try:
            existing = os.stat(path)
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise WorkerError("not_file", f"Cannot overwrite non-regular file: {path}")

        # O_NONBLOCK prevents a path swapped to a FIFO from consuming one of the
        # worker's finite executor threads. Validate the opened descriptor too,
        # so the pathname check above is not a security or correctness boundary.
        flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(path, flags, 0o666)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise WorkerError("not_file", f"Cannot overwrite non-regular file: {path}")
        os.ftruncate(descriptor, 0)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(payload)
    except WorkerError:
        raise
    except PermissionError as error:
        raise WorkerError("permission_denied", f"File is not writable: {path}") from error
    except IsADirectoryError as error:
        raise WorkerError("not_file", f"Cannot overwrite directory: {path}") from error
    except OSError as error:
        raise WorkerError("write_failed", f"Could not write {path}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def operation_read_file(header: dict[str, Any]) -> OperationResult:
    path = require_absolute_path(header)
    content = read_file_bytes(path)
    if len(content) > MAX_PAYLOAD_BYTES:
        raise WorkerError("response_payload_oversized", f"File exceeds transfer limit {MAX_PAYLOAD_BYTES}: {path}")
    return OperationResult(
        metadata={"fileKind": "binary", "sourceBytes": len(content)},
        payload=content,
        bytes_read=len(content),
    )


def operation_write_file(header: dict[str, Any], payload: bytes) -> OperationResult:
    path = require_absolute_path(header)
    with path_lock(path):
        write_file_bytes(path, payload)
    return OperationResult(metadata={"writtenBytes": len(payload)}, bytes_written=len(payload))


def normalize_to_lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def detect_line_ending(text: str) -> str:
    crlf_count = text.count("\r\n")
    lf_count = text.count("\n") - crlf_count
    lone_cr_count = text.count("\r") - crlf_count
    lf_style_count = lf_count + lone_cr_count
    if crlf_count > lf_style_count:
        return "\r\n"
    if lf_style_count > crlf_count:
        return "\n"
    index = 0
    while index < len(text):
        if text[index] == "\r":
            return "\r\n" if index + 1 < len(text) and text[index + 1] == "\n" else "\n"
        if text[index] == "\n":
            return "\n"
        index += 1
    return "\n"


def restore_line_endings(text: str, ending: str) -> str:
    return text.replace("\n", "\r\n") if ending == "\r\n" else text


SMART_SINGLE = re.compile("[\u2018\u2019\u201a\u201b]")
SMART_DOUBLE = re.compile("[\u201c\u201d\u201e\u201f]")
UNICODE_DASH = re.compile("[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]")
UNICODE_SPACE = re.compile("[\u00a0\u2002-\u200a\u202f\u205f\u3000]")


def normalize_for_fuzzy_match(text: str) -> str:
    value = unicodedata.normalize("NFKC", text)
    value = "\n".join(line.rstrip() for line in value.split("\n"))
    value = SMART_SINGLE.sub("'", value)
    value = SMART_DOUBLE.sub('"', value)
    value = UNICODE_DASH.sub("-", value)
    return UNICODE_SPACE.sub(" ", value)


def fuzzy_find(content: str, old_text: str) -> tuple[bool, int, int, bool]:
    exact_index = content.find(old_text)
    if exact_index != -1:
        return True, exact_index, len(old_text), False
    fuzzy_content = normalize_for_fuzzy_match(content)
    fuzzy_old = normalize_for_fuzzy_match(old_text)
    fuzzy_index = fuzzy_content.find(fuzzy_old)
    if fuzzy_index == -1:
        return False, -1, 0, False
    return True, fuzzy_index, len(fuzzy_old), True


def edit_error(kind: str, path: str, index: int, total: int, occurrences: int = 0) -> WorkerError:
    if kind == "empty":
        message = f"oldText must not be empty in {path}." if total == 1 else f"edits[{index}].oldText must not be empty in {path}."
    elif kind == "missing":
        message = (
            f"Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines."
            if total == 1
            else f"Could not find edits[{index}] in {path}. The oldText must match exactly including all whitespace and newlines."
        )
    else:
        message = (
            f"Found {occurrences} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique."
            if total == 1
            else f"Found {occurrences} occurrences of edits[{index}] in {path}. Each oldText must be unique. Please provide more context to make it unique."
        )
    return WorkerError(f"edit_{kind}", message)


def apply_edits(content: str, raw_edits: Any, display_path: str) -> tuple[str, str]:
    if not isinstance(raw_edits, list) or not raw_edits:
        raise WorkerError("edit_invalid", "Edit tool input is invalid. edits must contain at least one replacement.")
    edits: list[tuple[str, str]] = []
    for index, raw in enumerate(raw_edits):
        if not isinstance(raw, dict) or not isinstance(raw.get("oldText"), str) or not isinstance(raw.get("newText"), str):
            raise WorkerError("edit_invalid", f"edits[{index}] must contain string oldText and newText")
        old_text = normalize_to_lf(raw["oldText"])
        new_text = normalize_to_lf(raw["newText"])
        if not old_text:
            raise edit_error("empty", display_path, index, len(raw_edits))
        edits.append((old_text, new_text))

    initial = [fuzzy_find(content, old_text) for old_text, _ in edits]
    base = normalize_for_fuzzy_match(content) if any(match[3] for match in initial) else content
    matched: list[tuple[int, int, int, str]] = []
    for index, (old_text, new_text) in enumerate(edits):
        found, match_index, match_length, _ = fuzzy_find(base, old_text)
        if not found:
            raise edit_error("missing", display_path, index, len(edits))
        occurrences = normalize_for_fuzzy_match(base).count(normalize_for_fuzzy_match(old_text))
        if occurrences > 1:
            raise edit_error("duplicate", display_path, index, len(edits), occurrences)
        matched.append((match_index, match_length, index, new_text))

    matched.sort(key=lambda item: item[0])
    for previous, current in zip(matched, matched[1:]):
        if previous[0] + previous[1] > current[0]:
            raise WorkerError(
                "edit_overlap",
                f"edits[{previous[2]}] and edits[{current[2]}] overlap in {display_path}. Merge them into one edit or target disjoint regions.",
            )

    updated = base
    for match_index, match_length, _, new_text in reversed(matched):
        updated = updated[:match_index] + new_text + updated[match_index + match_length :]
    if updated == base:
        message = (
            f"No changes made to {display_path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected."
            if len(edits) == 1
            else f"No changes made to {display_path}. The replacements produced identical content."
        )
        raise WorkerError("edit_no_change", message)
    return base, updated


def generate_diff(old: str, new: str, context: int = 4) -> tuple[str, int | None, bool]:
    old_lines = old.split("\n")
    new_lines = new.split("\n")
    # autojunk avoids quadratic behavior on large source files with many repeated
    # lines (generated data, lockfiles, logs) while preserving useful edit context.
    opcodes = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=True).get_opcodes()
    width = len(str(max(len(old_lines), len(new_lines))))
    output: list[str] = []
    first_changed: int | None = None

    for opcode_index, (tag, old_start, old_end, new_start, new_end) in enumerate(opcodes):
        if tag != "equal":
            if first_changed is None:
                first_changed = new_start + 1
            if tag in ("replace", "delete"):
                for line_index in range(old_start, old_end):
                    output.append(f"-{str(line_index + 1).rjust(width)} {old_lines[line_index]}")
            if tag in ("replace", "insert"):
                for line_index in range(new_start, new_end):
                    output.append(f"+{str(line_index + 1).rjust(width)} {new_lines[line_index]}")
            continue

        previous_change = opcode_index > 0 and opcodes[opcode_index - 1][0] != "equal"
        next_change = opcode_index + 1 < len(opcodes) and opcodes[opcode_index + 1][0] != "equal"
        equal_count = old_end - old_start
        if previous_change and next_change and equal_count <= context * 2:
            indexes = list(range(equal_count))
        elif previous_change and next_change:
            indexes = list(range(context)) + list(range(equal_count - context, equal_count))
        elif previous_change:
            indexes = list(range(min(context, equal_count)))
        elif next_change:
            indexes = list(range(max(0, equal_count - context), equal_count))
        else:
            indexes = []

        last_relative: int | None = None
        for relative in indexes:
            if last_relative is not None and relative > last_relative + 1:
                output.append(f" {' ' * width} ...")
            line_index = old_start + relative
            output.append(f" {str(line_index + 1).rjust(width)} {old_lines[line_index]}")
            last_relative = relative
        if indexes and indexes[-1] < equal_count - 1 and previous_change and not next_change:
            output.append(f" {' ' * width} ...")
        if indexes and indexes[0] > 0 and next_change and not previous_change:
            output.insert(max(0, len(output) - len(indexes)), f" {' ' * width} ...")

    encoded = "\n".join(output).encode("utf-8")
    if len(encoded) <= MAX_DIFF_BYTES:
        return encoded.decode("utf-8"), first_changed, False
    clipped = encoded[: MAX_DIFF_BYTES - 64]
    while clipped and (clipped[-1] & 0xC0) == 0x80:
        clipped = clipped[:-1]
    return clipped.decode("utf-8", errors="ignore") + "\n ... [diff truncated]", first_changed, True


def atomic_replace_existing(path: str, payload: bytes) -> None:
    destination = os.path.realpath(path) if os.path.islink(path) else path
    parent = os.path.dirname(destination) or "/"
    try:
        existing = os.stat(destination)
        descriptor, temporary = tempfile.mkstemp(prefix=".pi-ssh-edit-", dir=parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, stat.S_IMODE(existing.st_mode))
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    except PermissionError as error:
        raise WorkerError("permission_denied", f"File is not writable: {path}") from error
    except OSError as error:
        raise WorkerError("edit_write_failed", f"Could not write edited file {path}: {error}") from error


def operation_edit_workspace(header: dict[str, Any]) -> OperationResult:
    path = require_absolute_path(header)
    display_path = header.get("displayPath") if isinstance(header.get("displayPath"), str) else path
    with path_lock(path):
        if not os.access(path, os.R_OK | os.W_OK):
            if not os.path.exists(path):
                raise WorkerError("not_found", f"File not found: {display_path}")
            raise WorkerError("permission_denied", f"File is not readable and writable: {display_path}")
        raw = read_file_bytes(path)
        decoded = raw.decode("utf-8", errors="replace")
        bom = "\ufeff" if decoded.startswith("\ufeff") else ""
        text = decoded[1:] if bom else decoded
        ending = detect_line_ending(text)
        normalized = normalize_to_lf(text)
        base, updated = apply_edits(normalized, header.get("edits"), display_path)
        final = (bom + restore_line_endings(updated, ending)).encode("utf-8")
        diff, first_changed, diff_truncated = generate_diff(base, updated)
        atomic_replace_existing(path, final)
    return OperationResult(
        metadata={
            "diff": diff,
            "firstChangedLine": first_changed,
            "diffTruncated": diff_truncated,
            "sourceBytes": len(raw),
            "writtenBytes": len(final),
        },
        bytes_read=len(raw),
        bytes_written=len(final),
    )


OPERATIONS = {
    "read_workspace": lambda header, _payload: operation_read_workspace(header),
    "read_file": lambda header, _payload: operation_read_file(header),
    "write_file": operation_write_file,
    "edit_workspace": lambda header, _payload: operation_edit_workspace(header),
}


def process_request(header: dict[str, Any], payload: bytes) -> None:
    request_id = header["id"]
    operation = header["operation"]
    started = time.perf_counter()
    status = "ok"
    bytes_read = 0
    bytes_written = 0
    response_bytes = 0
    try:
        handler = OPERATIONS.get(operation)
        if handler is None:
            raise WorkerError("unknown_operation", f"Unknown SSH file worker operation: {operation}")
        if operation != "write_file" and payload:
            raise WorkerError("unexpected_payload", f"{operation} request must not contain a payload")
        result = handler(header, payload)
        bytes_read = result.bytes_read
        bytes_written = result.bytes_written
        response_bytes = len(result.payload)
        send_response(request_id, result)
    except WorkerError as error:
        status = error.code
        send_error(request_id, error)
    except Exception as error:  # fail request without killing unrelated in-flight work
        status = "internal_error"
        send_error(request_id, WorkerError("internal_error", f"Remote file worker failed: {error}"))
    finally:
        log_event(
            "request.complete",
            id=request_id,
            operation=operation,
            path=header.get("path"),
            status=status,
            durationMs=round((time.perf_counter() - started) * 1000, 3),
            requestPayloadBytes=len(payload),
            responsePayloadBytes=response_bytes,
            filesystemBytesRead=bytes_read,
            filesystemBytesWritten=bytes_written,
        )


def parse_request(header_bytes: bytes, payload: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(header_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkerError("protocol_json", f"Invalid request header JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise WorkerError("protocol_invalid", "Request header must be an object")
    if parsed.get("version") != PROTOCOL_VERSION:
        raise WorkerError(
            "protocol_version",
            f"Protocol version mismatch: expected {PROTOCOL_VERSION}, got {parsed.get('version')}",
        )
    if parsed.get("kind") != "request":
        raise WorkerError("protocol_invalid", "Frame kind must be request")
    request_id = parsed.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, int) or request_id < 1:
        raise WorkerError("protocol_invalid", "Request id must be a positive integer")
    operation = parsed.get("operation")
    if not isinstance(operation, str) or not operation:
        raise WorkerError("protocol_invalid", "Request operation must be a non-empty string")
    expected_payload = bounded_length(parsed.get("payloadLength"), "request payload length", MAX_PAYLOAD_BYTES)
    if expected_payload != len(payload):
        raise WorkerError("protocol_invalid", "Request payload length mismatch")
    return parsed


def main() -> int:
    send_frame(
        {
            "version": PROTOCOL_VERSION,
            "kind": "hello",
            "id": 0,
            "ok": True,
            "capabilities": sorted(OPERATIONS),
        }
    )
    log_event("worker.ready", version=PROTOCOL_VERSION, pid=os.getpid(), maxWorkers=MAX_WORKERS)
    executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="pi-ssh-file")
    try:
        while True:
            prefix = read_exact(STDIN, 4)
            if prefix is None:
                break
            header_length = bounded_length(struct.unpack(">I", prefix)[0], "request header length", MAX_HEADER_BYTES)
            if header_length < 2:
                raise WorkerError("protocol_invalid", "Request header is too short")
            header_bytes = read_exact(STDIN, header_length)
            if header_bytes is None:
                raise WorkerError("protocol_eof", "EOF while reading request header")
            preliminary = json.loads(header_bytes.decode("utf-8"))
            if not isinstance(preliminary, dict):
                raise WorkerError("protocol_invalid", "Request header must be an object")
            payload_length = bounded_length(preliminary.get("payloadLength"), "request payload length", MAX_PAYLOAD_BYTES)
            payload = read_exact(STDIN, payload_length)
            if payload is None:
                raise WorkerError("protocol_eof", "EOF while reading request payload")
            request = parse_request(header_bytes, payload)
            executor.submit(process_request, request, payload)
    except WorkerError as error:
        log_event("worker.fatal", code=error.code, message=str(error))
        return 2
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        log_event("worker.fatal", code="protocol_json", message=str(error))
        return 2
    finally:
        executor.shutdown(wait=True, cancel_futures=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
