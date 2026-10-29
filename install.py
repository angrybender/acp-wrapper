#!/usr/bin/env python3
"""Build this Claude ACP source checkout in isolation and install its runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

SOURCE_PATHS = (
    'src', 'docs', 'examples', 'scripts', '.github',
    'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
    'eslint.config.js', '.prettierrc.json', '.prettierignore', '.gitattributes',
    '.gitignore', '.release-please-manifest.json', 'release-please-config.json',
    'README.md', 'README.upstream.md', 'LICENSE', 'NOTICE', 'AGENTS.md',
    'CLAUDE.md', 'CHANGELOG.md', 'UPSTREAM.json', 'background-drain.patch', 'install.py',
)


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def source_revision(root):
    if not (root / '.git').exists():
        return None, None
    try:
        revision = subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
        dirty = bool(subprocess.check_output(
            ['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=root, text=True))
        return revision, dirty
    except (OSError, subprocess.CalledProcessError):
        return None, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, default=Path.home()/'.local/share/claude-acp-background-0.96.0-r1')
    parser.add_argument('--bin', type=Path, help='Optional executable symlink (must not exist)')
    parser.add_argument('--test', action='store_true', help='Run checks and ACP/async-task tests before installing')
    args = parser.parse_args()
    destination = args.prefix.expanduser().absolute()
    if args.bin:
        args.bin = args.bin.expanduser().absolute()
    if os.path.lexists(destination) or (args.bin and os.path.lexists(args.bin)):
        parser.error('Destination or executable already exists; choose a new versioned path.')
    root = Path(__file__).resolve().parent
    if not (root/'src/acp-agent.ts').is_file() or not (root/'UPSTREAM.json').is_file():
        parser.error('Install from the complete source checkout; src/ and UPSTREAM.json are required.')
    upstream = json.loads((root/'UPSTREAM.json').read_text())
    patch_hash = hashlib.sha256((root/'background-drain.patch').read_bytes()).hexdigest()
    if patch_hash != upstream['patch_sha256']:
        parser.error('Patch SHA256 differs from UPSTREAM.json; update source provenance before installing.')
    revision, dirty = source_revision(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.claude-fork-', dir=destination.parent) as temporary:
        staging = Path(temporary)
        source = staging/'source'
        source.mkdir()
        # Copy build inputs only. Git history, credentials, generated output and
        # the staging directory are never part of the source export.
        for name in SOURCE_PATHS:
            original = root/name
            if original.is_dir():
                shutil.copytree(original, source/name)
            elif original.is_file():
                shutil.copy2(original, source/name)
        run('npm', 'ci', '--ignore-scripts', cwd=source)
        run('npm', 'run', 'build', cwd=source)
        if args.test:
            run('npm', 'run', 'check', cwd=source)
            run('npm', 'run', 'test:run', '--', 'src/tests/async-tasks.test.ts', 'src/tests/acp-agent.test.ts', cwd=source)
        installed = staging/'installed'
        installed.mkdir()
        for name in ('package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'README.md', 'README.upstream.md', 'UPSTREAM.json'):
            shutil.copy2(source/name, installed/name)
        shutil.copytree(source/'dist', installed/'dist', ignore=shutil.ignore_patterns('tests'))
        run('npm', 'ci', '--omit=dev', '--ignore-scripts', cwd=installed)
        entry = installed/'dist/index.js'
        entry.chmod(entry.stat().st_mode | 0o111)
        run(str(entry), '--version', cwd=installed)
        (installed/'FORK.json').write_text(json.dumps({
            'upstream': upstream['repository'], 'revision': upstream['revision'],
            'patch_sha256': patch_hash,
            'source_repository': 'https://github.com/angrybender/acp-wrapper.git',
            'source_revision': revision, 'source_dirty': dirty,
            'contract': upstream['contract']['name'], 'version': upstream['contract']['version'],
        }, indent=2)+'\n')
        installed.rename(destination)
    if args.bin:
        args.bin.parent.mkdir(parents=True, exist_ok=True)
        args.bin.symlink_to(destination/'dist/index.js')
    print(f'Installed: {destination}')


if __name__ == '__main__':
    main()
