#!/usr/bin/env python3
"""VM-06/10: guarded memory32 page-index bounds versus i64 endpoints."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def artifact(path):
    return {'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size}


out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
old_path = Path('.scratch/common-memory-survey-fused-1/manifest.json').resolve()
old = json.loads(old_path.read_text())
helper_path = Path('.scratch/common-memory-survey-helper-o3-1/manifest.json').resolve()
helper = json.loads(helper_path.read_text())['helpers']['baseline']
if sha(helper['path']) != helper['sha256']:
    raise ValueError('O2 helper changed')
sources = {
    'fpm': Path('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm').resolve(),
    'canary': Path('.scratch/common-memory-program-outlined-3/canary-native.wasm').resolve(),
    'access': Path('.scratch/common-memory-program-outlined-3/access-native.wasm').resolve(),
    'fork': Path('.scratch/common-memory-shared-fork-3/shared-fork.native.wasm').resolve(),
    'bounds': Path('.scratch/common-memory-survey-fused-1/bounds-native.wasm').resolve(),
}
for path in sources.values():
    if sha(path) != old['sources'][str(path)]:
        raise ValueError('original native input changed')
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
subprocess.run(['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host], check=True)
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
commands = []


def translate(mode, kind, flags, folder=out):
    target = folder / f'{kind}-{mode}.wasm'
    args = [str(instrument), str(sources[kind]), helper['path'], str(target), '--outline-accesses', *flags]
    r = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (folder / f'{kind}-{mode}.json').write_text(r.stdout)
    (folder / f'{kind}-{mode}.log').write_text(r.stderr)
    commands.append({'mode': mode, 'kind': kind, 'args': args, 'exit': r.returncode})
    (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
    r.check_returncode()
    return artifact(target)


reproduced = {}
for mode, flags in [('baseline', []), ('fuse-small', ['--fuse-scalars=small'])]:
    reproduced[mode] = {}
    for kind in sources:
        a = translate('reproduced-' + mode, kind, flags)
        expected = old['variants'][mode]['artifacts'][kind]['sha256']
        if a['sha256'] != expected:
            raise ValueError(f'default output changed: {mode}/{kind}')
        reproduced[mode][kind] = a
variants = {m: old['variants'][m] for m in ['baseline', 'fuse-small']}
variants['fuse-small-i32'] = {'ids': ['VM-06', 'VM-10'], 'artifacts': {
    kind: translate('fuse-small-i32', kind, ['--fuse-scalars=small', '--fused-bounds=i32']) for kind in sources}}
mechanism = out / 'full-offset-mechanisms'
mechanism.mkdir()
full = {}
for mode, flags in [('fuse-all-i64', ['--fuse-scalars=all']), ('fuse-all-i32', ['--fuse-scalars=all', '--fused-bounds=i32'])]:
    full[mode] = {'artifacts': {kind: translate(mode, kind, flags, mechanism) for kind in sources if kind != 'fpm'}}
(mechanism / 'manifest.json').write_text(json.dumps({'scope': 'Mechanisms only; no full-offset PHP performance claim', 'variants': full}, indent=2) + '\n')
invalid = []
for flags in [['--fused-bounds=i32'], ['--fuse-scalars=small', '--fused-bounds=i32'],
              ['--outline-accesses', '--fuse-scalars=small', '--fused-bounds=i32', '--fused-bounds=i32'], ['--fused-bounds=bad']]:
    target = out / 'invalid.wasm'
    r = subprocess.run([str(instrument), str(sources['bounds']), helper['path'], str(target), *flags], capture_output=True, text=True)
    if r.returncode == 0 or target.exists():
        raise ValueError('invalid option combination accepted')
    invalid.append({'flags': flags, 'exit': r.returncode, 'stderr': r.stderr})
(out / 'invalid-options.json').write_text(json.dumps(invalid, indent=2) + '\n')
manifest = {'scope': 'Original PHP C-O2/helper O2; only fused scalar bounds use guarded i32 arithmetic; split helper and permissions preserved',
            'sources': {str(p): sha(p) for p in [Path(__file__).resolve(), old_path, helper_path,
                Path('tools/common-memory-program/instrument/src/main.rs').resolve(), Path('tools/common-memory-program/survey/bounds-checks.mjs').resolve(), *sources.values()]},
            'helper': helper, 'variants': variants, 'pairReferences': {'fuse-small-i32': 'fuse-small'},
            'reproducedDefaultArtifacts': reproduced, 'fullOffsetMechanisms': str(mechanism), 'invalidOptionsRejected': len(invalid)}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'output': str(out), 'defaultHashesReproduced': sum(len(v) for v in reproduced.values()), 'fullOffsetMechanismModes': list(full),
                  'candidateFpm': variants['fuse-small-i32']['artifacts']['fpm']}))
