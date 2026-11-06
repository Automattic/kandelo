#!/usr/bin/env python3
"""Generate the copyFile adapter only after verifying its pinned identities."""
import hashlib
import json
from pathlib import Path


def generate(root):
    root = Path(root)
    manifest = json.loads((root / 'copy-file-sources.json').read_text())
    if manifest['target'] != 'Node.js v26.13.0' or manifest['sourceCommit'] != '18b32a3b1552e199a01f1a8d9fd64aa756d3b75b':
        raise ValueError('Review copyFile target identity')
    sources = {}
    for name, item in manifest['sources'].items():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('CopyFile reference identity mismatch: ' + name)
        sources[name] = raw.decode('utf8')
    sections = {}
    for name, item in manifest['selections'].items():
        source = sources[item['source']]
        if source.count(item['start']) != 1:
            raise ValueError('Ambiguous copyFile selection: ' + name)
        offset = source.index(item['start'])
        section = source[offset:offset + item['length']]
        if hashlib.sha256(section.encode()).hexdigest() != item['sha256']:
            raise ValueError('CopyFile section identity mismatch: ' + name)
        sections[name] = section
    error = sections.pop('shared-handleError')
    needle = '  ErrorCaptureStackTrace(error, handleErrorFromBinding);'
    if error.count(needle) != 1:
        raise ValueError('Review copyFile promise stack capture')
    error = error.replace(needle, '  if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(error, handleErrorFromBinding);')
    adapter = (root / 'copy-file-adapter.js').read_text()
    for marker, value in [
        ('/* NODE_COPY_FILE_SHARED */', '\n'.join([sections.pop('shared-makeCallback'), sections.pop('shared-vfsVoid'), error])),
        ('/* NODE_COPY_FILE_PUBLIC */', '\n'.join([sections.pop('public-callback'), sections.pop('public-sync')])),
        ('/* NODE_COPY_FILE_PROMISE */', sections.pop('promise-copyFile')),
    ]:
        if adapter.count(marker) != 1:
            raise ValueError('Review copyFile adapter marker: ' + marker)
        adapter = adapter.replace(marker, value)
    if sections:
        raise ValueError('Unused copyFile sections')
    return adapter


if __name__ == '__main__':
    print(generate(Path(__file__).resolve().parent), end='')
