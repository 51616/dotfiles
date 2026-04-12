from __future__ import annotations

import re
from pathlib import Path

from latmd_support import (
    Context,
    LatError,
    Section,
    SectionMatch,
    SOURCE_EXTENSIONS,
    WIKI_RE,
    all_lattice_files,
    extract_refs,
    find_sections,
    flatten_sections,
    format_wiki_ref,
    full_end_line,
    is_source_target,
    parse_frontmatter,
    parse_sections,
    parse_source_query,
    rel,
    resolve_ref,
    scan_code_refs,
    source_ref_matches,
)

SUPPORTED_GEN_TARGETS = {
    'router': 'router-lattice-template.md',
    'router-lattice-template.md': 'router-lattice-template.md',
    'section': 'section-template.md',
    'section-template.md': 'section-template.md',
}


def cmd_gen(target: str) -> int:
    normalized = target.lower()
    template_name = SUPPORTED_GEN_TARGETS.get(normalized)
    if not template_name:
        raise LatError('Unknown target. Supported: router, router-lattice-template.md, section, section-template.md')
    template_path = Path(__file__).resolve().parent.parent / 'templates' / template_name
    print(template_path.read_text(encoding='utf-8'), end='')
    return 0


def cmd_init(owner_root: Path, force: bool) -> int:
    lat_dir = owner_root / 'lat-md'
    index_path = lat_dir / 'index.md'
    lat_dir.mkdir(parents=True, exist_ok=True)
    template_path = Path(__file__).resolve().parent.parent / 'templates' / 'router-lattice-template.md'
    template = template_path.read_text(encoding='utf-8')
    if index_path.exists() and not force:
        print(f'lat-md/ already exists at {lat_dir}')
        print(f'Kept existing {index_path}')
        return 0
    index_path.write_text(template, encoding='utf-8')
    print(f'Initialized {index_path}')
    print('Edit lat-md/index.md, then run the local check helpers.')
    return 0


def cmd_check(ctx: Context, mode: str) -> int:
    md_errors = check_markdown(ctx) if mode in {'all', 'md'} else []
    code_errors = check_code_refs(ctx) if mode in {'all', 'code-refs'} else []
    index_errors = check_index(ctx) if mode in {'all', 'index'} else []
    section_errors = check_sections(ctx) if mode in {'all', 'sections'} else []

    if mode == 'all':
        print(f'Scanned {len(ctx.local_files)} markdown files in {rel(ctx.owner_root, ctx.repo_root)}/lat-md')
    total = len(md_errors) + len(code_errors) + len(index_errors) + len(section_errors)
    for group in (md_errors, code_errors, index_errors, section_errors):
        if group:
            print('')
            for entry in group:
                print(f'- {entry}')
    if total:
        print(f'\n{total} error{"" if total == 1 else "s"} found')
        return 1
    label = {
        'all': 'All checks passed',
        'md': 'md: All links OK',
        'code-refs': 'code-refs: All references OK',
        'index': 'index: All directory index files OK',
        'sections': 'sections: All sections have valid leading paragraphs',
    }[mode]
    print(label)
    return 0


def cmd_locate(ctx: Context, query: str) -> int:
    stripped = strip_wiki(query)
    matches = local_first_matches(ctx, stripped)
    if not matches:
        print(f'No sections matching "{stripped}" (no exact, substring, or fuzzy matches)')
        return 1
    print(format_result_list(f'Sections matching "{stripped}":', matches))
    return 0


def cmd_section(ctx: Context, query: str) -> int:
    result = get_section(ctx, strip_wiki(query))
    if isinstance(result, list):
        if result:
            print(f'Query "{query}" is ambiguous. Use an exact section id:')
            for match in result:
                print(f'  * {match.section.id} ({match.reason})')
        else:
            print(f'No sections matching "{query}"')
        return 1
    print(result)
    return 0


def cmd_refs(ctx: Context, query: str, scope: str) -> int:
    found, suggestions, lines = find_refs(ctx, strip_wiki(query), scope)
    if not found:
        if suggestions:
            print(f'Query "{query}" is ambiguous. Use an exact section id:')
            for match in suggestions:
                print(f'  * {match.section.id} ({match.reason})')
        else:
            print(f'No section matching "{query}"')
        return 1
    if not lines:
        print(f'No references to "{query}" found')
        return 1
    print('\n'.join(lines))
    return 0


