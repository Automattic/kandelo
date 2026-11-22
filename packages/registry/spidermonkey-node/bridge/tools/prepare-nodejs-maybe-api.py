#!/usr/bin/env python3
"""Reuse the whole pinned Maybe and portable stack/type-trait headers."""
import argparse
import hashlib
import json
from pathlib import Path


def prepare(manifest, output):
    document = json.loads(manifest.read_text())
    if document['version'] != '26.13.0' or document['source']['sha256'] != '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191':
        raise ValueError('review Maybe source before changing Node')
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('cannot modify the raw Node source import')
    records = {row['path']: row for row in document['files']}
    files = {
        'v8-maybe.h': [(b'#include "v8-internal.h"  // NOLINT(build/include_directory)\n',
                        b'// Maybe is independent of V8 heap/layout internals.\n')],
        'cppgc/internal/conditional-stack-allocated.h': [
            (b'"cppgc/macros.h"', b'"../macros.h"'),
            (b'"cppgc/type-traits.h"', b'"../type-traits.h"')],
        'cppgc/macros.h': [(b'"cppgc/internal/compiler-specific.h"', b'"internal/compiler-specific.h"')],
        'cppgc/type-traits.h': [],
        'cppgc/internal/compiler-specific.h': [],
    }
    sources = []
    for relative, replacements in files.items():
        name = 'deps/v8/include/' + relative
        raw = (manifest.parent / 'upstream' / name).read_bytes()
        row = records[name]
        if len(raw) != row['bytes'] or hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise ValueError('raw source changed: ' + name)
        staged = raw
        for before, after in replacements:
            if staged.count(before) != 1:
                raise ValueError('review changed include edge: ' + name)
            staged = staged.replace(before, after, 1)
        restored = staged
        for before, after in reversed(replacements):
            restored = restored.replace(after, before, 1)
        if restored != raw:
            raise ValueError('original whole header is not recoverable: ' + name)
        target = output / 'v8-source-api' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(staged)
        sources.append({'path': name, 'rawSha256': row['sha256'],
                        'projectedPath': str(target.relative_to(output)),
                        'projectedSha256': hashlib.sha256(staged).hexdigest(),
                        'includeEdgesChanged': len(replacements)})
    return {'sources': sources, 'wholeOriginalHeadersRecoverable': True,
            'allOriginalAlgorithmBodiesUnchanged': True,
            'collectorOrV8HeapImplementationImported': False,
            'configurationProvider': 'existing declared v8-tracing/v8config.h',
            'runtimeQualified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.output)))
