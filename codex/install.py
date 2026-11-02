#!/usr/bin/env python3
"""Build and install the pinned Codex ACP backend from this checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

INPUTS = ('src', 'docs', 'examples', 'scripts', '.claude', 'package.json', 'package-lock.json',
          'tsconfig.json', 'vitest.config.mjs', 'build.mjs', 'README.md', 'README.upstream.md',
          'LICENSE', 'NOTICE', 'UPSTREAM.json', 'AGENTS.md', 'readme-dev.md')


def run(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, default=Path.home()/'.local/share/codex-acp-wrapper-2.2.2-r2')
    parser.add_argument('--bin', type=Path)
    parser.add_argument('--test', action='store_true')
    args = parser.parse_args()
    destination = args.prefix.expanduser().absolute()
    binary = args.bin.expanduser().absolute() if args.bin else None
    if os.path.lexists(destination) or (binary and os.path.lexists(binary)):
        parser.error('Destination or executable already exists; choose a new versioned path.')
    root = Path(__file__).resolve().parent
    origin = json.loads((root/'UPSTREAM.json').read_text())
    digest = hashlib.sha256()
    for name in INPUTS:
        original = root/name
        files = sorted(p for p in original.rglob('*') if p.is_file()) if original.is_dir() else [original]
        for file in files:
            if file.is_file():
                digest.update(str(file.relative_to(root)).encode()+b'\0'+file.read_bytes()+b'\0')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() if (root.parent/'.git').exists() else None
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip()) if revision else None
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.codex-wrapper-', dir=destination.parent) as temporary:
        staging = Path(temporary)
        source = staging/'source'
        source.mkdir()
        for name in INPUTS:
            original = root/name
            if original.is_dir():shutil.copytree(original, source/name)
            elif original.is_file():shutil.copy2(original, source/name)
        run('npm', 'ci', '--ignore-scripts', cwd=source)
        run('npm', 'run', 'typecheck', cwd=source)
        run('npm', 'run', 'build', cwd=source)
        if args.test:
            run('npx', 'vitest', 'run', '--no-file-parallelism',
                'src/__tests__/NativeWorkloads.test.ts', 'src/__tests__/OrchestratorBackground.test.ts',
                'src/__tests__/CodexACPAgent/async-tasks.test.ts', cwd=source)
        installed = staging/'installed'
        installed.mkdir()
        for name in ('package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'README.md', 'README.upstream.md', 'UPSTREAM.json'):
            shutil.copy2(source/name, installed/name)
        shutil.copytree(source/'dist', installed/'dist')
        run('npm', 'ci', '--omit=dev', '--ignore-scripts', cwd=installed)
        entry = installed/'dist/index.js'
        entry.chmod(entry.stat().st_mode | 0o111)
        run(str(entry), '--version', cwd=installed)
        (installed/'FORK.json').write_text(json.dumps({**origin, 'source_repository': 'https://github.com/angrybender/acp-wrapper',
            'source_revision': revision, 'source_dirty': dirty, 'source_sha256': digest.hexdigest()}, indent=2)+'\n')
        installed.rename(destination)
    if binary:
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.symlink_to(destination/'dist/index.js')
    print(f'Installed: {destination}')


if __name__ == '__main__':main()