def cmd_expand(ctx: Context, text: str) -> int:
    expanded = expand_text(ctx, text)
    print(expanded, end='' if expanded.endswith('\n') else '\n')
    return 0


def strip_wiki(text: str) -> str:
    if text.startswith('[[') and text.endswith(']]'):
        text = text[2:-2]
    target, _sep, _alias = text.partition('|')
    return target.strip()


def select_unique_match(matches: list[SectionMatch]) -> SectionMatch | list[SectionMatch]:
    if not matches:
        return matches
    if matches[0].reason == 'exact match' or len(matches) == 1:
        return matches[0]
    return matches


def reason_rank(reason: str) -> int:
    if reason == 'exact match':
        return 0
    if reason.startswith('file stem expanded') or reason == 'file stem match':
        return 1
    if reason == 'section name match':
        return 2
    if reason.startswith('path match'):
        return 3
    return 4


def local_first_matches(ctx: Context, query: str) -> list[SectionMatch]:
    matches = find_sections(ctx.all_sections, query)
    owner_rel = rel(ctx.owner_root, ctx.repo_root)
    return sorted(
        matches,
        key=lambda match: (
            reason_rank(match.reason),
            0 if match.section.owner_root == owner_rel else 1,
            match.section.depth,
            match.section.file.count('/'),
            match.section.id.lower(),
        ),
    )


def resolve_ctx_ref(ctx: Context, target: str):
    local = resolve_ref(target, ctx.local_section_ids, ctx.local_file_index)
    if local.ambiguous or local.resolved.lower() in ctx.local_section_ids:
        return local
    return resolve_ref(target, ctx.section_ids, ctx.file_index)


def format_result_list(header: str, matches: list[SectionMatch]) -> str:
    parts = ['', f'## {header}', '']
    for index, match in enumerate(matches):
        if index:
            parts.append('')
        parts.append(format_section_preview(match))
    parts.append('')
    return '\n'.join(parts)


def format_section_preview(match: SectionMatch) -> str:
    section = match.section
    lines = [f'* [[{section.id}]] ({match.reason})', f'  Defined in {section.file_path}:{section.start_line}-{section.end_line}']
    if section.first_paragraph:
        lines.extend(['', f'  > {section.first_paragraph}'])
    return '\n'.join(lines)


def get_section(ctx: Context, query: str) -> str | list[SectionMatch]:
    matches = local_first_matches(ctx, query)
    selected = select_unique_match(matches)
    if isinstance(selected, list):
        return selected
    section = selected.section
    content_lines = (ctx.repo_root / section.file_path).read_text(encoding='utf-8').splitlines()
    snippet = '\n'.join(content_lines[section.start_line - 1:full_end_line(section)])
    outgoing = section_outgoing_refs(ctx, section)
    incoming = section_incoming_refs(ctx, section)
    code_refs = section_code_refs(ctx, section)

    parts = [f'[[{section.id}]] ({section.file_path}:{section.start_line}-{section.end_line})', '', *quote_block(snippet)]
    if outgoing:
        parts.extend(['', '## This section references:', ''])
        parts.extend(outgoing)
    if incoming:
        parts.extend(['', '## Referenced by:', ''])
        parts.extend(incoming)
    if code_refs:
        parts.extend(['', '## Referenced by code:', ''])
        parts.extend(code_refs)
    parts.extend(['', '## To navigate further:', '', '* `bash <run-lat.sh> <owner-root> locate "query"`', '* `bash <run-lat.sh> <owner-root> section "section#id"`'])
    return '\n'.join(parts)


def quote_block(text: str) -> list[str]:
    return ['> ' + line if line else '>' for line in text.splitlines()]


def section_outgoing_refs(ctx: Context, section: Section) -> list[str]:
    refs = extract_refs(ctx.repo_root / section.file_path, ctx.repo_root)
    seen: set[str] = set()
    lines: list[str] = []
    for ref in refs:
        if ref.from_section.lower() != section.id.lower():
            continue
        resolved = resolve_ctx_ref(ctx, ref.target)
        if resolved.ambiguous:
            continue
        key = resolved.resolved.lower()
        if key in ctx.section_lookup and key not in seen:
            seen.add(key)
            target = ctx.section_lookup[key]
            summary = f' — {target.first_paragraph}' if target.first_paragraph else ''
            lines.append(f'* [[{target.id}]]{summary}')
        elif is_source_target(ctx.repo_root, ref.target) and ref.target.lower() not in seen:
            seen.add(ref.target.lower())
            lines.append(f'* [[{ref.target}]]')
    return lines


