#!/bin/sh
''':'
exec python3 "$0" "$@"
':'''
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from latmd_ops import (
    cmd_check,
    cmd_check_all,
    cmd_expand,
    cmd_gen,
    cmd_init,
    cmd_locate,
    cmd_refs,
    cmd_section,
)
from latmd_support import LatError, load_context


def build_parser() -> argparse.ArgumentParser:
    formatter = argparse.RawDescriptionHelpFormatter
    parser = argparse.ArgumentParser(
        prog='bash <run-lat.sh>',
        formatter_class=formatter,
        description=(
            'Navigate and validate lattices stored under lat-md/.\n\n'
            'A lattice is a small markdown graph that explains ownership, boundaries,\n'
            'invariants, and code links. An owner root is the directory that directly\n'
            'contains a lat-md/ folder, for example ., .pi/scripts, or src. If you\n'
            'omit owner_root, this tool assumes `.`.'
        ),
        epilog=(
            'Common workflows:\n'
            '  bash <run-lat.sh> check\n'
            '  bash <run-lat.sh> locate scripts\n'
            '  bash <run-lat.sh> section "scripts#Scripts"\n'
            '  bash <run-lat.sh> refs "scripts#Scripts"\n'
            '  bash <run-lat.sh> expand --stdin < note.txt\n'
            '  bash <run-lat.sh> gen section\n\n'
            'Tip: start with `check` to validate a lattice, `locate` to find the right\n'
            'section id, and `section` to inspect the actual content and links.'
        ),
    )
    parser.add_argument('--no-color', action='store_true', help='print plain output')
    subparsers = parser.add_subparsers(dest='command', required=True, metavar='command')

    check = subparsers.add_parser(
        'check',
        formatter_class=formatter,
        help='validate a lattice',
        description=(
            'Validate one owner root. This checks wiki links, @lat code references,\n'
            'directory indexes, and the leading-paragraph rule for sections.'
        ),
        epilog=(
            'Examples:\n'
            '  bash <run-lat.sh> check\n'
            '  bash <run-lat.sh> check md\n'
            '  bash <run-lat.sh> .pi/scripts check code-refs\n\n'
            'Modes:\n'
            '  all        run every check\n'
            '  md         validate [[wiki links]]\n'
            '  code-refs  validate @lat references in source code\n'
            '  index      validate index.md directory listings\n'
            '  sections   validate section summaries and first paragraphs'
        ),
    )
    check.add_argument('owner_root', nargs='?', default='.', help='directory that owns the target lat-md/ folder; defaults to .')
    check.add_argument('mode', nargs='?', choices=('all', 'md', 'code-refs', 'index', 'sections'), default='all', help='which validation pass to run')
    check.set_defaults(needs_context=True)

    check_all = subparsers.add_parser(
        'check-all',
        formatter_class=formatter,
        help='validate every lattice under a repo root',
        description=(
            'Discover every lat-md/ directory under a target root and validate each\n'
            'owner root in one Python process. This avoids reparsing repo-wide\n'
            'lattice state once per owner root.'
        ),
        epilog=(
            'Examples:\n'
            '  bash <check-all-lattices.sh>\n'
            '  bash <run-lat.sh> check-all\n'
            '  bash <run-lat.sh> check-all .\n'
            '  bash <run-lat.sh> check-all --verbose .'
        ),
    )
    check_all.add_argument('target_root', nargs='?', default='.', help='repo or subtree to search for lat-md/ directories; defaults to .')
    check_all.add_argument('--verbose', action='store_true', help='print full check output for successful lattices too')
    check_all.set_defaults(needs_context=False)

    locate = subparsers.add_parser(
        'locate',
        formatter_class=formatter,
        help='search for section ids',
        description=(
            'Find candidate sections for a query. This is the best first step when\n'
            'you know the concept but not the exact section id.'
        ),
        epilog=(
            'Examples:\n'
            '  bash <run-lat.sh> locate scripts\n'
            '  bash <run-lat.sh> .pi/scripts locate health\n'
            '  bash <run-lat.sh> locate "slash-command-rpc#Discord parity wrappers"'
        ),
    )
    locate.add_argument('owner_root', nargs='?', default='.', help='directory that owns the target lat-md/ folder; defaults to .')
    locate.add_argument('query', help='section id fragment, heading name, or short path')
    locate.set_defaults(needs_context=True)

    section = subparsers.add_parser(
        'section',
        formatter_class=formatter,
        help='show one section in full',
        description=(
            'Show a section body plus outgoing links, incoming links, and code refs.\n'
            'Use this after `locate` when you want the actual contract text.'
        ),
        epilog=(
            'Examples:\n'
            '  bash <run-lat.sh> section "scripts#Scripts"\n'
            '  bash <run-lat.sh> .pi/scripts section ".pi/scripts/health-checks#Health checks"'
        ),
    )
    section.add_argument('owner_root', nargs='?', default='.', help='directory that owns the target lat-md/ folder; defaults to .')
    section.add_argument('query', help='exact or near-match section id')
    section.set_defaults(needs_context=True)

    refs = subparsers.add_parser(
        'refs',
        formatter_class=formatter,
        help='find who points at a section',
        description=(
            'Find markdown and code references to a section or source target.\n'
            'This is useful before renaming headings or changing contracts.'
        ),
        epilog=(
            'Examples:\n'
            '  bash <run-lat.sh> refs "scripts#Scripts"\n'
            '  bash <run-lat.sh> refs src/app.py#MyClass --scope code\n'
            '  bash <run-lat.sh> .pi/scripts refs "health-checks#Change guidance" --scope md'
        ),
    )
    refs.add_argument('owner_root', nargs='?', default='.', help='directory that owns the target lat-md/ folder; defaults to .')
    refs.add_argument('query', help='section id or source target like src/app.py#MyClass')
    refs.add_argument('--scope', choices=('md', 'code', 'md+code'), default='md+code', help='search markdown refs, code refs, or both')
    refs.set_defaults(needs_context=True)

    ref = subparsers.add_parser(
        'ref',
        formatter_class=formatter,
        help='alias for refs',
        description='Alias for `refs`.',
    )
    ref.add_argument('owner_root', nargs='?', default='.', help='directory that owns the target lat-md/ folder; defaults to .')
    ref.add_argument('query', help='section id or source target like src/app.py#MyClass')
    ref.add_argument('--scope', choices=('md', 'code', 'md+code'), default='md+code', help='search markdown refs, code refs, or both')
    ref.set_defaults(needs_context=True)

    expand = subparsers.add_parser(
        'expand',
        formatter_class=formatter,
        help='resolve [[wiki refs]] inside text',
        description=(
            'Rewrite [[refs]] in free text to canonical section ids and append a\n'
            'small context block. Useful before handing text to another tool or model.'
        ),
        epilog=(
            'Examples:\n'
            '  bash <run-lat.sh> expand "Look at [[scripts]]"\n'
            '  printf "See [[vault]] and [[scripts]]\\n" | bash <run-lat.sh> expand --stdin'
        ),
    )
    expand.add_argument('owner_root', nargs='?', default='.', help='directory that owns the target lat-md/ folder; defaults to .')
    expand.add_argument('text', nargs='?', help='text containing one or more [[refs]]')
    expand.add_argument('--stdin', action='store_true', help='read input text from stdin instead of an argument')
    expand.set_defaults(needs_context=True)

    gen = subparsers.add_parser(
        'gen',
        formatter_class=formatter,
        help='print a starter template',
        description='Print one of the bundled markdown templates to stdout.',
        epilog=(
            'Examples:\n'
            '  bash <run-lat.sh> gen router\n'
            '  bash <run-lat.sh> gen section > /tmp/section.md'
        ),
    )
    gen.add_argument('target', choices=('router', 'router-lattice-template.md', 'section', 'section-template.md'), help='which template to print')
    gen.set_defaults(needs_context=False)

    init = subparsers.add_parser(
        'init',
        formatter_class=formatter,
        help='create a new lat-md/ root',
        description=(
            'Create lat-md/index.md under an owner root. This gives you the minimal\n'
            'starting point for a new lattice.'
        ),
        epilog=(
            'Examples:\n'
            '  bash <run-lat.sh> init\n'
            '  bash <run-lat.sh> src init\n'
            '  bash <run-lat.sh> init --force'
        ),
    )
    init.add_argument('owner_root', nargs='?', default='.', help='directory where lat-md/ should be created; defaults to .')
    init.add_argument('--force', action='store_true', help='overwrite lat-md/index.md with the router template')
    init.set_defaults(needs_context=False)

    return parser


