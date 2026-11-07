#!/usr/bin/env python3
"""Derive JS and native stream-state indices from the exact pinned Node enum."""
from pathlib import Path
import argparse
import hashlib
import json
import re

root = Path(__file__).resolve().parent

def render():
    spec = json.loads((root / 'socket-owner-sources.json').read_text())
    target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
    if (spec['nodeVersion'], spec['nodeCommit']) != (target['version'], target['source']['commit']):
        raise ValueError('Socket state and public target identity mismatch')
    references = {}
    for name, item in spec['nativeReferences'].items():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('Socket native reference identity mismatch: ' + name)
        references[name] = raw.decode()
    source = references[spec['streamState']['source']]
    body = source.split('enum StreamBaseStateFields {', 1)[1].split('};', 1)[0]
    fields = [entry.strip() for entry in body.split(',')]
    if fields != spec['streamState']['fields'] or any(not re.fullmatch(r'k\w+', field) for field in fields):
        raise ValueError('Review the actual native stream-state layout')
    header = ('// Generated from pinned Node StreamBaseStateFields; do not edit.\n'
              '#ifndef KANDELO_NODE_SOCKET_STREAM_STATE_H_\n'
              '#define KANDELO_NODE_SOCKET_STREAM_STATE_H_\n'
              '#include <cstddef>\n'
              'namespace kandelo::socket::state {\n'
              'enum StreamBaseStateFields : size_t {\n')
    header += ''.join('  ' + name + ' = ' + str(i) + ',\n' for i, name in enumerate(fields))
    header += '};\n}  // namespace kandelo::socket::state\n#endif\n'
    javascript = 'const ' + ', '.join(name + ' = ' + str(i) for i, name in enumerate(fields[:-1])) + ';\n'
    javascript += '    const streamBaseState = new Int32Array(' + str(len(fields) - 1) + ');'
    return {'fields': dict(zip(fields, range(len(fields)))), 'header': header, 'javascript': javascript}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    output = root / 'socket-stream-state.h'
    expected = render()['header']
    if args.check:
        if output.read_text() != expected:
            raise SystemExit('Regenerate the pinned socket stream-state header')
    else:
        output.write_text(expected)