def section_incoming_refs(ctx: Context, section: Section) -> list[str]:
    target = section.id.lower()
    lines: list[str] = []
    seen: set[str] = set()
    for file_path in all_lattice_files(ctx.repo_root):
        for ref in extract_refs(file_path, ctx.repo_root):
            resolved = resolve_ctx_ref(ctx, ref.target)
            if resolved.ambiguous or resolved.resolved.lower() != target or ref.from_section.lower() == target:
                continue
            referrer = ctx.section_lookup.get(ref.from_section.lower())
            if not referrer or referrer.id.lower() in seen:
                continue
            seen.add(referrer.id.lower())
            summary = f' — {referrer.first_paragraph}' if referrer.first_paragraph else ''
            lines.append(f'* [[{referrer.id}]]{summary}')
    return lines


def section_code_refs(ctx: Context, section: Section) -> list[str]:
    target = section.id.lower()
    lines: list[str] = []
    for ref in scan_code_refs(ctx.repo_root, exclude_nested=False):
        resolved = resolve_ctx_ref(ctx, ref.target)
        if not resolved.ambiguous and resolved.resolved.lower() == target:
            lines.append(f'* {ref.file}:{ref.line}')
    return lines


def find_refs(ctx: Context, query: str, scope: str) -> tuple[bool, list[SectionMatch], list[str]]:
    if parse_source_query(ctx.repo_root, query) is not None:
        return True, [], source_ref_lines(ctx, query, scope)

    matches = local_first_matches(ctx, query)
    selected = select_unique_match(matches)
    if isinstance(selected, list):
        return False, selected, []
    exact = selected.section

    lines: list[str] = []
    if scope in {'md', 'md+code'}:
        md_lines = md_ref_lines(ctx, exact.id.lower(), f'References to "{exact.id}":')
        lines.extend(md_lines)
    if scope in {'code', 'md+code'}:
        code_lines = code_ref_lines(ctx, exact.id.lower(), source_query=None)
        if lines and code_lines:
            lines.append('')
        lines.extend(code_lines)
    return True, [], lines


def source_ref_lines(ctx: Context, query: str, scope: str) -> list[str]:
    lines: list[str] = []
    if scope in {'md', 'md+code'}:
        matching_sections: dict[str, Section] = {}
        for file_path in all_lattice_files(ctx.repo_root):
            for ref in extract_refs(file_path, ctx.repo_root):
                if source_ref_matches(query, ref.target):
                    referrer = ctx.section_lookup.get(ref.from_section.lower())
                    if referrer:
                        matching_sections[referrer.id.lower()] = referrer
        if matching_sections:
            lines.append(f'## References to "{query}":')
            lines.append('')
            for section in matching_sections.values():
                summary = f' — {section.first_paragraph}' if section.first_paragraph else ''
                lines.append(f'* [[{section.id}]]{summary}')
    if scope in {'code', 'md+code'}:
        code_lines = code_ref_lines(ctx, target_id=None, source_query=query)
        if lines and code_lines:
            lines.append('')
        lines.extend(code_lines)
    return lines


def md_ref_lines(ctx: Context, target_id: str, header: str) -> list[str]:
    matching_sections: dict[str, Section] = {}
    for file_path in all_lattice_files(ctx.repo_root):
        for ref in extract_refs(file_path, ctx.repo_root):
            resolved_ref = resolve_ctx_ref(ctx, ref.target)
            if not resolved_ref.ambiguous and resolved_ref.resolved.lower() == target_id:
                referrer = ctx.section_lookup.get(ref.from_section.lower())
                if referrer:
                    matching_sections[referrer.id.lower()] = referrer
    if not matching_sections:
        return []
    lines = [f'## {header}', '']
    for section in matching_sections.values():
        summary = f' — {section.first_paragraph}' if section.first_paragraph else ''
        lines.append(f'* [[{section.id}]]{summary}')
    return lines


