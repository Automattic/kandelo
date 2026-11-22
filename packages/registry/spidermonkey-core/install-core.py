#!/usr/bin/env python3
"""Install actual static engine archives and relocatable embedding metadata."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def install(obj, output, source, patch_receipt):
    provenance = json.loads(patch_receipt.read_text())
    if provenance.get('sourceReady') is not True or provenance.get('failed'):
        raise ValueError('engine source patch pass did not succeed')
    if (obj / 'dist/bin/js').exists() or (obj / 'dist/bin/js.wasm').exists():
        raise ValueError('shell executable in a shell-free engine build')
    config = json.loads((obj / 'mozinfo.json').read_text())
    # The producer's additional whole-file patches also affect the actual
    # engine. Record their exact inputs and post-patch source identities.
    own_patches = []
    for patch in sorted((Path(__file__).parent / 'patches').glob('*.patch')):
        names = re.findall(r'^\+\+\+ b/([^\n]+)$', patch.read_text(), re.M)
        if not names or any(Path(n).is_absolute() or '..' in Path(n).parts for n in names):
            raise ValueError('invalid producer engine source patch: ' + patch.name)
        own_patches.append({
            'patch': patch.name, 'sha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
            'files': [{'path': name, 'sha256': hashlib.sha256((source / name).read_bytes()).hexdigest()}
                      for name in names]})
    # The compile-time configuration, not this installer, selects the engine.
    header = obj / 'js/src/js-config.h'
    if not header.is_file() or '#define JS_NUNBOX32 1' not in header.read_text():
        raise ValueError('engine build did not generate the required 32-bit value layout')
    archives = [(obj / 'js/src/build/libjs_static.a', 'lib/libmozjs-153.a'),
                (obj / 'wasm32-unknown-unknown/release/libjsrust.a', 'lib/libjsrust.a')]
    records = []
    for src, relative in archives:
        if not src.is_file() or src.is_symlink():
            raise ValueError('missing actual engine archive: ' + str(src))
        with src.open('rb') as stream:
            if stream.read(8) != b'!<arch>\n':
                raise ValueError('engine SDK requires a regular self-contained archive: ' + str(src))
        listing = subprocess.run(['wasm32posix-ar', 't', str(src)], capture_output=True, text=True, check=True)
        if not listing.stdout.strip():
            raise ValueError('empty engine archive: ' + str(src))
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        records.append({'path': relative, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    # Upstream static install names the archive libjs.a. Keep the one public
    # mozjs name advertised by its original pkg-config template instead.
    old = output / 'lib/libjs.a'
    if old.exists():
        if hashlib.sha256(old.read_bytes()).hexdigest() != records[0]['sha256']:
            raise ValueError('unexpected second engine library from upstream install')
        old.unlink()
    pc = output / 'lib/pkgconfig/mozjs-153.pc'
    text = pc.read_text()
    for key, value in [('prefix', '${pcfiledir}/../..'), ('exec_prefix', '${prefix}'),
                       ('libdir', '${prefix}/lib'), ('includedir', '${prefix}/include')]:
        text, count = re.subn(r'^' + key + r'=.*$', key + '=' + value, text, count=1, flags=re.M)
        if count != 1:
            raise ValueError('missing upstream engine pkg-config directory: ' + key)
    if 'Libs: -L${libdir} -lmozjs-153' not in text:
        raise ValueError('unrecognized upstream engine pkg-config metadata')
    # Public rooting/profiler headers use Mozilla's Unix selector. The target
    # profile is POSIX Kandelo; this does not claim Linux compatibility.
    cflags = 'Cflags: -isystem ${includedir}/mozjs-153'
    if text.count(cflags) != 1:
        raise ValueError('unrecognized upstream engine pkg-config compiler flags')
    text = text.replace(cflags, cflags + ' -DXP_UNIX=1 -D__kandelo__=1')
    # These are static link dependencies, not additional runtime services.
    text += 'Libs.private: -ljsrust -lv8-tracing -luv -lc++ -lc++abi -lpthread -lm\n'
    pc.write_text(text)
    license_path = output / 'share/doc/spidermonkey-core/LICENSE'
    license_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / 'LICENSE', license_path)
    # A source-level engine adapter uses private headers. Export the actual
    # compiled source/generated closure, pinned to these archives, rather than
    # configuring a second engine with potentially different layouts/macros.
    private = output / 'include/mozjs-153/internal'
    private_records = {}
    for origin, tree in [('source', source / 'js/src'), ('generated', obj / 'js/src')]:
        for path in sorted(tree.rglob('*')):
            if not path.is_file() or path.suffix not in ('.h', '.inc', '.msg'):
                continue
            relative = path.relative_to(tree)
            if relative.parts[0] == 'shell':
                continue
            data = path.read_bytes()
            target = private / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            private_records[str(relative)] = {
                'path': str(relative), 'sha256': hashlib.sha256(data).hexdigest(),
                'origin': origin}
    if 'js-confdefs.h' not in private_records:
        raise ValueError('missing actual generated private engine configuration')
    private_manifest = output / 'share/kandelo/spidermonkey-private-headers.json'
    private_manifest.parent.mkdir(parents=True, exist_ok=True)
    private_manifest.write_text(json.dumps({
        'schema': 1, 'engineVersion': '153.7.0esr', 'programAbi': 56,
        'sourceArchiveSha256': provenance['sourceArchiveSha256'],
        'engineLibraries': records, 'headers': list(private_records.values()),
        'includeDirectory': 'include/mozjs-153/internal',
        'configurationHeader': 'js-confdefs.h',
        'compilerContract': 'same source/generated headers and definitions as these static archives',
    }, indent=2) + '\n')
    identity = output / 'share/kandelo/spidermonkey-core.json'
    identity.parent.mkdir(parents=True, exist_ok=True)
    identity.write_text(json.dumps({'schema': 1, 'engine': 'SpiderMonkey',
                                   'engineVersion': '153.7.0esr', 'programAbi': 56,
                                   'target': 'wasm32-unknown-kandelo', 'shellIncluded': False,
                                   'sourceArchiveSha256': '7f8715ee7de2cf36a156216a9b1c7f26d1653010e65793bb2fce66e12edb6ea0',
                                   'libraries': records, 'buildInfo': config,
                                   'patches': provenance,
                                   'producerPatches': own_patches,
                                   'privateHeaderManifest': 'share/kandelo/spidermonkey-private-headers.json',
                                   'privateHeaderManifestSha256': hashlib.sha256(private_manifest.read_bytes()).hexdigest(),
                                   'nodeBridgeIncluded': False,
                                   'nodeRuntimeQualified': False}, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--object', dest='obj', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--patch-receipt', type=Path, required=True)
    args = parser.parse_args()
    install(args.obj, args.output, args.source, args.patch_receipt)
