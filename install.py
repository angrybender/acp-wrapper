#!/usr/bin/env python3
"""Build the pinned Claude ACP fork in isolation; install without replacing upstream."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

UPSTREAM = 'https://github.com/agentclientprotocol/claude-agent-acp.git'
REVISION = 'f6958db1ee8d3e9ead6767a3a294f98b9a21adb9'


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, default=Path.home()/'.local/share/claude-acp-background-0.96.0-r1')
    parser.add_argument('--bin', type=Path, help='Optional path for the executable symlink (must not exist)')
    parser.add_argument('--test', action='store_true', help='Run upstream checks and tests before installing')
    args = parser.parse_args()
    destination = args.prefix.expanduser().absolute()
    if args.bin:
        args.bin = args.bin.expanduser().absolute()
    if destination.exists() or (args.bin and os.path.lexists(args.bin)):
        parser.error('Destination or executable already exists; choose a new versioned path.')
    patch = Path(__file__).resolve().with_name('background-drain.patch')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Staging on the destination filesystem permits a single atomic rename.
    with tempfile.TemporaryDirectory(prefix='.claude-fork-', dir=destination.parent) as temporary:
        staging = Path(temporary)
        source = staging/'source'
        run('git', 'clone', '--depth', '1', '--branch', 'v0.96.0', UPSTREAM, str(source))
        actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
        if actual != REVISION:
            raise RuntimeError('Upstream tag no longer matches the pinned commit.')
        run('git', 'apply', '--check', str(patch), cwd=source)
        run('git', 'apply', str(patch), cwd=source)
        run('npm', 'ci', '--ignore-scripts', cwd=source)
        run('npm', 'run', 'build', cwd=source)
        if args.test:
            run('npm', 'run', 'check', cwd=source)
            run('npm', 'run', 'test:run', '--', 'src/tests/async-tasks.test.ts', 'src/tests/acp-agent.test.ts', cwd=source)
        installed = staging/'installed'
        installed.mkdir()
        for name in ('package.json', 'package-lock.json', 'LICENSE', 'README.md'):
            shutil.copy2(source/name, installed/name)
        shutil.copytree(source/'dist', installed/'dist', ignore=shutil.ignore_patterns('tests'))
        run('npm', 'ci', '--omit=dev', '--ignore-scripts', cwd=installed)
        entry = installed/'dist/index.js'
        entry.chmod(entry.stat().st_mode | 0o111)
        run(str(entry), '--version', cwd=installed)
        (installed/'FORK.json').write_text(json.dumps({
            'upstream': UPSTREAM, 'revision': REVISION,
            'patch_sha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
            'contract': 'orchestratorBackgroundTasks', 'version': 1,
        }, indent=2)+'\n')
        installed.rename(destination)
    if args.bin:
        args.bin.parent.mkdir(parents=True, exist_ok=True)
        args.bin.symlink_to(destination/'dist/index.js')
    print(f'Installed: {destination}')


if __name__ == '__main__':
    main()