def code_ref_lines(ctx: Context, target_id: str | None, source_query: str | None) -> list[str]:
    matched: list[str] = []
    for ref in scan_code_refs(ctx.repo_root, exclude_nested=False):
        if source_query is not None:
            if source_ref_matches(source_query, ref.target):
                matched.append(f'* {ref.file}:{ref.line}')
            continue
        resolved_ref = resolve_ctx_ref(ctx, ref.target)
        if not resolved_ref.ambiguous and resolved_ref.resolved.lower() == target_id:
            matched.append(f'* {ref.file}:{ref.line}')
    return ['## Code references:', '', *matched] if matched else []


def expand_text(ctx: Context, text: str) -> str:
    refs = list(WIKI_RE.finditer(text))
    if not refs:
        return text
    resolved_map: dict[str, tuple[SectionMatch, list[SectionMatch]]] = {}
    for match in refs:
        target = match.group(1)
        alias = match.group(2)
        if target not in resolved_map:
            matches = local_first_matches(ctx, target)
            if not matches:
                raise LatError(f'No section found for {format_wiki_ref(target, alias)} (no exact, substring, or fuzzy matches).')
            resolved_map[target] = (matches[0], matches[1:])

    def replace(match: re.Match[str]) -> str:
        alias = match.group(2)
        return format_wiki_ref(resolved_map[match.group(1)][0].section.id, alias)

    output = WIKI_RE.sub(replace, text)
    output += '\n\n<lat-context>\n'
    for target, (best, alternatives) in resolved_map.items():
        is_exact = best.reason == 'exact match' or best.reason.startswith('file stem expanded')
        candidates = [best] if is_exact else [best, *alternatives]
        output += f'* `[[{target}]]` ' + ('is referring to:\n' if is_exact else 'might be referring to either of the following:\n')
        for candidate in candidates:
            output += f'  * [[{candidate.section.id}]]'
            if not is_exact:
                output += f' ({candidate.reason})'
            output += '\n'
            output += f'    * {candidate.section.file_path}:{candidate.section.start_line}-{candidate.section.end_line}\n'
            if candidate.section.first_paragraph:
                output += f'    * {candidate.section.first_paragraph}\n'
    output += '</lat-context>\n'
    return output


def check_markdown(ctx: Context) -> list[str]:
    errors: list[str] = []
    for file_path in ctx.local_files:
        for ref in extract_refs(file_path, ctx.repo_root):
            resolved = resolve_ctx_ref(ctx, ref.target)
            if resolved.ambiguous:
                message = f"ambiguous link '[[{ref.target}]]'"
                if resolved.suggested:
                    message += f" — did you mean '[[{resolved.suggested}]]'?"
                else:
                    options = ', '.join(f'[[{candidate}]]' for candidate in resolved.ambiguous)
                    message += f' — multiple paths match, use one of: {options}'
                errors.append(format_error(file_path, ref.line, message))
                continue
            if resolved.resolved.lower() in ctx.section_ids:
                continue
            source_error = validate_source_target(ctx.repo_root, ref.target)
            if source_error:
                errors.append(format_error(file_path, ref.line, source_error))
    return errors


def validate_source_target(repo_root: Path, target: str) -> str | None:
    file_part, hash_char, symbol_part = target.partition('#')
    suffix = Path(file_part).suffix.lower()
    if suffix not in SOURCE_EXTENSIONS:
        if suffix and hash_char:
            supported = ', '.join(sorted(SOURCE_EXTENSIONS))
            return f'broken link [[{target}]] — unsupported file extension "{suffix}". Supported: {supported}'
        return f'broken link [[{target}]] — no matching section found'
    source_path = repo_root / file_part
    if not source_path.exists():
        return f'broken link [[{target}]] — file "{file_part}" not found'
    if not symbol_part:
        return None
    content = source_path.read_text(encoding='utf-8', errors='ignore')
    return None if all(name in content for name in symbol_part.split('#')) else f'broken link [[{target}]] — symbol "{symbol_part}" not found in "{file_part}"'