def read_expand_text(args: argparse.Namespace) -> str:
    if args.stdin:
        return sys.stdin.read()
    if args.text is None:
        raise LatError('Provide text as an argument or use --stdin.')
    return args.text


def run(argv: list[str]) -> int:
    parser = build_parser()
    filtered_argv = [arg for arg in argv if arg != '--no-color']
    args = parser.parse_args(filtered_argv)
    try:
        ctx = load_context(Path(args.owner_root).resolve()) if getattr(args, 'needs_context', True) else None
        if args.command == 'check':
            return cmd_check(ctx, args.mode)
        if args.command == 'check-all':
            return cmd_check_all(Path(args.target_root).resolve(), args.verbose)
        if args.command == 'locate':
            return cmd_locate(ctx, args.query)
        if args.command == 'section':
            return cmd_section(ctx, args.query)
        if args.command in {'refs', 'ref'}:
            return cmd_refs(ctx, args.query, args.scope)
        if args.command == 'expand':
            return cmd_expand(ctx, read_expand_text(args))
        if args.command == 'gen':
            return cmd_gen(args.target)
        if args.command == 'init':
            return cmd_init(Path(args.owner_root).resolve(), args.force)
        raise LatError(f'Unknown command: {args.command}')
    except LatError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(run(sys.argv[1:]))
