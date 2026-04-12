from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

PRUNE_DIRS = {
    '.git',
    '.obsidian',
    '.pi/git',
    'node_modules',
    'dist',
    'build',
    '.cache',
    '.venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.idea',
    '.vscode',
    '.cursor',
    '.claude',
    '.codex',
    '.opencode',
    '.pi/extensions.bak',
}
SOURCE_EXTENSIONS = {
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
    '.py', '.rs', '.go', '.c', '.h', '.cpp', '.cc', '.hpp',
    '.java', '.kt', '.swift', '.scala', '.rb', '.php', '.sh', '.bash', '.zsh',
}
CODE_REF_RE = re.compile(r'(?:^|\s)(?://|#)\s*@lat:\s*\[\[([^\]]+)\]\]')
WIKI_RE = re.compile(r'\[\[([^\]|]+)(?:\|([^\]]+))?\]\]')
HEADING_RE = re.compile(r'^(#{1,6})\s+(.*?)\s*$')
FENCE_RE = re.compile(r'^\s*(```+|~~~+)')
FRONTMATTER_TRUE_RE = re.compile(r'require-code-mention:\s*true', re.IGNORECASE)


@dataclass(slots=True)
class Section:
    id: str
    heading: str
    depth: int
    file: str
    file_path: str
    owner_root: str
    start_line: int
    end_line: int
    first_paragraph: str
    children: list['Section'] = field(default_factory=list)


@dataclass(slots=True)
class WikiRef:
    target: str
    from_section: str
    file: str
    line: int


@dataclass(slots=True)
class CodeRef:
    target: str
    file: str
    line: int


@dataclass(slots=True)
class SectionMatch:
    section: Section
    reason: str


@dataclass(slots=True)
class ResolveResult:
    resolved: str
    ambiguous: list[str] | None
    suggested: str | None


@dataclass(slots=True)
class Context:
    owner_root: Path
    repo_root: Path
    lattice_dir: Path
    local_files: list[Path]
    local_sections: list[Section]
    local_section_ids: set[str]
    local_file_index: dict[str, list[str]]
    local_lookup: dict[str, Section]
    all_sections: list[Section]
    section_ids: set[str]
    file_index: dict[str, list[str]]
    section_lookup: dict[str, Section]


class LatError(RuntimeError):
    pass


def rel(path: Path, base: Path) -> str:
    return '.' if path == base else path.relative_to(base).as_posix()


def strip_wiki(text: str) -> str:
    if text.startswith('[[') and text.endswith(']]'):
        text = text[2:-2]
    target, _sep, _alias = text.partition('|')
    return target.strip()


def format_wiki_ref(target: str, alias: str | None = None) -> str:
    if alias:
        return f'[[{target}|{alias}]]'
    return f'[[{target}]]'


def full_end_line(section: Section) -> int:
    return full_end_line(section.children[-1]) if section.children else section.end_line


