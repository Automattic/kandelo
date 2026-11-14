#!/usr/bin/env python3
"""CC-01 combined PHP/helper O3, alone and with VM-10 small fusion."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_manifest(folder):
    path = Path(folder).resolve() / 'manifest.json'
    manifest = json.loads(path.read_text())
    for variant in manifest['variants'].values():
        for a in variant['artifacts'].values():
            if sha(a['path']) != a['sha256']:
                raise ValueError(f'input artifact changed: {a["path"]}')
    return path, manifest


out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
php_path, php = read_manifest('.scratch/common-memory-survey-php-c-o3-1')
helper_path, helpers = read_manifest('.scratch/common-memory-survey-helper-o3-1')
fusion_path, fusion = read_manifest('.scratch/common-memory-survey-fused-1')
for m in [helpers, fusion]:
    for kind, a in php['variants']['baseline']['artifacts'].items():
        if m['variants']['baseline']['artifacts'][kind]['sha256'] != a['sha256']:
            raise ValueError(f'baseline module mismatch: {kind}')
helper = helpers['helpers']['helper-o3']
native = php['nativeArtifacts']['php-c-o3']
for a in [helper, *php['nativeArtifacts'].values()]:
    if sha(a['path']) != a['sha256']:
        raise ValueError('helper/native input changed')
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
subprocess.run(['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host], check=True)
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
helper_sources = helpers['sources']
sources = {
    'fpm': Path(native['path']),
    'canary': Path('.scratch/common-memory-program-outlined-3/canary-native.wasm').resolve(),
    'access': Path('.scratch/common-memory-program-outlined-3/access-native.wasm').resolve(),
    'fork': Path('.scratch/common-memory-shared-fork-3/shared-fork.native.wasm').resolve(),
    'bounds': Path('.scratch/common-memory-survey-helper-o3-1/bounds-native.wasm').resolve(),
}
for kind, path in sources.items():
    if kind != 'fpm' and sha(path) != helper_sources[str(path)]:
        raise ValueError(f'original mechanism input changed: {kind}')
manifest = {
    'scope': 'PHP C-O3 plus helper O3, alone against original and small-fusion combination against exact fusion-only control; no other compiler passes',
    'sources': {str(p): sha(p) for p in [Path(__file__).resolve(), php_path, helper_path, fusion_path,
                                          Path('tools/common-memory-program/instrument/src/main.rs').resolve(), *sources.values()]},
    'helper': helper,
    'variants': {'baseline': php['variants']['baseline'], 'fuse-small': fusion['variants']['fuse-small']},
    'nativeArtifacts': {'baseline': php['nativeArtifacts']['baseline'], 'fuse-small': php['nativeArtifacts']['baseline']},
    'pairReferences': {'both-o3': 'baseline', 'both-o3-fused': 'fuse-small'},
    'runs': [],
}


def save():
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


for mode, fused in [('both-o3', False), ('both-o3-fused', True)]:
    artifacts = {}
    manifest['variants'][mode] = {'ids': ['CC-01', *(['VM-10'] if fused else [])], 'artifacts': artifacts}
    manifest['nativeArtifacts'][mode] = native
    for kind, source in sources.items():
        if not fused and kind != 'fpm':
            artifacts[kind] = helpers['variants']['helper-o3']['artifacts'][kind]
            continue
        target = out / f'{kind}-{mode}.wasm'
        args = [str(instrument), str(source), helper['path'], str(target), '--outline-accesses', *(['--fuse-scalars=small'] if fused else [])]
        run = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (out / f'{kind}-{mode}.json').write_text(run.stdout)
        (out / f'{kind}-{mode}.log').write_text(run.stderr)
        manifest['runs'].append({'kind': kind, 'mode': mode, 'args': args, 'exit': run.returncode})
        save()
        run.check_returncode()
        artifacts[kind] = {'path': str(target), 'sha256': sha(target), 'bytes': target.stat().st_size}
        save()
save()
print(json.dumps({'output': str(out), 'pairs': manifest['pairReferences'], 'fpm': {m: v['artifacts']['fpm'] for m, v in manifest['variants'].items()}}))
