#!/usr/bin/env python3
"""Validate real engine build inputs without certifying SDK or runtime completeness."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Missing regular engine input: ' + str(path))
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def relative_path(value):
    path = Path(value)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Engine input must use a contained relative path: ' + str(path))
    return path


def require(document, expected):
    for key, value in expected.items():
        if type(document.get(key)) is not type(value) or document.get(key) != value:
            raise ValueError(f'Engine identity mismatch for {key}: {document.get(key)!r}')


def prepare(args):
    core_path = args.core / 'share/kandelo/spidermonkey-core.json'
    bridge_path = args.bridge / 'share/kandelo/node-engine-bridge.json'
    core = json.loads(core_path.read_text())
    bridge = json.loads(bridge_path.read_text())
    common = {'schema': 1, 'engine': 'SpiderMonkey', 'engineVersion': '153.7.0esr',
              'target': 'wasm32-unknown-kandelo', 'programAbi': 56}
    require(core, {**common, 'shellIncluded': False,
                   'sourceArchiveSha256': '7f8715ee7de2cf36a156216a9b1c7f26d1653010e65793bb2fce66e12edb6ea0'})
    require(bridge, {**common, 'legacyFrontendIncluded': False, 'nodeVersion': '26.13.0',
                     'nodeSourceSha256': '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191'})
    if bridge['engineIdentitySha256'] != digest(core_path):
        raise ValueError('Bridge was built against a different engine')
    private_path = args.core / relative_path(core['privateHeaderManifest'])
    if digest(private_path) != core['privateHeaderManifestSha256']:
        raise ValueError('Engine header manifest changed')
    private = json.loads(private_path.read_text())
    if private['engineLibraries'] != core['libraries']:
        raise ValueError('Engine headers identify different archives')
    for row in private['headers']:
        header = args.core / relative_path(private['includeDirectory']) / relative_path(row['path'])
        if digest(header) != row['sha256']:
            raise ValueError('Engine header changed: ' + str(header))
    headers = []
    include = args.bridge / 'include/kandelo-node-engine'
    for row in bridge['sourceInterfaceHeaders']:
        header = include / relative_path(row['path'])
        if digest(header) != row['sha256']:
            raise ValueError('Bridge interface header changed: ' + str(header))
        headers.append({'path': str(header), 'sha256': row['sha256']})
    for row in bridge['sources']:
        header = include / relative_path(row['path'])
        if header.exists() and digest(header) != row['sha256']:
            raise ValueError('Bridge source header changed: ' + str(header))
    libraries = []
    for prefix, rows in [(args.core, core['libraries']), (args.bridge, [bridge['library']]),
                         (args.tracing, [{'path': 'lib/libv8-tracing.a'}])]:
        for row in rows:
            relative = relative_path(row['path'])
            actual = digest(prefix / relative)
            if row.get('sha256', actual) != actual or digest(args.sysroot / relative) != actual:
                raise ValueError('Engine archive or private overlay changed: ' + str(relative))
            libraries.append({'provider': str(prefix), 'path': str(relative), 'sha256': actual})
    for name in ['v8.h', 'engine-native-api.h']:
        if digest(include / name) != digest(args.sysroot / 'include/kandelo-node-engine' / name):
            raise ValueError('Private bridge header overlay changed: ' + name)
    for name in ['v8config.h', 'v8-platform.h']:
        if digest(args.tracing / 'include' / name) != digest(args.sysroot / 'include' / name):
            raise ValueError('Private platform header overlay changed: ' + name)
    args.output.mkdir(parents=True, exist_ok=False)
    # Node's original configure_v8 reads only -I/-L/-l from pkg-config. The
    # private sysroot contains byte-verified real archives, so one library path
    # suffices and system-header/define flags are supplied separately by CXXFLAGS.
    # Like the standalone engine, ArrayBuffer commits use the SDK's read/write
    # mprotect implementation. Restrictive requests still fail with ENOTSUP.
    pc = args.output / 'v8.pc'
    pc.write_text(f'''prefix={args.sysroot}
libdir=${{prefix}}/lib
includedir=${{prefix}}/include
Name: Kandelo SpiderMonkey source bridge for Node
Description: Actual incomplete engine integration inputs; no SDK/runtime certification
Version: 153.7.0
Libs: -L${{libdir}} -lkandelo-node-bridge -lmozjs-153 -ljsrust -lkandelo-mprotect -lv8-tracing -luv -lc++ -lc++abi -lpthread -lm
Cflags: -I${{includedir}}/kandelo-node-engine -I${{includedir}}/mozjs-153 -I${{includedir}}
''')
    # The declared libuv package installs the static pkg-config name; Node's
    # original configure requests the unsuffixed name even for static linkage.
    (args.output / 'libuv.pc').write_text('''Name: Node static libuv dependency
Description: Alias to the actual declared Kandelo libuv provider
Version: 1.52.1
Requires: libuv-static
''')
    receipt = {'schema': 1, 'engine': core['engine'], 'engineVersion': core['engineVersion'],
               'target': core['target'], 'programAbi': core['programAbi'],
               'core': str(args.core), 'bridge': str(args.bridge),
               'coreIdentitySha256': digest(core_path), 'bridgeIdentitySha256': digest(bridge_path),
               'libraries': libraries, 'interfaceHeaders': headers,
               'pkgConfigSha256': digest(pc), 'legacyFrontendIncluded': False,
               'producerSDKComplete': bridge['nodeSDKComplete'],
               'sdkCompletenessCertified': False, 'runtimeAcceptance': False,
               'remaining': bridge['remaining']}
    (args.output / 'node-engine-inputs.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'engineInputsVerified': True, 'sdkCompletenessCertified': False,
                      'configuration': str(args.output), 'remaining': bridge['remaining']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['core', 'bridge', 'tracing', 'sysroot', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    prepare(parser.parse_args())
