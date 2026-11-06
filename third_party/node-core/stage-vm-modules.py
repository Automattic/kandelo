#!/usr/bin/env python3
"""Verify the pinned VM module owner and retain its public algorithms unchanged."""
import argparse
import hashlib
import json
from pathlib import Path


def render(root):
    spec = json.loads((root / 'vm-modules-sources.json').read_text())
    target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
    if (spec['version'], spec['commit']) != (target['version'], target['source']['commit']):
        raise ValueError('VM modules and Node target differ')
    sources = {}
    for name, item in spec['sources'].items():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('VM module source identity mismatch: ' + name)
        sources[name] = raw.decode('utf-8')
    item = spec['getConstructorOf']
    source = sources[item['source']]
    if source.count(item['start']) != 1:
        raise ValueError('Ambiguous VM constructor helper')
    offset = source.index(item['start'])
    helper = source[offset:offset + item['length']]
    if hashlib.sha256(helper.encode()).hexdigest() != item['sha256']:
        raise ValueError('VM constructor helper identity mismatch')
    adapter = (root / 'vm-modules-adapter.js').read_text()
    helper_marker = '/* NODE_VM_GET_CONSTRUCTOR */'
    if adapter.count(helper_marker) != 1:
        raise ValueError('Review VM constructor helper marker')
    adapter = adapter.replace(helper_marker, helper)
    marker = '/* NODE_VM_MODULE_CLASSES */'
    if adapter.count(marker) != 1:
        raise ValueError('Review VM module class marker')
    return adapter.replace(marker, sources['lib/internal/vm/module.js'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(render(Path(__file__).resolve().parent))
