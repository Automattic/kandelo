#!/usr/bin/env python3
"""Retain Node's native encoding parser, including fallback and C-string rules."""
import argparse
import hashlib
import json
from pathlib import Path


def render(root):
    manifest = json.loads((root / 'sources.json').read_text())
    target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
    if (manifest['version'], manifest['commit']) != (target['version'], target['source']['commit']):
        raise ValueError('Native encoding source and Node target differ')
    group = manifest['incrementalCrypto']
    def section(name):
        item = group['sections'][name]
        source = group['sources'][item['source']]
        raw = (root / source['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != source['sha256']:
            raise ValueError('Native encoding reference identity mismatch')
        text = raw.decode()
        if text.count(item['start']) != 1:
            raise ValueError('Ambiguous encoding selection: ' + name)
        offset = text.index(item['start']); value = text[offset:offset + item['length']]
        if hashlib.sha256(value.encode()).hexdigest() != item['sha256']:
            raise ValueError('Native encoding selection identity mismatch')
        return value
    return ('// Generated pinned Node encoding functions; license: LICENSE.\n'
            '#ifndef KANDELO_NODE_NATIVE_ENCODING_H\n#define KANDELO_NODE_NATIVE_ENCODING_H\n'
            '#include <cstring>\n#include <locale>\n'
            'namespace kandelo::encoding {\n' + section('nativeEncodingEnum') + '\n' +
            '\n'.join('inline ' + section(name) for name in ['lower', 'equal', 'nativeEncoding']) +
            '''
inline const char* EncodingName(encoding value) {
  switch (value) {
    case ASCII: return "ascii";
    case UTF8: return "utf8";
    case BASE64: return "base64";
    case UCS2: return "utf16le";
    case BINARY: return "latin1";
    case HEX: return "hex";
    case BASE64URL: return "base64url";
    case BUFFER: return "buffer";
  }
  return "buffer";
}
}
#endif
''')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(render(Path(__file__).resolve().parent))
