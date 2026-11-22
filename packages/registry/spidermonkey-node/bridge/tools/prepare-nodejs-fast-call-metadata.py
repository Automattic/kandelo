#!/usr/bin/env python3
"""Stage the complete pinned portable fast-call header for the engine bridge.

Only its engine include boundary changes. Compile-time signature/type/flag
algorithms stay upstream; V8 heap layouts and machine-code execution do not enter
the bridge. The full raw headers remain unchanged in the verified source import.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(manifest, output):
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside the immutable Node import')
    doc = json.loads(manifest.read_text())
    if doc['version'] != '26.13.0' or doc['source']['sha256'] != '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191':
        raise ValueError('review the native metadata boundary before updating Node')
    records = {r['path']: r for r in doc['files']}
    sources = []

    def read(name):
        record = records[name]
        data = (manifest.parent / 'upstream' / name).read_bytes()
        if len(data) != record['bytes'] or digest(data) != record['sha256']:
            raise ValueError('fast-call source identity mismatch: ' + name)
        sources.append({'path': name, 'sha256': digest(data)})
        return data

    raw = read('deps/v8/include/v8-fast-api-calls.h')
    internal = read('deps/v8/include/v8-internal.h')
    tag_lines = re.findall(rb'^#define V8_EXTERNAL_POINTER_TAG_COUNT [0-9]+$',
                           internal, re.M)
    if len(tag_lines) != 1:
        raise ValueError('upstream external-pointer tag contract changed')
    # Keep the whole header and replace only the five engine-specific imports.
    # All required handle/value declarations come from the actual bridge.
    includes = b''.join(
        line for line in raw.splitlines(keepends=True)
        if line.startswith(b'#include "v8-') and
        not line.startswith(b'#include "v8config.h"'))
    expected = [b'v8-external.h', b'v8-internal.h', b'v8-local-handle.h',
                b'v8-typed-array.h', b'v8-value.h']
    if [line.split(b'"')[1] for line in includes.splitlines()] != expected:
        raise ValueError('review changed fast-call header dependencies')
    replacement = b'#include "../engine-native-api.h"\n'
    if raw.count(includes) != 1:
        raise ValueError('fast-call includes are no longer contiguous')
    staged = raw.replace(includes, replacement, 1)
    if staged.replace(replacement, includes, 1) != raw:
        raise ValueError('whole fast-call header body changed')
    target = output / 'v8-source-api/v8-fast-api-calls.h'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(staged)
    config = (b'#pragma once\n'
              b'// Original public API tag range; no V8 heap/sandbox layout.\n' +
              tag_lines[0] + b'\n')
    (output / 'engine-fast-call-config.h').write_bytes(config)
    return {'sources': sources, 'wholeHeaderBodiesUnchanged': True,
            'headerSha256': digest(staged), 'configurationSha256': digest(config),
            'engineIncludesReplaced': [n.decode() for n in expected],
            'machineCodeExecutionImported': False, 'runtimeQualified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.output)))
