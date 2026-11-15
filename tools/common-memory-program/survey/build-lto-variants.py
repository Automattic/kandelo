#!/usr/bin/env python3
"""CC-02 PHP C LTO, each alone and with small scalar fusion; own native controls."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

full, thin, out = [Path(p).resolve() for p in sys.argv[1:4]]
out.mkdir(parents=True, exist_ok=False)
original = Path('.scratch/common-memory-php-shared-build-1').resolve()
old = json.loads((original / 'build-inputs.json').read_text())

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def artifact(path):
    path = Path(path).resolve()
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)}

control_path = Path('.scratch/common-memory-survey-fused-1/manifest.json').resolve()
control = json.loads(control_path.read_text())
helper_path = Path('.scratch/common-memory-survey-object-regions-1/manifest.json').resolve()
helper = json.loads(helper_path.read_text())['originalHelper']
assert sha(helper['path']) == helper['sha256'], 'original O2 helper changed'
sources = [Path(__file__).resolve(), original / 'build-inputs.json', control_path, helper_path,
           Path('tools/common-memory-program/build-php-shared.py').resolve(),
           *sorted(Path('tools/common-memory-program/instrument/src').resolve().glob('*.rs'))]
build_controls = {}
for lto, build in [('full', full), ('thin', thin)]:
    receipt = json.loads((build / 'build-inputs.json').read_text())
    if not (receipt['complete'] and receipt['programsOnly'] and receipt['phpCOptimization'] == 'O2'
            and receipt['phpCLto'] == lto and not receipt['phpCProfile']
            and receipt['extraPhpCFlags'] == ['-flto=' + lto]
            and receipt['extraPhpLinkFlags'] == ['-Wl,--mllvm=-wasm-enable-sjlj', '-Wl,--mllvm=-wasm-use-legacy-eh=false',
                                                 '-Wl,--mllvm=-exception-model=wasm']):
        raise ValueError('requires completed declared C-O2 LTO main-program build: ' + lto)
    for key in ['normalRecipeSha256', 'phpVersion', 'dependencies', 'head']:
        if receipt[key] != old[key]:
            raise ValueError(f'build control changed: {lto} {key}')
    controls = {}
    for name in ['main/php_config.h', 'config.nice']:
        before = (original / 'work/source' / name).read_text().replace(str(original / 'work'), 'BUILD_WORK')
        after = (build / 'work/source' / name).read_text().replace(str(build / 'work'), 'BUILD_WORK')
        if before != after:
            raise ValueError(f'normal configure/header differs: {lto} {name}')
        controls[name] = {'identicalAfterWorkPathNormalization': True}
    makefile = (build / 'work/source/Makefile').read_text()
    clean = [line for line in makefile.splitlines() if line.startswith('CFLAGS_CLEAN = ')]
    assert len(clean) == 1 and ('-flto=' + lto) in clean[0].split(), 'actual CFLAGS_CLEAN missing LTO'
    for rule in ['BUILD_CLI', 'BUILD_FPM']:
        assert any(line.startswith(rule + ' = ') and '$(CFLAGS_CLEAN)' in line for line in makefile.splitlines())
    link_flags = [line for line in makefile.splitlines() if line.startswith('EXTRA_LDFLAGS_PROGRAM = ')]
    assert len(link_flags) == 1 and all(flag in link_flags[0].split() for flag in receipt['extraPhpLinkFlags'])
    for name in ['php.wasm', 'php-fpm.wasm']:
        assert sha(build / 'out' / name) == receipt['artifacts'][name]['sha256'], 'stamped program changed'
    build_controls[lto] = controls
    sources += [build / 'build-inputs.json', build / 'builder-source.py', build / 'experimental-recipe.sh']
for mode in ['baseline', 'fuse-small']:
    for value in control['variants'][mode]['artifacts'].values():
        assert sha(value['path']) == value['sha256'], 'reference changed'
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
subprocess.run(['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host], check=True)
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
result = {'scope': 'PHP C O2 full/ThinLTO; helpers O2, unchanged dependencies/C++/pre-fork Binaryen, original and small fusion',
          'sources': {str(p): sha(p) for p in sources}, 'buildControls': build_controls, 'helper': helper,
          'variants': {m: control['variants'][m] for m in ['baseline', 'fuse-small']},
          'nativeArtifacts': {}, 'nativeCliArtifacts': {}, 'pairReferences': {}, 'runs': []}

def save():
    (out / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')

def translate(mode, kind, native, fused):
    target = out / f'{kind}-{mode}.wasm'
    args = [str(instrument), str(native), helper['path'], str(target), '--outline-accesses',
            *(['--fuse-scalars=small'] if fused else [])]
    run = subprocess.run(args, capture_output=True, text=True)
    (out / f'{kind}-{mode}.json').write_text(run.stdout)
    (out / f'{kind}-{mode}.log').write_text(run.stderr)
    result['runs'].append({'mode': mode, 'kind': kind, 'args': args, 'exit': run.returncode}); save()
    run.check_returncode()
    return artifact(target)

for mode, fused in [('baseline', False), ('fuse-small', True)]:
    # Re-emission must preserve the exact references before a flag comparison.
    reproduced = translate(mode, 'fpm', original / 'out/php-fpm.wasm', fused)
    assert reproduced['sha256'] == control['variants'][mode]['artifacts']['fpm']['sha256'], 'default FPM changed'
    result['variants'][mode] = {**control['variants'][mode], 'artifacts': {
        **control['variants'][mode]['artifacts'], 'cli': translate(mode, 'cli', original / 'out/php.wasm', fused)}}
    result['nativeArtifacts'][mode] = artifact(original / 'out/php-fpm.wasm')
    result['nativeCliArtifacts'][mode] = artifact(original / 'out/php.wasm')
for lto, build in [('full', full), ('thin', thin)]:
    for fused in [False, True]:
        mode = 'php-lto-' + lto + ('-fused' if fused else '')
        reference = 'fuse-small' if fused else 'baseline'
        result['variants'][mode] = {'ids': ['CC-02', *(['VM-10'] if fused else [])],
                                  'artifacts': {**result['variants'][reference]['artifacts']}}
        result['pairReferences'][mode] = reference
        result['nativeArtifacts'][mode] = artifact(build / 'out/php-fpm.wasm')
        result['nativeCliArtifacts'][mode] = artifact(build / 'out/php.wasm')
        for kind, filename in [('fpm', 'php-fpm.wasm'), ('cli', 'php.wasm')]:
            result['variants'][mode]['artifacts'][kind] = translate(mode, kind, build / 'out' / filename, fused)
            save()
save()
print(json.dumps({'output': str(out), 'pairs': result['pairReferences'], 'buildControls': build_controls}))
