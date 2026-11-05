#!/usr/bin/env python3
"""Render pinned libuv error data; compiling it selects actual target errnos."""
from pathlib import Path
import argparse, hashlib, json

def render(root):
    spec = json.loads((root / 'sources.json').read_text())['uvErrorPlatform']
    for item in spec['sources'].values():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('UV error source identity mismatch: ' + item['path'])
    raw = (root / spec['sources']['uv-header']['path']).read_text()
    selected = spec['errorMap']
    start = raw.index(selected['start'])
    section = raw[start:start + selected['length']]
    if hashlib.sha256(section.encode()).hexdigest() != selected['sha256']:
        raise ValueError('UV error macro selection mismatch')
    return '''// Generated from pinned Node-vendored libuv headers; no libuv runtime ABI.
// The upstream headers' license is retained under upstream/uv-errors and
// licenses/libuv.txt. Compile with the actual guest/host errno definitions.
#ifndef KANDELO_NODE_UV_ERROR_TABLE_H
#define KANDELO_NODE_UV_ERROR_TABLE_H
#include "kandelo-node-uv-errno.h"
''' + section + '''

namespace kandelo::errors {
struct Entry { int number; const char* name; const char* message; };
inline constexpr Entry entries[] = {
#define XX(code, message) {UV__##code, #code, message},
  UV_ERRNO_MAP(XX)
#undef XX
};
}
#undef UV_ERRNO_MAP
#endif
'''

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    text = render(Path(__file__).resolve().parent)
    if args.check:
        if args.output.read_text() != text:
            raise SystemExit('Generated UV error table is stale')
    else:
        args.output.write_text(text)
