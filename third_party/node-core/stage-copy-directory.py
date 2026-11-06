#!/usr/bin/env python3
"""Stage the pinned cp walk and real guest POSIX owner as a separate unit."""
from pathlib import Path
import argparse
import runpy
import shutil


def stage(root, destination):
    root, destination = Path(root), Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    generator = runpy.run_path(str(root / 'generate-copy-directory.py'))
    for name, text in generator['native'](root).items():
        (destination / ('kandelo-node-copy-directory-' + name + '.inc')).write_text(text)
    shutil.copyfile(root / 'copy-directory-operations.h', destination / 'kandelo-node-copy-directory-operations.h')
    source = (root / 'copy-directory-operations.cc').read_text()
    needle = '#include "copy-directory-operations.h"'
    if source.count(needle) != 1:
        raise ValueError('Review native cp staging include')
    (destination / 'kandelo-node-copy-directory-operations.cpp').write_text(
        source.replace(needle, '#include "kandelo-node-copy-directory-operations.h"'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    stage(Path(__file__).resolve().parent, args.destination)
