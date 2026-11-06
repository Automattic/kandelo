#!/usr/bin/env python3
"""Verify pinned private string-byte primitives before staging the native owner."""
import argparse
import hashlib
import json
from pathlib import Path


def verify(root):
    spec = json.loads((root / 'string-bytes-sources.json').read_text())
    target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
    if (spec['version'], spec['commit']) != (target['version'], target['source']['commit']):
        raise ValueError('Private string-byte source and Node target differ')
    sources = {}
    for name, item in spec['sources'].items():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('Private string-byte source identity mismatch: ' + name)
        sources[name] = raw.decode('utf-8')
    header = (root / 'string-bytes.h').read_text()
    for name, item in spec['selections'].items():
        source = sources[item['source']]
        if source.count(item['start']) != 1:
            raise ValueError('Ambiguous private string-byte selection: ' + name)
        offset = source.index(item['start'])
        selection = source[offset:offset + item['length']]
        if hashlib.sha256(selection.encode()).hexdigest() != item['sha256']:
            raise ValueError('Private string-byte selection identity mismatch: ' + name)
        begin, end = ('// BEGIN_PINNED_NBYTES_' + name + '\n',
                      '// END_PINNED_NBYTES_' + name)
        if header.count(begin) != 1 or header.count(end) != 1:
            raise ValueError('Review private string-byte markers: ' + name)
        embedded = header.split(begin, 1)[1].split(end, 1)[0]
        if embedded != selection + '\n':
            raise ValueError('Private string-byte primitives changed: ' + name)
    return header


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    header = verify(Path(__file__).resolve().parent)
    if args.output:
        args.output.write_text(header)
