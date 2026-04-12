from __future__ import annotations

import subprocess
import textwrap
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / 'scripts'
LATMD = SCRIPT_DIR / 'latmd.py'


def run_latmd(*args: str, cwd: Path | None = None, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['python3', str(LATMD), *args],
        cwd=cwd,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )


def write_lattice(tmp_path: Path, files: dict[str, str]) -> Path:
    for relative_path, content in files.items():
        path = tmp_path / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(content).lstrip(), encoding='utf-8')
    return tmp_path


def test_check_accepts_aliased_wiki_links(tmp_path: Path) -> None:
    owner_root = write_lattice(
        tmp_path,
        {
            'lat-md/index.md': '''
                # Index
                This is the root lattice.

                See [[foo#Section|the foo section]].
            ''',
            'lat-md/foo.md': '''
                # Section
                This section exists.
            ''',
        },
    )

    result = run_latmd('check', str(owner_root), 'md')

    assert result.returncode == 0, result.stderr + result.stdout
    assert 'md: All links OK' in result.stdout


def test_expand_preserves_aliases_when_resolving_refs(tmp_path: Path) -> None:
    owner_root = write_lattice(
        tmp_path,
        {
            'lat-md/index.md': '''
                # Index
                This is the root lattice.

                ## Foo
                This section exists.
            ''',
        },
    )

    result = run_latmd('expand', str(owner_root), 'See [[index#Foo|the foo section]].')

    assert result.returncode == 0, result.stderr + result.stdout
    assert '[[index#Index#Foo|the foo section]]' in result.stdout
    assert '<lat-context>' in result.stdout


def test_section_rejects_ambiguous_heading_only_queries(tmp_path: Path) -> None:
    owner_root = write_lattice(
        tmp_path,
        {
            'lat-md/index.md': '''
                # Index
                This is the root lattice.
            ''',
            'lat-md/alpha.md': '''
                # Alpha
                Alpha owns one subtree.

                ## Change guidance
                Update alpha carefully.
            ''',
            'lat-md/beta.md': '''
                # Beta
                Beta owns another subtree.

                ## Change guidance
                Update beta carefully.
            ''',
        },
    )

    result = run_latmd('section', str(owner_root), 'Change guidance')

    assert result.returncode == 1
    assert 'ambiguous' in result.stdout.lower()
    assert 'alpha#Alpha#Change guidance' in result.stdout
    assert 'beta#Beta#Change guidance' in result.stdout


def test_refs_rejects_ambiguous_heading_only_queries(tmp_path: Path) -> None:
    owner_root = write_lattice(
        tmp_path,
        {
            'lat-md/index.md': '''
                # Index
                This is the root lattice.
            ''',
            'lat-md/alpha.md': '''
                # Alpha
                Alpha owns one subtree.

                ## Change guidance
                Update alpha carefully.
            ''',
            'lat-md/beta.md': '''
                # Beta
                Beta owns another subtree.

                ## Change guidance
                Update beta carefully.
            ''',
        },
    )

    result = run_latmd('refs', str(owner_root), 'Change guidance')

    assert result.returncode == 1
    assert 'ambiguous' in result.stdout.lower()
    assert 'alpha#Alpha#Change guidance' in result.stdout
    assert 'beta#Beta#Change guidance' in result.stdout
