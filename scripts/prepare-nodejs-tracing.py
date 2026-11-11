#!/usr/bin/env python3
"""Stage whole, authenticated Node tracing units and their native declarations."""
import argparse
import hashlib
import json
from pathlib import Path


def prepare(manifest, output):
    document = json.loads(manifest.read_text())
    records = {row['path']: row for row in document['files']}
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside immutable import')
    names = sorted(name for name in records if name.startswith('src/tracing/'))
    names += ['src/node_mutex.h', 'src/node_version.h', 'src/node_trace_events.cc']
    for name in names:
        data = (manifest.parent / 'upstream' / name).read_bytes()
        record = records[name]
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('native tracing source identity mismatch: ' + name)
        destination = output / name.removeprefix('src/')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)

    # Only declarations/primitive adapters are supplied by the embedding. All
    # agent, buffering, writer, path expansion and serializer bodies stay whole.
    include = '#include "shell/node-upstream/trace-agent-native-api.h"\n'
    for name in ['node.h', 'node_internals.h', 'util.h', 'util-inl.h',
                 'env-inl.h', 'debug_utils-inl.h', 'node_metadata.h', 'node_options.h']:
        (output / name).write_text(include)
    return {'completeNativeFiles': len(names), 'functionBodiesExtracted': False,
            'javascriptGenerated': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(prepare(arguments.manifest, arguments.output)))
