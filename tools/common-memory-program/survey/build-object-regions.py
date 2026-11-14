#!/usr/bin/env python3
"""VM-04 guarded object functions, isolated and combined with small fusion."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
commands = []


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def artifact(path):
    return {'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size}


def run(label, args):
    args = list(map(str, args))
    result = subprocess.run(args, capture_output=True, text=True)
    (out / (label + '.log')).write_text(result.stderr)
    (out / (label + '.json')).write_text(result.stdout)
    commands.append({'label': label, 'args': args, 'exit': result.returncode})
    (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
    result.check_returncode()
    return result


source_dir = out / 'source'
source_dir.mkdir()
for path in [Path(__file__), Path('tools/common-memory-program/survey/object-guard.c'),
             Path('tools/common-memory-program/survey/object-regions.wat'),
             Path('tools/common-memory-program/helpers.c'),
             *Path('tools/common-memory-program/instrument/src').glob('*.rs')]:
    shutil.copy2(path, source_dir / path.name)
old_path = Path('.scratch/common-memory-survey-fused-1/manifest.json').resolve()
old = json.loads(old_path.read_text())
helper = json.loads(Path('.scratch/common-memory-survey-helper-o3-1/manifest.json').read_text())['helpers']['baseline']
assert sha(helper['path']) == helper['sha256']
sources = {
    'fpm': Path('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm').resolve(),
    'canary': Path('.scratch/common-memory-program-outlined-3/canary-native.wasm').resolve(),
    'access': Path('.scratch/common-memory-program-outlined-3/access-native.wasm').resolve(),
    'fork': Path('.scratch/common-memory-shared-fork-3/shared-fork.native.wasm').resolve(),
    'bounds': Path('.scratch/common-memory-survey-fused-1/bounds-native.wasm').resolve(),
}
for path in sources.values():
    assert sha(path) == old['sources'][str(path)]
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
run('cargo-build', ['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host])
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
run('object-native', ['wat2wasm', '--enable-threads', source_dir / 'object-regions.wat', '-o', out / 'objects-native.wasm'])
private_source = out / 'helpers-object-guard.c'
private_source.write_text((source_dir / 'helpers.c').read_text() + '\n' + (source_dir / 'object-guard.c').read_text())
llvm = Path(os.environ['LLVM_BIN'])
guard_helper = out / 'helpers-object-guard.wasm'
run('guard-helper', [llvm / 'clang', '--target=wasm32-unknown-unknown', '-ffreestanding', '-fno-builtin', '-O2',
    '-matomics', '-mbulk-memory', '-msimd128', '-nostdlib', f'-fuse-ld={llvm / "wasm-ld"}',
    '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,--shared-memory', '-Wl,--initial-memory=131072',
    '-Wl,--max-memory=4294967296', private_source, '-o', guard_helper])
run('guard-helper-validate', ['wasm-validate', '--enable-threads', guard_helper])


def translate(mode, kind, source, helpers, flags):
    target = out / f'{kind}-{mode}.wasm'
    run(f'{kind}-{mode}', [instrument, source, helpers, target, '--outline-accesses', *flags])
    return artifact(target)


variants = {}
reproduced = {}
for mode, flags in [('baseline', []), ('fuse-small', ['--fuse-scalars=small'])]:
    reproduced[mode] = {}
    for kind, path in sources.items():
        item = translate('reproduced-' + mode, kind, path, helper['path'], flags)
        assert item['sha256'] == old['variants'][mode]['artifacts'][kind]['sha256'], (mode, kind)
        reproduced[mode][kind] = item
    variants[mode] = {'ids': old['variants'][mode]['ids'], 'artifacts': {
        **old['variants'][mode]['artifacts'],
        'objects': translate(mode, 'objects', out / 'objects-native.wasm', helper['path'], flags),
    }}
for mode, flags in [('object-guard', []), ('object-guard-fused', ['--fuse-scalars=small'])]:
    variants[mode] = {'ids': ['VM-04'] + (['VM-10'] if flags else []), 'artifacts': {
        kind: translate(mode, kind, path, guard_helper, ['--guard-object-functions', *flags])
        for kind, path in {**sources, 'objects': out / 'objects-native.wasm'}.items()}}
invalid = []
for flags, helpers in [([], guard_helper), (['--outline-accesses', '--guard-object-functions'], helper['path']),
                       (['--guard-object-functions'], guard_helper),
                       (['--outline-accesses', '--guard-object-functions', '--guard-object-functions'], guard_helper)]:
    target = out / 'invalid.wasm'
    args = [str(instrument), str(out / 'objects-native.wasm'), str(helpers), str(target), *flags]
    result = subprocess.run(args, capture_output=True, text=True)
    assert result.returncode != 0 and not target.exists()
    invalid.append({'args': args, 'exit': result.returncode, 'stderr': result.stderr})
(out / 'invalid-options.json').write_text(json.dumps(invalid, indent=2) + '\n')
manifest = {'scope': 'Original PHP/helper O2; VM-04 guarded whole call-free i32 object functions, independently and with small fusion',
    'sources': {str(path): sha(path) for path in [old_path, *source_dir.iterdir(), *sources.values()]},
    'guardHelper': artifact(guard_helper), 'originalHelper': helper,
    'variants': variants, 'reproducedDefaultArtifacts': reproduced,
    'pairReferences': {'object-guard': 'baseline', 'object-guard-fused': 'fuse-small'}}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
selected = json.loads((out / 'fpm-object-guard.json').read_text())['guardedObjects']
print(json.dumps({'output': str(out), 'defaultHashesReproduced': 10,
    'guardedFpmFunctions': selected['selectedFunctions'], 'guardedFpmSites': selected['staticSites'],
    'rejections': selected['rejections']}))
