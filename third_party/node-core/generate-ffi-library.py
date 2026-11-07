#!/usr/bin/env python3
"""Assemble the implemented library/symbol subset from unchanged pinned JS."""
from pathlib import Path
import hashlib
import json
ROOT = Path(__file__).resolve().parent


def render():
    manifest = json.loads((ROOT / 'sources.json').read_text())
    spec = manifest['ffiLibrary']
    if (spec['version'], spec['commit']) != (manifest['version'], manifest['commit']):
        raise ValueError('FFI library sources must retain the audited target')
    sources = {}
    for name, item in spec['references'].items():
        raw = (ROOT / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('FFI reference identity mismatch: ' + name)
        sources[name] = raw.decode()
    adapter = (ROOT / 'ffi-library-platform-adapter.js').read_text()
    for name, selector in spec['selections'].items():
        start = sources['lib/ffi.js'].index(selector['start'])
        selected = sources['lib/ffi.js'][start:start + selector['length']]
        if hashlib.sha256(selected.encode()).hexdigest() != selector['sha256']:
            raise ValueError('FFI selected source identity mismatch: ' + name)
        marker = '/* NODE_FFI_' + name.upper() + ' */'
        if adapter.count(marker) != 1:
            raise ValueError('Missing or ambiguous FFI source marker: ' + name)
        adapter = adapter.replace(marker, selected)
    return adapter


if __name__ == '__main__':
    print(render())