def find_repo_root(start: Path) -> Path:
    try:
        out = subprocess.run(
            ['git', '-C', str(start), 'rev-parse', '--show-toplevel'],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(out.stdout.strip()).resolve()
    except Exception:
        current = start.resolve()
        best = current
        while True:
            if (current / 'lat-md').is_dir():
                best = current
            parent = current.parent
            if parent == current:
                return best
            current = parent


def list_lattice_dirs(repo_root: Path) -> list[Path]:
    results: list[Path] = []
    for current, dirs, _files in os.walk(repo_root):
        rel_current = Path(current).resolve().relative_to(repo_root)
        rel_text = '' if str(rel_current) == '.' else rel_current.as_posix()
        pruned: list[str] = []
        for name in list(dirs):
            child_rel = f'{rel_text}/{name}'.strip('/')
            child_path = Path(current) / name
            if child_rel in PRUNE_DIRS or name in PRUNE_DIRS:
                pruned.append(name)
                continue
            if child_path.is_symlink():
                try:
                    child_path.resolve().relative_to(repo_root)
                except ValueError:
                    pruned.append(name)
        for name in pruned:
            dirs.remove(name)
        if 'lat-md' in dirs:
            results.append((Path(current) / 'lat-md').resolve())
    return sorted(results)


def list_lattice_files(lattice_dir: Path) -> list[Path]:
    files: list[Path] = []
    for current, dirs, filenames in os.walk(lattice_dir):
        dirs[:] = sorted(dirs)
        for name in sorted(filenames):
            if name.endswith('.md'):
                files.append((Path(current) / name).resolve())
    return sorted(files)


def lattice_file_id(repo_root: Path, file_path: Path) -> str:
    rel_path = file_path.resolve().relative_to(repo_root).as_posix()
    stem = rel_path[len('lat-md/'):] if rel_path.startswith('lat-md/') else rel_path.replace('/lat-md/', '/', 1)
    return stem[:-3] if stem.endswith('.md') else stem


def load_all_sections(repo_root: Path) -> list[Section]:
    sections: list[Section] = []
    for lattice_dir in list_lattice_dirs(repo_root):
        owner_root = lattice_dir.parent
        for file_path in list_lattice_files(lattice_dir):
            sections.extend(parse_sections(repo_root, owner_root, lattice_dir, file_path))
    return sections


def parse_sections(repo_root: Path, owner_root: Path, lattice_dir: Path, file_path: Path) -> list[Section]:
    text = file_path.read_text(encoding='utf-8')
    lines = text.splitlines()
    file_id = lattice_file_id(repo_root, file_path)
    file_rel = file_path.resolve().relative_to(repo_root).as_posix()
    owner_rel = '.' if owner_root == repo_root else owner_root.resolve().relative_to(repo_root).as_posix()

    roots: list[Section] = []
    flat: list[Section] = []
    stack: list[Section] = []
    in_fence = False
    for line_no, line in enumerate(lines, start=1):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = HEADING_RE.match(line)
        if not match:
            continue
        depth = len(match.group(1))
        heading = clean_heading(match.group(2))
        while stack and stack[-1].depth >= depth:
            stack.pop()
        parent = stack[-1] if stack else None
        section_id = f'{parent.id}#{heading}' if parent else f'{file_id}#{heading}'
        section = Section(
            id=section_id,
            heading=heading,
            depth=depth,
            file=file_id,
            file_path=file_rel,
            owner_root=owner_rel,
            start_line=line_no,
            end_line=len(lines),
            first_paragraph='',
        )
        if parent:
            parent.children.append(section)
        else:
            roots.append(section)
        stack.append(section)
        flat.append(section)

    for index, section in enumerate(flat):
        next_heading = flat[index + 1].start_line if index + 1 < len(flat) else len(lines) + 1
        section.end_line = next_heading - 1
        section.first_paragraph = find_first_paragraph(lines, section.start_line + 1, next_heading)
    return roots


def clean_heading(raw: str) -> str:
    return re.sub(r'\s+#+\s*$', '', raw.strip())


def find_first_paragraph(lines: list[str], start: int, stop: int) -> str:
    in_fence = False
    line_no = start
    while line_no < stop:
        line = lines[line_no - 1]
        if FENCE_RE.match(line):
            in_fence = not in_fence
            line_no += 1
            continue
        if in_fence:
            line_no += 1
            continue
        stripped = line.strip()
        if not stripped:
            line_no += 1
            continue
        if HEADING_RE.match(line) or not is_paragraph_start(stripped):
            return ''
        parts = [normalize_inline_text(stripped)]
        line_no += 1
        while line_no < stop:
            next_line = lines[line_no - 1]
            next_stripped = next_line.strip()
            if not next_stripped or HEADING_RE.match(next_line) or FENCE_RE.match(next_line):
                break
            if not is_paragraph_continuation(next_stripped):
                break
            parts.append(normalize_inline_text(next_stripped))
            line_no += 1
        return ' '.join(part for part in parts if part).strip()
    return ''


def is_paragraph_start(line: str) -> bool:
    if line.startswith(('-', '*', '+', '>', '|', '<')):
        return False
    if re.match(r'\d+\.\s', line) or re.match(r'[-*_]{3,}$', line):
        return False
    return True


def is_paragraph_continuation(line: str) -> bool:
    return not (
        line.startswith(('-', '*', '+', '>', '|', '<'))
        or re.match(r'\d+\.\s', line)
    )


def normalize_inline_text(line: str) -> str:
    return re.sub(r'\s+', ' ', line).strip()


def flatten_sections(sections: Iterable[Section]) -> list[Section]:
    result: list[Section] = []
    for section in sections:
        result.append(section)
        result.extend(flatten_sections(section.children))
    return result


def extract_refs(file_path: Path, repo_root: Path) -> list[WikiRef]:
    lines = file_path.read_text(encoding='utf-8').splitlines()
    sections = flatten_sections(parse_sections(repo_root, file_path.parent.parent, file_path.parent, file_path))
    refs: list[WikiRef] = []
    in_fence = False
    current_section = ''
    section_index = 0
    for line_no, line in enumerate(lines, start=1):
        while section_index < len(sections) and sections[section_index].start_line <= line_no:
            current_section = sections[section_index].id
            section_index += 1
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for match in WIKI_RE.finditer(line):
            refs.append(
                WikiRef(
                    target=match.group(1),
                    from_section=current_section,
                    file=lattice_file_id(repo_root, file_path),
                    line=line_no,
                )
            )
    return refs


def parse_frontmatter(text: str) -> dict[str, bool]:
    if not text.startswith('---\n'):
        return {}
    end = text.find('\n---\n', 4)
    if end == -1:
        return {}
    yaml = text[4:end]
    return {'require_code_mention': bool(FRONTMATTER_TRUE_RE.search(yaml))}


def tail_segments(section_id: str) -> list[str]:
    parts = section_id.split('#')
    return ['#'.join(parts[index:]) for index in range(1, len(parts))]


def build_file_index(sections: list[Section]) -> dict[str, list[str]]:
    flat = flatten_sections(sections)
    index: dict[str, set[str]] = {}
    for section in flat:
        parts = section.file.split('/')
        for start in range(1, len(parts)):
            suffix = '/'.join(parts[start:]).lower()
            index.setdefault(suffix, set()).add(section.file)
    return {key: sorted(values) for key, values in index.items()}


def find_root_headings(file_id: str, section_ids: set[str]) -> list[str]:
    prefix = f'{file_id.lower()}#'
    headings: list[str] = []
    for section_id in section_ids:
        if section_id.startswith(prefix) and '#' not in section_id[len(prefix):]:
            headings.append(section_id[len(prefix):])
    return headings


def resolve_ref(target: str, section_ids: set[str], file_index: dict[str, list[str]]) -> ResolveResult:
    if target.lower() in section_ids:
        return ResolveResult(target, None, None)
    file_part, hash_char, rest_part = target.partition('#')
    rest = f'{hash_char}{rest_part}' if hash_char else ''
    file_paths = file_index.get(file_part.lower(), [file_part])
    if len(file_paths) == 1:
        expanded = f'{file_paths[0]}{rest}'
        if expanded.lower() in section_ids:
            return ResolveResult(expanded, None, None)
        for root_heading in find_root_headings(file_paths[0], section_ids):
            candidate = f'{file_paths[0]}#{root_heading}{rest}' if rest else f'{file_paths[0]}#{root_heading}'
            if candidate.lower() in section_ids:
                return ResolveResult(candidate, None, None)
    elif len(file_paths) > 1:
        all_candidates = [f'{path}{rest}' for path in file_paths]
        valid: list[str] = []
        for path in file_paths:
            direct = f'{path}{rest}'
            if direct.lower() in section_ids:
                valid.append(direct)
                continue
            for root_heading in find_root_headings(path, section_ids):
                candidate = f'{path}#{root_heading}{rest}' if rest else f'{path}#{root_heading}'
                if candidate.lower() in section_ids:
                    valid.append(candidate)
                    break
        return ResolveResult(target, all_candidates, valid[0] if len(valid) == 1 else None)
    return ResolveResult(target, None, None)


def levenshtein(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    prev = list(range(len(right) + 1))
    for i, left_char in enumerate(left, start=1):
        curr = [i]
        for j, right_char in enumerate(right, start=1):
            cost = 0 if left_char == right_char else 1
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = curr
    return prev[-1]


def find_sections(sections: list[Section], query: str) -> list[SectionMatch]:
    flat = flatten_sections(sections)
    normalized = query[1:] if query.startswith('#') else query
    q = normalized.lower()
    is_full_path = '#' in normalized

    exact = [section for section in flat if section.id.lower() == q]
    exact_matches = [SectionMatch(section=section, reason='exact match') for section in exact]
    if exact_matches and is_full_path:
        return exact_matches

    file_index = build_file_index(sections)
    if not is_full_path and not exact_matches:
        match_files: set[str] = set()
        for section in flat:
            if section.file.lower() == q and '#' not in section.id[len(section.file) + 1:]:
                match_files.add(section.file)
        match_files.update(file_index.get(q, []))
        if match_files:
            file_roots = [
                section for section in flat
                if section.file in match_files and '#' not in section.id[len(section.file) + 1:]
            ]
            if file_roots:
                return [SectionMatch(section=section, reason='exact match') for section in file_roots]

    stem_matches: list[SectionMatch] = []
    if is_full_path:
        file_part, rest_part = normalized.split('#', 1)
        rest = f'#{rest_part}'
        stem_paths = file_index.get(file_part.lower(), [])
        all_paths = stem_paths if stem_paths else ([file_part] if file_part else [])
        for path in all_paths:
            expanded = f'{path}{rest}'.lower()
            match = next((section for section in flat if section.id.lower() == expanded and section not in exact), None)
            if match:
                stem_matches.append(SectionMatch(match, f'file stem expanded: {file_part} → {path}' if stem_paths else 'exact match'))
                continue
            roots_of_file = [
                section for section in flat
                if section.file.lower() == path.lower() and '#' not in section.id[len(section.file) + 1:]
            ]
            for root_section in roots_of_file:
                candidate = f'{root_section.id}{rest}'.lower()
                resolved = next((section for section in flat if section.id.lower() == candidate and section not in exact), None)
                if resolved:
                    stem_matches.append(SectionMatch(resolved, f'file stem expanded: {file_part} → {path}' if stem_paths else 'exact match'))
        if stem_matches:
            return exact_matches + stem_matches
    else:
        for path in file_index.get(q, []):
            for section in flat:
                if section in exact:
                    continue
                if section.file.lower() == path.lower() and '#' not in section.id[len(section.file) + 1:]:
                    stem_matches.append(SectionMatch(section, 'file stem match'))

    seen = {section.id for section in exact} | {match.section.id for match in stem_matches}
    subsection = [
        SectionMatch(section, 'section name match')
        for section in flat
        if section.id not in seen and any(tail.lower() == q for tail in tail_segments(section.id))
    ] if not is_full_path else []

    seen_sub = seen | {match.section.id for match in subsection}
    q_parts = q.split('#')
    q_variants = [q_parts]
    if len(q_parts) >= 2:
        for expanded in file_index.get(q_parts[0], []):
            q_variants.append([expanded.lower(), *q_parts[1:]])

    subsequence: list[SectionMatch] = []
    if len(q_parts) >= 2:
        for section in flat:
            if section.id in seen_sub:
                continue
            section_parts = section.id.lower().split('#')
            for variant in q_variants:
                if len(section_parts) <= len(variant):
                    continue
                index = 0
                for part in section_parts:
                    if part == variant[index]:
                        index += 1
                        if index == len(variant):
                            skipped = len(section_parts) - len(q_parts)
                            subsequence.append(SectionMatch(section, f'path match, {skipped} intermediate section{"" if skipped == 1 else "s"} skipped'))
                            break
                else:
                    continue
                break

    seen_all = seen_sub | {match.section.id for match in subsequence}
    fuzzy: list[tuple[int, str, Section]] = []
    q_hash = normalized.find('#')
    q_file = normalized[:q_hash].lower() if q_hash != -1 else None
    q_heading = normalized[q_hash + 1:].lower() if q_hash != -1 else None
    for section in flat:
        if section.id in seen_all:
            continue
        best_distance: int | None = None
        best_match = ''
        for candidate in [section.id, *tail_segments(section.id)]:
            lowered = candidate.lower()
            if q_file and q_heading and '#' in lowered:
                c_file, c_heading = lowered.split('#', 1)
                if c_file == q_file:
                    distance = levenshtein(c_heading, q_heading)
                    max_len = max(len(c_heading), len(q_heading))
                else:
                    distance = levenshtein(lowered, q)
                    max_len = max(len(lowered), len(q))
            else:
                distance = levenshtein(lowered, q)
                max_len = max(len(lowered), len(q))
            if max_len and distance / max_len <= 0.4 and (best_distance is None or distance < best_distance):
                best_distance = distance
                best_match = candidate
        if best_distance is not None:
            fuzzy.append((best_distance, best_match, section))
    fuzzy.sort(key=lambda item: item[0])
    fuzzy_matches = [
        SectionMatch(section, f'fuzzy match on "{matched}", distance {distance}' if matched.lower() != section.id.lower() else f'fuzzy match, distance {distance}')
        for distance, matched, section in fuzzy
    ]

    def sort_key(section: Section) -> tuple[int, int, str]:
        return (section.depth, section.file.count('/'), section.id.lower())

    stem_matches.sort(key=lambda match: sort_key(match.section))
    return exact_matches + stem_matches + subsection + subsequence + fuzzy_matches


def all_lattice_files(repo_root: Path) -> list[Path]:
    files: list[Path] = []
    for lattice_dir in list_lattice_dirs(repo_root):
        files.extend(list_lattice_files(lattice_dir))
    return sorted(files)


def is_source_target(repo_root: Path, target: str) -> bool:
    file_part = target.split('#', 1)[0]
    return Path(file_part).suffix.lower() in SOURCE_EXTENSIONS and (repo_root / file_part).exists()


def parse_source_query(repo_root: Path, query: str) -> tuple[str, str] | None:
    file_part, _, symbol = query.partition('#')
    if Path(file_part).suffix.lower() not in SOURCE_EXTENSIONS or not (repo_root / file_part).exists():
        return None
    return file_part, symbol


def source_ref_matches(query: str, target: str) -> bool:
    query_lower = query.lower()
    target_lower = target.lower()
    if '#' not in query:
        return target_lower == query_lower or target_lower.startswith(query_lower + '#')
    return target_lower == query_lower


def scan_code_refs(root: Path, *, exclude_nested: bool = True) -> list[CodeRef]:
    root = root.resolve()
    nested_owner_roots = {
        lattice_dir.parent.resolve()
        for lattice_dir in list_lattice_dirs(root)
        if exclude_nested and lattice_dir.parent.resolve() != root
    }
    refs: list[CodeRef] = []
    for current, dirs, files in os.walk(root):
        current_path = Path(current).resolve()
        rel_current = '' if current_path == root else current_path.relative_to(root).as_posix()
        filtered_dirs: list[str] = []
        for name in list(dirs):
            child = current_path / name
            child_rel = f'{rel_current}/{name}'.strip('/')
            if child_rel in PRUNE_DIRS or name in PRUNE_DIRS:
                continue
            if child.name == 'lat-md' or child.resolve() in nested_owner_roots:
                continue
            filtered_dirs.append(name)
        dirs[:] = sorted(filtered_dirs)
        for name in sorted(files):
            file_path = current_path / name
            suffix = file_path.suffix.lower()
            if suffix == '.md' or suffix not in SOURCE_EXTENSIONS:
                continue
            try:
                lines = file_path.read_text(encoding='utf-8').splitlines()
            except UnicodeDecodeError:
                lines = file_path.read_text(encoding='utf-8', errors='ignore').splitlines()
            rel_path = file_path.relative_to(root).as_posix()
            for line_no, line in enumerate(lines, start=1):
                for match in CODE_REF_RE.finditer(line):
                    refs.append(CodeRef(target=match.group(1), file=rel_path, line=line_no))
    return refs


def load_context(owner_root: Path) -> Context:
    lattice_dir = owner_root / 'lat-md'
    if not lattice_dir.is_dir():
        raise LatError(f'Missing lattice directory: {lattice_dir}')
    index_path = lattice_dir / 'index.md'
    if not index_path.is_file():
        raise LatError(f'Missing lattice root document: {index_path}')
    repo_root = find_repo_root(owner_root)
    local_files = list_lattice_files(lattice_dir)
    local_sections: list[Section] = []
    for file_path in local_files:
        local_sections.extend(parse_sections(repo_root, owner_root, lattice_dir, file_path))
    all_sections = load_all_sections(repo_root)
    flat = flatten_sections(all_sections)
    local_flat = flatten_sections(local_sections)
    return Context(
        owner_root=owner_root,
        repo_root=repo_root,
        lattice_dir=lattice_dir,
        local_files=local_files,
        local_sections=local_sections,
        local_section_ids={section.id.lower() for section in local_flat},
        local_file_index=build_file_index(local_sections),
        local_lookup={section.id.lower(): section for section in local_flat},
        all_sections=all_sections,
        section_ids={section.id.lower() for section in flat},
        file_index=build_file_index(all_sections),
        section_lookup={section.id.lower(): section for section in flat},
    )
