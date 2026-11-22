#!/usr/bin/env python3
"""Stage pinned portable profiler contracts and scalar GC callback metadata.

The whole profiler header is retained with only its engine include boundary
adapted. GC enums/callback aliases are complete data/type declarations, not
function excerpts or a replacement collector/profiler implementation.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def prepare(manifest, output):
    doc = json.loads(manifest.read_text())
    if doc['version'] != '26.13.0' or doc['source']['sha256'] != '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191':
        raise ValueError('review profiler contracts before updating Node')
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output cannot modify the immutable source import')
    records = {row['path']: row for row in doc['files']}
    sources = []

    def read(name):
        data = (manifest.parent / 'upstream' / name).read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        row = records[name]
        if row['bytes'] != len(data) or row['sha256'] != sha:
            raise ValueError('profiler source identity mismatch: ' + name)
        sources.append({'path': name, 'sha256': sha})
        return data

    raw = read('deps/v8/include/v8-profiler.h')
    common = read('deps/v8/include/cppgc/common.h')
    callbacks = read('deps/v8/include/v8-callbacks.h')
    includes = b''.join(line for line in raw.splitlines(keepends=True)
                        if line.startswith((b'#include "cppgc/', b'#include "v8-')))
    expected = [b'cppgc/common.h', b'v8-local-handle.h', b'v8-message.h',
                b'v8-persistent-handle.h']
    if [line.split(b'"')[1] for line in includes.splitlines()] != expected or raw.count(includes) != 1:
        raise ValueError('review changed profiler includes')
    replacement = b'#include "../engine-native-api.h"\n#include "cppgc/common.h"\n'
    staged = raw.replace(includes, replacement, 1)
    if staged.replace(replacement, includes, 1) != raw:
        raise ValueError('profiler header body changed')
    target = output / 'v8-source-api/v8-profiler.h'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(staged)
    target = output / 'v8-source-api/cppgc/common.h'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(common)
    declarations = []
    for name in ['GCType', 'GCCallbackFlags']:
        matches = re.findall(rb'^enum ' + name.encode() + rb' \{.*?^\};', callbacks, re.M | re.S)
        if len(matches) != 1:
            raise ValueError('review changed GC enum: ' + name)
        declarations.append(matches[0])
    for name in ['GCCallback', 'NearHeapLimitCallback']:
        matches = re.findall(rb'^using ' + name.encode() + rb'\s*=.*?;', callbacks, re.M | re.S)
        if len(matches) != 1:
            raise ValueError('review changed GC callback alias: ' + name)
        declarations.append(matches[0])
    scalar = (b'#pragma once\n#include <cstddef>\n'
              b'// Complete pinned GC enums and callback type declarations.\n'
              b'namespace v8 {\n' + b'\n'.join(declarations) + b'\n}\n')
    (output / 'engine-gc-callback-api.h').write_bytes(scalar)
    return {'sources': sources, 'wholeProfilerHeaderBodyUnchanged': True,
            'headerSha256': hashlib.sha256(staged).hexdigest(),
            'scalarMetadataSha256': hashlib.sha256(scalar).hexdigest(),
            'completeScalarDeclarations': ['GCType', 'GCCallbackFlags', 'GCCallback', 'NearHeapLimitCallback'],
            'engineIncludesReplaced': [n.decode() for n in expected],
            'functionBodiesExtracted': False, 'collectorImplementationImported': False,
            'profilerBackendImplemented': False, 'runtimeQualified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.output)))
