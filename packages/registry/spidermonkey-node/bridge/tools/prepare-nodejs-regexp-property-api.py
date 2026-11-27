#!/usr/bin/env python3
"""Preserve pinned portable RegExp API and complete property-filter declarations."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def prepare(manifest, output):
    document = json.loads(manifest.read_text())
    if document['version'] != '26.13.0' or document['source']['sha256'] != '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191':
        raise ValueError('review RegExp/property contracts before updating Node')
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('cannot modify raw source import')
    records = {row['path']: row for row in document['files']}
    sources = []

    def read(name):
        data = (manifest.parent / 'upstream' / name).read_bytes()
        row = records[name]
        digest = hashlib.sha256(data).hexdigest()
        if row['bytes'] != len(data) or row['sha256'] != digest:
            raise ValueError('raw source changed: ' + name)
        sources.append({'path': name, 'sha256': digest})
        return data

    original = read('deps/v8/include/v8-regexp.h')
    objects = read('deps/v8/include/v8-object.h')
    proxy = read('deps/v8/src/objects/js-proxy.h')
    includes = b''.join(line for line in original.splitlines(keepends=True)
                        if line.startswith(b'#include "v8-') or line.startswith(b'#include "v8config.h"'))
    if [line.split(b'"')[1] for line in includes.splitlines()] != [b'v8-local-handle.h', b'v8-object.h', b'v8config.h'] or original.count(includes) != 1:
        raise ValueError('review changed RegExp includes')
    replacement = b'#include "../engine-native-api.h"\n'
    public = b'class V8_EXPORT RegExp : public Object {\n public:\n'
    rooted = public + b'  using Object::Object;\n'
    if original.count(public) != 1:
        raise ValueError('review changed RegExp wrapper')
    staged = original.replace(includes, replacement, 1).replace(public, rooted, 1)
    if staged.replace(rooted, public, 1).replace(replacement, includes, 1) != original:
        raise ValueError('RegExp original source is not recoverable')
    target = output / 'v8-source-api/v8-regexp.h'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(staged)
    declarations = []
    for name in ['PropertyFilter', 'KeyCollectionMode', 'IndexFilter', 'KeyConversionMode']:
        found = re.findall(rb'^enum(?: class)? ' + name.encode() + rb'\s*\{.*?\};', objects, re.M | re.S)
        if len(found) != 1:
            raise ValueError('review changed property enum: ' + name)
        declarations.append(found[0])
    scalar = b'#pragma once\nnamespace v8 {\n' + b'\n'.join(declarations) + b'\n}\n'
    limits = re.findall(rb'^  static const int kMaxIterationLimit = [^;]+;', proxy, re.M)
    if len(limits) != 1:
        raise ValueError('review changed proxy prototype traversal limit')
    scalar += (b'namespace kandelo::node::property {\nstruct ProxyTraversalLimits {\n' +
               limits[0] + b'\n};\n}\n')
    (output / 'engine-property-enum-api.h').write_bytes(scalar)
    return {'sources': sources, 'wholeOriginalRegExpHeaderRecoverable': True,
            'originalMethodBodiesUnchanged': True, 'functionBodiesExtracted': False,
            'wrapperAdaptations': ['replace engine includes', 'inherit actual rooted Object constructors'],
            'headerSha256': hashlib.sha256(staged).hexdigest(),
            'propertyEnumHeaderSha256': hashlib.sha256(scalar).hexdigest(),
            'completeScalarDeclarations': ['PropertyFilter', 'KeyCollectionMode', 'IndexFilter', 'KeyConversionMode'],
            'runtimeQualified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.output)))