def check_code_refs(ctx: Context) -> list[str]:
    errors: list[str] = []
    mentioned_sections: set[str] = set()
    for ref in scan_code_refs(ctx.owner_root):
        resolved = resolve_ctx_ref(ctx, ref.target)
        if resolved.ambiguous:
            errors.append(format_error(ctx.repo_root / ref.file, ref.line, f'@lat: [[{ref.target}]] — ambiguous reference'))
            continue
        mentioned_sections.add(resolved.resolved.lower())
        if resolved.resolved.lower() not in ctx.section_ids:
            errors.append(format_error(ctx.repo_root / ref.file, ref.line, f'@lat: [[{ref.target}]] — no matching section found'))
    for file_path in ctx.local_files:
        text = file_path.read_text(encoding='utf-8')
        if not parse_frontmatter(text).get('require_code_mention'):
            continue
        sections = parse_sections(ctx.repo_root, ctx.owner_root, ctx.lattice_dir, file_path)
        for section in [section for section in flatten_sections(sections) if not section.children]:
            if section.id.lower() not in mentioned_sections:
                errors.append(format_error(file_path, section.start_line, f'section "{section.id}" requires a code mention but none found'))
    return errors


def check_index(ctx: Context) -> list[str]:
    errors: list[str] = []
    all_paths = [path.relative_to(ctx.lattice_dir).as_posix() for path in ctx.local_files]
    dirs: set[str] = {''}
    for path in all_paths:
        parent = Path(path).parent.as_posix()
        while parent not in {'', '.'}:
            dirs.add(parent)
            parent = Path(parent).parent.as_posix()
        dirs.add('')
    for directory in sorted(dirs):
        prefix = f'{directory}/' if directory else ''
        child_files = [path for path in all_paths if path.startswith(prefix) and path != f'{prefix}index.md']
        immediate_files: set[str] = set()
        immediate_dirs: set[str] = set()
        for path in child_files:
            remainder = path[len(prefix):]
            if '/' in remainder:
                immediate_dirs.add(remainder.split('/', 1)[0])
            else:
                immediate_files.add(remainder)
        children = sorted(immediate_files | immediate_dirs)
        if not children:
            continue
        index_rel = f'{prefix}index.md'
        index_path = ctx.lattice_dir / index_rel
        if not index_path.exists():
            errors.append(f'{display_dir(directory)}: missing index file "{index_rel}" — create it with a directory listing:\n\n{index_snippet(children)}')
            continue
        listed = parse_index_entries(index_path.read_text(encoding='utf-8'))
        expected = {entry_to_index_stem(name) for name in children}
        missing = sorted(stem for stem in expected if stem not in listed)
        if missing:
            snippet = index_snippet([stem_to_entry(stem) for stem in missing])
            errors.append(f'{display_dir(directory)}: "{index_rel}" is missing entries — add:\n\n{snippet}')
        extra = sorted(stem for stem in listed if stem not in expected and stem != 'index')
        for stem in extra:
            errors.append(f'{display_dir(directory)}: "{index_rel}" lists "[[{stem}]]" but it does not exist')
    return errors


def display_dir(directory: str) -> str:
    return 'lat-md/' if not directory else f'lat-md/{directory}/'


def parse_index_entries(text: str) -> set[str]:
    return {match.strip() for match in re.findall(r'^- \[\[([^\]|]+)(?:\|[^\]]+)?\]\]', text, flags=re.MULTILINE)}


def entry_to_index_stem(name: str) -> str:
    return name[:-3] if name.endswith('.md') else f'{name}/index'


def stem_to_entry(stem: str) -> str:
    return stem[:-6] if stem.endswith('/index') else f'{stem}.md'


def index_snippet(children: list[str]) -> str:
    return '\n'.join(f'- [[{entry_to_index_stem(name)}]] — <describe>' for name in children)


def check_sections(ctx: Context) -> list[str]:
    errors: list[str] = []
    for file_path in ctx.local_files:
        for section in flatten_sections(parse_sections(ctx.repo_root, ctx.owner_root, ctx.lattice_dir, file_path)):
            if not section.first_paragraph:
                errors.append(format_error(file_path, section.start_line, f'section "{section.id}" has no leading paragraph.'))
                continue
            body = re.sub(r'\[\[[^\]]*\]\]', '', section.first_paragraph)
            if len(body) > 250:
                errors.append(format_error(file_path, section.start_line, f'section "{section.id}" leading paragraph is {len(body)} characters (max 250, excluding [[wiki links]]).'))
    return errors


def format_error(file_path: Path, line: int, message: str) -> str:
    return f'{file_path}:{line}: {message}'
