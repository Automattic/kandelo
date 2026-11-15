#!/usr/bin/env python3
"""Prepare already linked profiled CLI/FPM; do not relabel a failed package.

The whole private profiling recipe fails later at the optional shared curl
extension. Its successful raw CLI/FPM links can still exercise main-program
profiling. Copy them through the exact normal pre-opt/fork tail into a fresh
owned directory, then stamp normally. No extension or package publication.
"""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


build, out = [Path(p).resolve() for p in sys.argv[1:3]]
out.mkdir(parents=True, exist_ok=False)
receipt = json.loads((build / 'build-inputs.json').read_text())
if receipt['complete'] or receipt.get('phpCProfile', {}).get('mode') != 'generate':
    raise ValueError('requires a recorded incomplete whole-package profile-generation build')
recipe_path = Path('packages/registry/php/build-php.sh').resolve()
if sha(recipe_path) != receipt['normalRecipeSha256']:
    raise ValueError('normal recipe changed')
recipe = recipe_path.read_text()
start = '# Copy to bin/ with .wasm extension (needed for Vite browser demos)'
stop = '# Publish through the resolver-owned output without mutating the checkout.'
if recipe.count(start) != 1 or recipe.count(stop) != 1:
    raise ValueError('normal program preparation tail changed')
tail = recipe[recipe.index(start):recipe.index(stop)]
raw = {'php.wasm': build / 'work/source/sapi/cli/php', 'php-fpm.wasm': build / 'work/source/sapi/fpm/php-fpm'}
sources = {str(p): sha(p) for p in [Path(__file__).resolve(), recipe_path, build / 'build-inputs.json', *raw.values()]}
root = Path.cwd().resolve()
script = out / 'normal-program-tail.sh'
script.write_text('set -euo pipefail\n' + '\n'.join([
    'REPO_ROOT=' + shlex.quote(str(root)),
    'BIN_DIR=' + shlex.quote(str(out / 'out')),
    'FORK_INSTRUMENT=' + shlex.quote(str(root / 'scripts/run-wasm-fork-instrument.sh')),
    'cd ' + shlex.quote(str(build / 'work/source')),
]) + '\n' + tail)
(out / 'out').mkdir()
result = {
    'scope': 'Main CLI/FPM profile generation only; original whole-package build remains incomplete at optional shared extension',
    'complete': False, 'originalBuild': str(build), 'originalPackageBuildComplete': False,
    'phpCOptimization': receipt['phpCOptimization'], 'phpCProfile': receipt['phpCProfile'],
    'sources': sources, 'normalProgramTailSha256': hashlib.sha256(tail.encode()).hexdigest(),
    'commands': [],
}


def save():
    (out / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')


def run(name, args):
    r = subprocess.run([str(a) for a in args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    result['commands'].append({'name': name, 'args': [str(a) for a in args], 'exit': r.returncode})
    save()
    r.check_returncode()


save()
run('prepare', ['bash', script])
host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
for name in raw:
    run('stamp-' + name, [root / 'target' / host / 'debug/xtask', 'stamp-abi-contract', out / 'out' / name])
for path, digest in sources.items():
    if sha(path) != digest:
        raise ValueError(f'input changed during preparation: {path}')
result['artifacts'] = {name: {'path': str(out / 'out' / name), 'sha256': sha(out / 'out' / name), 'bytes': (out / 'out' / name).stat().st_size} for name in raw}
result['complete'] = True
save()
print(json.dumps(result['artifacts']))
