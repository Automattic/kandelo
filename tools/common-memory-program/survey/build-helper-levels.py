#!/usr/bin/env python3
"""CC-01: change only helper Clang O2/O3, retaining the original PHP build."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
llvm = Path(os.environ['LLVM_BIN'])
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
commands = []


def run(label, args, output=None):
    args = [str(a) for a in args]
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (out / (label + '.log')).write_text(result.stderr + ('' if output else result.stdout))
    if output:
        output.write_text(result.stdout)
    commands.append({'label': label, 'args': args, 'exit': result.returncode})
    (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
    if result.returncode:
        raise RuntimeError(f'{label} failed; command/output retained')


run('build-instrument', ['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host])
source = Path('tools/common-memory-program/helpers.c').resolve()
sources = {
    'fpm': Path('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm').resolve(),
    'canary': Path('.scratch/common-memory-program-outlined-3/canary-native.wasm').resolve(),
    'access': Path('.scratch/common-memory-program-outlined-3/access-native.wasm').resolve(),
    'fork': Path('.scratch/common-memory-shared-fork-3/shared-fork.native.wasm').resolve(),
    'bounds': out / 'bounds-native.wasm',
}
run('build-bounds', ['wat2wasm', '--enable-threads', 'tools/common-memory-program/survey/bounds.wat', '-o', sources['bounds']])
variants, helpers = {}, {}
for mode, level in [('baseline', 'O2'), ('helper-o3', 'O3')]:
    helper = out / ('helpers-' + mode + '.wasm')
    run('compile-' + mode, [llvm / 'clang', '--target=wasm32-unknown-unknown', '-ffreestanding', '-fno-builtin', '-' + level,
                           '-matomics', '-mbulk-memory', '-msimd128', '-nostdlib', '-fuse-ld=' + str(llvm / 'wasm-ld'),
                           '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,--shared-memory',
                           '-Wl,--initial-memory=131072', '-Wl,--max-memory=4294967296', source, '-o', helper])
    run('validate-' + mode, ['wasm-validate', '--enable-threads', helper])
    helpers[mode] = {'path': str(helper), 'sha256': sha(helper), 'bytes': helper.stat().st_size, 'level': level}
    artifacts = {}
    for kind, native in sources.items():
        target = out / (kind + '-' + mode + '.wasm')
        run(kind + '-' + mode, [instrument, native, helper, target, '--outline-accesses'], out / (kind + '-' + mode + '.json'))
        artifacts[kind] = {'path': str(target), 'sha256': sha(target), 'bytes': target.stat().st_size}
    variants[mode] = {'ids': ['CC-01'] if mode != 'baseline' else [], 'artifacts': artifacts}

old = json.loads(Path('.scratch/common-memory-survey-fused-1/manifest.json').read_text())['variants']['baseline']['artifacts']
for kind, artifact in variants['baseline']['artifacts'].items():
    if artifact['sha256'] != old[kind]['sha256']:
        raise ValueError(f'O2 control changed: {kind}')
manifest = {
    'scope': 'Helper C Clang O3 only; original Clang O2 PHP/fork preparation and outlined VM rewrite unchanged',
    'compiler': subprocess.check_output([llvm / 'clang', '--version'], text=True),
    'sources': {str(p): sha(p) for p in [Path(__file__).resolve(), source, Path('tools/common-memory-program/instrument/src/main.rs').resolve(), *sources.values()]},
    'helpers': helpers, 'variants': variants, 'pairReferences': {'helper-o3': 'baseline'},
    'identicalArtifacts': {kind: variants['baseline']['artifacts'][kind]['sha256'] == variants['helper-o3']['artifacts'][kind]['sha256'] for kind in sources},
}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'output': str(out), 'helpers': helpers, 'identicalArtifacts': manifest['identicalArtifacts']}))
