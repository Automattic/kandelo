#!/usr/bin/env python3
"""Normal SDK/fork/ABI fixture proving selected object callees execute after fork."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys

variants, out = map(lambda p: Path(p).resolve(), sys.argv[1:3])
out.mkdir(parents=True, exist_ok=False)
source = Path(__file__).with_name('object-fork.c')
shutil.copy2(source, out / source.name)
shutil.copy2(__file__, out / Path(__file__).name)
commands = []


def run(label, args):
    args = list(map(str, args))
    r = subprocess.run(args, capture_output=True, text=True)
    (out / (label + '.log')).write_text(r.stdout + r.stderr)
    commands.append({'args': args, 'exit': r.returncode})
    (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
    r.check_returncode()
    return r.stdout


linked, native = out / 'object-fork.linked.wasm', out / 'object-fork.native.wasm'
run('link', ['sdk/bin/wasm32posix-cc', '-O2', '-pthread', out / source.name,
    '-Wl,--export=object_touch', '-Wl,--export=object_sum', '-o', linked])
run('fork', ['scripts/run-wasm-fork-instrument.sh', linked, '-o', native])
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
run('stamp', ['cargo', 'run', '-p', 'xtask', '--target', host, '--quiet', '--', 'stamp-abi-contract', native])
instrument = Path('tools/common-memory-program/instrument/target') / host / 'debug/common-memory-program-instrument'
run('cargo-build', ['cargo', 'build', '--manifest-path', 'tools/common-memory-program/instrument/Cargo.toml', '--target', host])
exports = json.loads(run('native-exports', [instrument, '--inspect-function-exports', native]))
indices = {name: exports[name] for name in ['object_touch', 'object_sum']}
manifest = json.loads((variants / 'manifest.json').read_text())
artifacts = {}
for mode, flags in [('baseline', []), ('fuse-small', ['--fuse-scalars=small']),
                    ('object-guard', ['--guard-object-functions']),
                    ('object-guard-fused', ['--guard-object-functions', '--fuse-scalars=small'])]:
    helper = manifest['guardHelper' if 'object-guard' in mode else 'originalHelper']['path']
    target = out / (mode + '.wasm')
    report = json.loads(run(mode, [instrument, native, helper, target, '--outline-accesses', *flags]))
    if mode.startswith('object-guard'):
        selected = {p['function'] for p in report['guardedObjects']['functions']}
        assert all(index in selected for index in indices.values()), (mode, indices, selected)
    artifacts[mode] = {'path': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'bytes': target.stat().st_size, 'requiredSelectedFunctions': indices}
(out / 'manifest.json').write_text(json.dumps({'scope': 'real guest fork with selected call-free object callees',
    'variants': artifacts, 'native': str(native), 'sourceSha256': hashlib.sha256((out / source.name).read_bytes()).hexdigest()}, indent=2) + '\n')
print(json.dumps({'output': str(out), 'requiredSelectedFunctions': indices, 'modes': list(artifacts)}))
