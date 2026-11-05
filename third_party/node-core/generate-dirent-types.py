#!/usr/bin/env python3
"""Retain the exact pinned libuv directory-entry enum for native/JS owners."""
import argparse
import hashlib
import json
from pathlib import Path


def render(root):
    manifest = json.loads((root / 'sources.json').read_text())
    target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
    if (manifest['version'], manifest['commit']) != (target['version'], target['source']['commit']):
        raise ValueError('Directory types must share the exact Node target')
    group = manifest['readdirPlatform']
    item = group['sources']['uv']
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Directory type source identity mismatch')
    selector = group['direntEnum']
    source = raw.decode()
    if source.count(selector['start']) != 1:
        raise ValueError('Ambiguous directory type declaration')
    start = source.index(selector['start'])
    enum = source[start:start + selector['length']]
    if hashlib.sha256(enum.encode()).hexdigest() != selector['sha256']:
        raise ValueError('Directory type enum identity mismatch')
    return ('// Generated unchanged libuv enum; license: licenses/libuv.txt.\n'
            '#ifndef KANDELO_NODE_DIRENT_TYPES_H\n#define KANDELO_NODE_DIRENT_TYPES_H\n'
            'namespace kandelo::nodefs {\n' + enum + '\n}\n#endif\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(render(Path(__file__).resolve().parent))
