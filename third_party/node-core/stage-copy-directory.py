#!/usr/bin/env python3
"""Stage the pinned cp walk and real guest POSIX owner as a separate unit."""
from pathlib import Path
import argparse
import runpy
import shutil


def stage(root, destination):
    root, destination = Path(root), Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for old in ['core', 'types']:
        (destination / ('kandelo-node-copy-directory-' + old + '.inc')).unlink(missing_ok=True)
    generator = runpy.run_path(str(root / 'generate-copy-directory.py'))
    for name, text in generator['native'](root).items():
        suffix = '-inl.h' if name == 'core' else '.h'
        (destination / ('kandelo-node-copy-directory-' + name + suffix)).write_text(text)
    header = (root / 'copy-directory-operations.h').read_text().replace(
        '#include \"kandelo-node-copy-directory-types.inc\"',
        '#include \"shell/kandelo-node-copy-directory-types.h\"').replace(
        '#include \"copy-file-operations.h\"', '#include \"shell/kandelo-node-copy-file-operations.h\"')
    (destination / 'kandelo-node-copy-directory-operations.h').write_text(header)
    source = (root / 'copy-directory-operations.cc').read_text()
    needle = '#include "copy-directory-operations.h"'
    if source.count(needle) != 1:
        raise ValueError('Review native cp staging include')
    (destination / 'kandelo-node-copy-directory-operations.cpp').write_text(
        source.replace(needle, '#include "shell/kandelo-node-copy-directory-operations.h"').replace(
            '#include "kandelo-node-copy-directory-core.inc"',
            '#include "shell/kandelo-node-copy-directory-core-inl.h"'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    stage(Path(__file__).resolve().parent, args.destination)
