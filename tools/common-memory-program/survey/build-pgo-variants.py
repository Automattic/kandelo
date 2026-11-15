#!/usr/bin/env python3
"""CC-03 main-program PGO, individually and combined with small fusion."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def artifact(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size}


build, out = [Path(p).resolve() for p in sys.argv[1:3]]
out.mkdir(parents=True, exist_ok=False)
receipt = json.loads((build / 'build-inputs.json').read_text())
original_build = Path('.scratch/common-memory-php-shared-build-1').resolve()
old = json.loads((original_build / 'build-inputs.json').read_text())
if not (receipt['complete'] and receipt['programsOnly'] and receipt['phpCOptimization'] == 'O2' and receipt['phpCProfile']['mode'] == 'use'):
    raise ValueError('requires completed declared C-O2 main-program profile-use build')
for key in ['normalRecipeSha256', 'phpVersion', 'dependencies', 'head']:
    if receipt[key] != old[key]:
        raise ValueError(f'build control changed: {key}')
if sha(receipt['phpCProfile']['path']) != receipt['phpCProfile']['sha256']:
    raise ValueError('training profile changed')
controls = {}
for name in ['main/php_config.h', 'config.nice']:
    a = (original_build / 'work/source' / name).read_text().replace(str(original_build / 'work'), 'BUILD_WORK')
    b = (build / 'work/source' / name).read_text().replace(str(build / 'work'), 'BUILD_WORK')
    if a != b:
        raise ValueError(f'normal configure/header control differs: {name}')
    controls[name] = {'identicalAfterWorkPathNormalization': True}
control_path = Path('.scratch/common-memory-survey-fused-1/manifest.json').resolve()
control = json.loads(control_path.read_text())
helper_manifest_path = Path('.scratch/common-memory-survey-helper-o3-1/manifest.json').resolve()
helper_manifest = json.loads(helper_manifest_path.read_text())
helper = helper_manifest['helpers']['baseline']
if sha(helper['path']) != helper['sha256']:
    raise ValueError('O2 helper changed')
for mode in ['baseline', 'fuse-small']:
    for a in control['variants'][mode]['artifacts'].values():
        if sha(a['path']) != a['sha256']:
            raise ValueError('reference module changed')
for name in ['php.wasm', 'php-fpm.wasm']:
    if sha(build / 'out' / name) != receipt['artifacts'][name]['sha256']:
        raise ValueError('actual stamped PGO program does not match build receipt')
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
subprocess.run(['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host], check=True)
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
result = {
    'scope': 'PHP main C-O2 with WordPress/CLI PGO; helper O2; original dependencies/C++/image extensions unchanged; with/without small scalar fusion',
    'sources': {str(p): sha(p) for p in [Path(__file__).resolve(), build / 'build-inputs.json', control_path, helper_manifest_path,
                                          Path('tools/common-memory-program/instrument/src/main.rs').resolve()]},
    'helper': helper, 'trainingProfile': receipt['phpCProfile'], 'buildControls': controls,
    'variants': {m: control['variants'][m] for m in ['baseline', 'fuse-small']},
    'nativeArtifacts': {m: artifact(original_build / 'out/php-fpm.wasm') for m in ['baseline', 'fuse-small']},
    'nativeCli': artifact(build / 'out/php.wasm'),
    'pairReferences': {'php-pgo': 'baseline', 'php-pgo-fused': 'fuse-small'}, 'runs': [],
}


def save():
    (out / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')


for mode, reference, fused in [('php-pgo', 'baseline', False), ('php-pgo-fused', 'fuse-small', True)]:
    artifacts = {**control['variants'][reference]['artifacts']}
    result['variants'][mode] = {'ids': ['CC-03', *(['VM-10'] if fused else [])], 'artifacts': artifacts}
    result['nativeArtifacts'][mode] = artifact(build / 'out/php-fpm.wasm')
    for kind, source_name in [('fpm', 'php-fpm.wasm'), ('cli', 'php.wasm')]:
        target = out / f'{kind}-{mode}.wasm'
        args = [str(instrument), str(build / 'out' / source_name), helper['path'], str(target), '--outline-accesses', *(['--fuse-scalars=small'] if fused else [])]
        r = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (out / f'{kind}-{mode}.json').write_text(r.stdout)
        (out / f'{kind}-{mode}.log').write_text(r.stderr)
        result['runs'].append({'mode': mode, 'kind': kind, 'args': args, 'exit': r.returncode});save();r.check_returncode()
        artifacts[kind] = artifact(target);save()
save()
print(json.dumps({'output': str(out), 'pairs': result['pairReferences'], 'buildControls': controls, 'nativeArtifacts': result['nativeArtifacts']}))
