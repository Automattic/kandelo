#!/usr/bin/env python3
"""Stage complete native constants sources; derive compression declaration metadata."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def prepare(manifest, output, zlib_include, zstd_include):
    document = json.loads(manifest.read_text())
    records = {r['path']: r for r in document['files']}
    identities = {}
    def verified(name):
        data = (manifest.parent / 'upstream' / name).read_bytes()
        r = records[name]
        if len(data) != r['bytes'] or hashlib.sha256(data).hexdigest() != r['sha256']:
            raise ValueError('native declaration identity mismatch: ' + name)
        identities[name] = r['sha256']
        return data
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside immutable imported sources')
    output.mkdir(parents=True, exist_ok=True)
    for name in ['src/node_constants.cc', 'src/node_constants.h']:
        (output / Path(name).name).write_bytes(verified(name))
    (output / 'trace_event_legacy.h').write_bytes(verified('src/tracing/trace_event_legacy.h'))
    for name in ['decode.h', 'encode.h', 'port.h', 'shared_dictionary.h', 'types.h']:
        path = output / 'include/brotli' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(verified('deps/brotli/c/include/brotli/' + name))
    target_headers = []
    # Quote includes beside the generated metadata and original .cc take
    # precedence over Mozilla's bundled compression headers for this binding.
    for directory, names in [(zlib_include, ['zlib.h', 'zconf.h']),
                             (zstd_include, ['zstd.h', 'zstd_errors.h'])]:
        for name in names:
            path = directory / name
            data = path.read_bytes()
            (output / name).write_bytes(data)
            target_headers.append({'path': str(path), 'bytes': len(data),
                                   'sha256': hashlib.sha256(data).hexdigest()})
    # These are API declaration operands, not compression functions/algorithms
    # or reference values. The target compiler evaluates each actual header.
    text = verified('src/node_zlib.cc').decode()
    names = re.findall(r'\bNODE_DEFINE_CONSTANT\(target,\s*([A-Za-z0-9_]+)\s*\)', text)
    if not names or len(names) != len(set(names)):
        raise ValueError('unreviewed compression constant inventory')
    declarations = re.search(r'enum node_zlib_mode\s*\{([^}]+)\}', text)
    modes = [x.strip() for x in declarations[1].split(',') if x.strip()]
    if not all(re.fullmatch(r'[A-Z][A-Z0-9_]*', x) for x in modes):
        raise ValueError('unreviewed compression mode enum grammar')
    limits = re.findall(r'^#define (Z_(?:MIN|MAX|DEFAULT)_[A-Z]+) ([^\n]+)$', text, re.M)
    if len(limits) != 12 or set(n for n, v in limits) - set(names):
        raise ValueError('unreviewed compression limits')
    # Require the entire export declaration to contain only these declarations,
    # comments and whitespace. Unknown upstream behavior must stop generation.
    function = re.search(r'void DefineZlibConstants\(Local<Object> target\) \{([^{}]*)\}', text)
    body = re.sub(r'//[^\n]*|/\*.*?\*/', '', function[1], flags=re.S)
    rest = re.sub(r'NODE_DEFINE_CONSTANT\(target,\s*[A-Za-z0-9_]+\s*\)\s*;', '', body)
    if rest.strip() or re.findall(r'NODE_DEFINE_CONSTANT\(target,\s*([A-Za-z0-9_]+)\s*\)', body) != names:
        raise ValueError('compression export declaration acquired executable policy')
    lines = ['// Generated API declaration metadata, evaluated by the guest compiler.',
             '#ifndef KANDELO_NODE_COMPRESSION_CONSTANTS_H', '#define KANDELO_NODE_COMPRESSION_CONSTANTS_H',
             '#include <brotli/decode.h>', '#include <brotli/encode.h>',
             '#include "zlib.h"', '#include "zstd.h"', '#include "zstd_errors.h"',
             '#include <limits>', 'namespace kandelo::node::compressionconstants {',
             'enum Mode { ' + ', '.join(modes) + ' };']
    lines += [f'#define {n} {value}' for n, value in limits]
    lines += ['struct Entry { const char* name; double value; };', 'inline const Entry kEntries[] = {']
    lines += [f'  {{"{name}", static_cast<double>({name})}},' for name in names]
    lines += ['};'] + ['#undef ' + n for n, value in limits]
    lines += ['}  // namespace kandelo::node::compressionconstants', '#endif', '']
    (output / 'compression-constants.generated.h').write_text('\n'.join(lines))
    for name in ['env-inl.h', 'node_internals.h', 'util-inl.h', 'node.h', 'v8.h', 'v8-local-handle.h']:
        (output / name).write_text('#include "shell/node-upstream/constants-builder.h"\n')
    return {'targetHeaders': target_headers, 'nativeSources': identities, 'compressionConstants': len(names),
            'modeDeclarations': len(modes), 'limits': len(limits), 'guestValuesExecutedOnHost': False,
            'originalConstantsTranslationUnitUnchanged': True, 'javascriptGenerated': False}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--zlib-include', required=True, type=Path)
    parser.add_argument('--zstd-include', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.output, args.zlib_include, args.zstd_include)))
