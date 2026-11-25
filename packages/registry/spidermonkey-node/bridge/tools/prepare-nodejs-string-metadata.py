#!/usr/bin/env python3
"""Preserve complete pinned String write flags without V8 heap dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def prepare(manifest, output):
    document = json.loads(manifest.read_text())
    if document['version'] != '26.13.0' or document['source']['sha256'] != '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191':
        raise ValueError('review String source before upgrading Node')
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('cannot modify raw upstream')
    name = 'deps/v8/include/v8-primitive.h'
    row = next(row for row in document['files'] if row['path'] == name)
    data = (manifest.parent / 'upstream' / name).read_bytes()
    if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
        raise ValueError('raw String header changed')
    found = re.findall(rb'^  struct WriteFlags \{.*?^  \};', data, re.M | re.S)
    if len(found) != 1:
        raise ValueError('review changed String WriteFlags declaration')
    declaration = found[0]
    generated = (b'#pragma once\nnamespace kandelo::node::stringapi {\n' + declaration + b'\n}\n')
    target = output / 'engine-string-flags.h'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(generated)
    return {'rawSource': name, 'rawSha256': row['sha256'],
            'completeScalarDeclaration': 'String::WriteFlags',
            'functionBodiesExtracted': False,
            'headerSha256': hashlib.sha256(generated).hexdigest(),
            'runtimeQualified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.output)))
