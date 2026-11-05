#!/usr/bin/env python3
"""Reviewable codec source selection from an authenticated Node release tree."""
from pathlib import Path
import argparse
import ast
import hashlib
import json
import re
import tomllib


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate(source, target):
    recipe = tomllib.loads((Path(__file__).parent / 'package.toml').read_text())
    if (recipe['version'], recipe['source']['url'], recipe['source']['sha256']) != (
            target['version'], target['source']['url'], target['source']['sha256']):
        raise ValueError('Codec recipe and Node API target must have the same source pin')
    versions = (source / 'src/node_version.h').read_text()
    actual = '.'.join(re.search(rf'^#define NODE_{name}_VERSION\s+(\d+)$', versions, re.M)[1]
                      for name in ['MAJOR', 'MINOR', 'PATCH'])
    if actual != recipe['version']:
        raise ValueError('Node source tree version differs from the recipe')
    gn_path = 'deps/zlib/BUILD.gn'
    gyp_paths = ['deps/zlib/zlib.gyp', 'deps/brotli/brotli.gyp', 'deps/zstd/zstd.gyp']
    gyp = {p: ast.literal_eval((source / p).read_text()) for p in gyp_paths}
    gn = (source / gn_path).read_text()
    block = gn.split('component("zlib") {', 1)[1].split('sources = [', 1)[1].split(']', 1)[0]
    zlib_units = re.findall(r'"([^"]+\.c)"', block)
    target_zlib = next(x for x in gyp[gyp_paths[0]]['conditions'][0][1]['targets']
                       if x['target_name'] == 'zlib')
    # Use Node's generic CPU branch, rather than x86/ARM instruction selection.
    fallbacks = [condition[2] for condition in target_zlib['conditions']
                 if len(condition) == 3 and 'CPU_NO_SIMD' in condition[2].get('defines', [])]
    if len(fallbacks) != 1:
        raise ValueError('Review Node zlib generic CPU selection')
    zlib_units += [s.removeprefix('<(ZLIB_ROOT)/') for s in fallbacks[0]['sources']
                   if s.endswith('.c')]
    families = [
        {'id': 'zlib', 'version': re.search(r'^#define ZLIB_VERSION "([^"]+)"',
             (source / 'deps/zlib/zlib.h').read_text(), re.M)[1],
         'root': 'deps/zlib', 'archive': 'libz.a', 'includeDirs': ['deps/zlib'],
         'flags': ['-DCPU_NO_SIMD', '-DHAVE_HIDDEN'], 'units': zlib_units},
        {'id': 'brotli', 'version': '.'.join(re.search(rf'^#define BROTLI_VERSION_{part}\s+(\d+)$',
             (source / 'deps/brotli/c/common/version.h').read_text(), re.M)[1]
             for part in ['MAJOR', 'MINOR', 'PATCH']),
         'root': 'deps/brotli', 'archive': 'libbrotli.a',
         'includeDirs': ['deps/brotli/c/include'], 'flags': [],
         'units': gyp[gyp_paths[1]]['variables']['brotli_sources']},
        {'id': 'zstd', 'version': '.'.join(re.search(rf'^#define ZSTD_VERSION_{part}\s+(\d+)$',
             (source / 'deps/zstd/lib/zstd.h').read_text(), re.M)[1]
             for part in ['MAJOR', 'MINOR', 'RELEASE']),
         'root': 'deps/zstd', 'archive': 'libzstd.a', 'includeDirs': ['deps/zstd/lib'],
         'flags': ['-D' + define for define in gyp[gyp_paths[2]]['targets'][0]['defines']] + ['-pthread'],
         'units': gyp[gyp_paths[2]]['variables']['zstd_sources']},
    ]
    for family in families:
        paths = [family['root'] + '/' + p for p in family.pop('units')]
        if len(set(paths)) != len(paths) or not paths:
            raise ValueError('Duplicate/empty translation-unit selection')
        family['sources'] = [{'path': p, 'sha256': digest(source / p)} for p in paths]
    copies = [
        ('deps/zlib/zlib.h', 'include/zlib.h'),
        ('deps/zlib/zconf.h', 'include/zconf.h'),
        ('deps/zstd/lib/zstd.h', 'include/zstd.h'),
        ('deps/zstd/lib/zstd_errors.h', 'include/zstd_errors.h'),
        ('LICENSE', 'share/licenses/node-codecs/Node-LICENSE'),
        ('deps/zlib/LICENSE', 'share/licenses/node-codecs/zlib-LICENSE'),
        ('deps/brotli/LICENSE', 'share/licenses/node-codecs/brotli-LICENSE'),
        ('deps/zstd/LICENSE', 'share/licenses/node-codecs/zstd-LICENSE'),
    ]
    for p in sorted((source / 'deps/brotli/c/include/brotli').glob('*.h')):
        copies.append((str(p.relative_to(source)), 'include/brotli/' + p.name))
    return {
        'schema': 1, 'nodeVersion': recipe['version'],
        'nodeSourceCommit': target['source']['commit'], 'source': recipe['source'],
        'selectionInputs': {p: digest(source / p) for p in ['src/node_version.h', gn_path, *gyp_paths]},
        'families': families,
        # Bind private include files as well as translation units; an edited
        # private header must not silently enter a nominally unchanged build.
        'inputFiles': {str(p.relative_to(source)): digest(p)
                       for root in ['deps/zlib', 'deps/brotli/c', 'deps/zstd/lib']
                       for p in sorted((source / root).rglob('*'))
                       if p.is_file() and p.suffix in ['.c', '.h', '.inc']},
        'copies': [{'source': src, 'destination': dst, 'sha256': digest(source / src)}
                   for src, dst in copies],
        'policy': 'Unchanged upstream C algorithms; Node generic zlib CPU branch and Node Brotli/Zstd source lists. No host target-layout helper, platform identity define or replacement codec.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('sources.json'))
    args = parser.parse_args()
    result = generate(args.source, json.loads(args.target.read_text()))
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print('Pinned codec sources:', ', '.join(f"{f['id']}={len(f['sources'])}" for f in result['families']))
