#!/usr/bin/env python3
"""CC-01: pair original PHP C-O2 with a private normal-recipe C-O3 build.

Translation helpers stay O2. Non-PHP probes are exact baseline controls;
actual FPM fork/shared-OPcache checks exercise the newly compiled program.
"""
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
old_build = Path('.scratch/common-memory-php-shared-build-1').resolve()
old_receipt = json.loads((old_build / 'build-inputs.json').read_text())
if not receipt['complete'] or receipt['phpCOptimization'] != 'O3':
    raise ValueError('requires completed declared PHP C-O3 build')
for key in ['normalRecipeSha256', 'phpVersion', 'dependencies', 'head']:
    if receipt[key] != old_receipt[key]:
        raise ValueError(f'build control differs: {key}')
baseline_manifest = Path('.scratch/common-memory-survey-helper-o3-1/manifest.json').resolve()
baseline = json.loads(baseline_manifest.read_text())
helper = baseline['helpers']['baseline']
if sha(helper['path']) != helper['sha256']:
    raise ValueError('helper changed')
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
subprocess.run(['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host], check=True)
native = build / 'out/php-fpm.wasm'
if sha(native) != receipt['artifacts']['php-fpm.wasm']['sha256']:
    raise ValueError('new FPM does not match final stamped build receipt')
target = out / 'fpm-php-c-o3.wasm'
args = [str(instrument), str(native), helper['path'], str(target), '--outline-accesses']
run = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
(out / 'fpm-php-c-o3.json').write_text(run.stdout)
(out / 'fpm-php-c-o3.log').write_text(run.stderr)
(out / 'commands.json').write_text(json.dumps([{'args': args, 'exit': run.returncode}], indent=2) + '\n')
run.check_returncode()
artifacts = {**baseline['variants']['baseline']['artifacts'], 'fpm': artifact(target)}
for mode, v in baseline['variants'].items():
    if mode == 'baseline':
        for kind, a in v['artifacts'].items():
            if sha(a['path']) != a['sha256']:
                raise ValueError(f'baseline changed: {kind}')
manifest = {
    'scope': 'PHP C translation units O3 only; dependencies/C++/pre-fork Binaryen/fork preparation and outlined O2 helpers unchanged',
    'sources': {str(p): sha(p) for p in [Path(__file__).resolve(), build / 'build-inputs.json', old_build / 'build-inputs.json', baseline_manifest,
                                          Path('tools/common-memory-program/helpers.c').resolve(), Path('tools/common-memory-program/instrument/src/main.rs').resolve()]},
    'helper': helper, 'nonPhpProbesAreIdenticalControls': True,
    'variants': {'baseline': baseline['variants']['baseline'], 'php-c-o3': {'ids': ['CC-01'], 'artifacts': artifacts}},
    'nativeArtifacts': {'baseline': artifact(old_build / 'out/php-fpm.wasm'), 'php-c-o3': artifact(native)},
    'pairReferences': {'php-c-o3': 'baseline'},
}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'output': str(out), 'nativeArtifacts': manifest['nativeArtifacts'], 'virtualized': artifact(target)}))
