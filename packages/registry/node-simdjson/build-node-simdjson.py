#!/usr/bin/env python3
"""Build exact Node-vendored simdjson under disjoint resolver-owned roots."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import tomllib

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source, work, output, arch):
    recipe = tomllib.loads((HERE / 'package.toml').read_text())
    inventory = json.loads((HERE / 'sources.json').read_text())
    target = json.loads((HERE.parents[2] / 'packages/registry/node-compat/target.json').read_text())
    pin = {key: target['source'][key] for key in ['url', 'sha256']}
    if (inventory['nodeVersion'], inventory['nodeSourceCommit'], inventory['source']) != (
            target['version'], target['source']['commit'], pin):
        raise ValueError('simdjson backend and Node target pins differ')
    if recipe['version'] != target['version'] or {key: recipe['source'][key] for key in pin} != pin:
        raise ValueError('simdjson recipe/source pins differ')
    if arch not in recipe['arches']:
        raise ValueError('Unsupported simdjson architecture')
    # The resolver stages node-source beneath work. Only a build root
    # inside source (or equal to it) would overwrite reviewed inputs.
    if source == work or work.is_relative_to(source):
        raise ValueError('simdjson work root must not modify the source tree')
    for a, b in [(source, output), (work, output)]:
        if a == b or a.is_relative_to(b) or b.is_relative_to(a):
            raise ValueError('simdjson source/work/output roots must be disjoint')
    for rel, expected in inventory['inputFiles'].items():
        p = source / rel
        if not p.resolve().is_relative_to(source) or digest(p) != expected:
            raise ValueError('simdjson source identity mismatch: ' + rel)
    return inventory


def build(source, work, output, arch, inventory):
    tools = {name: shutil.which(arch + 'posix-' + name) for name in ['c++', 'ar', 'ranlib']}
    if not all(tools.values()):
        raise ValueError('Activate the repository SDK for target C++/ar/ranlib')
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    obj = work / 'simdjson.o'
    # The pinned gyp target has one unchanged TU and no feature overrides.
    # Let upstream select its actual target implementation, including fallback.
    command = [tools['c++'], '-std=c++17', '-O2', '-pthread', '-fexceptions',
               f'-ffile-prefix-map={source}=/usr/src/node',
               '-I' + str(source / 'deps/simdjson'), '-c', str(source / 'deps/simdjson/simdjson.cpp'), '-o', str(obj)]
    subprocess.run(command, cwd=work, check=True)
    archive = work / 'libsimdjson.a'
    archive.unlink(missing_ok=True)
    subprocess.run([tools['ar'], 'rcsD', str(archive), str(obj)], cwd=work, check=True)
    subprocess.run([tools['ranlib'], '-D', str(archive)], cwd=work, check=True)
    (output / 'lib').mkdir(exist_ok=True)
    shutil.copyfile(archive, output / 'lib/libsimdjson.a')
    (output / 'include').mkdir(exist_ok=True)
    shutil.copyfile(source / 'deps/simdjson/simdjson.h', output / 'include/simdjson.h')
    licenses = output / 'share/licenses/node-simdjson'
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'LICENSE', licenses / 'Node-LICENSE')
    shutil.copyfile(source / 'deps/simdjson/LICENSE', licenses / 'LICENSE')
    evidence = output / 'share/node-simdjson/provenance.json'
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps({**inventory, 'arch': arch, 'compiled': True,
        'outputs': {'lib/libsimdjson.a': digest(output / 'lib/libsimdjson.a')}}, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['source', 'work', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--arch', choices=['wasm32', 'wasm64'], required=True)
    parser.add_argument('--plan-only', action='store_true')
    args = parser.parse_args()
    source, work, output = [getattr(args, key).resolve() for key in ['source', 'work', 'output']]
    inventory = prepare(source, work, output, args.arch)
    if args.plan_only:
        print(json.dumps({'kind': 'Source-only plan; no compiler invoked', 'arch': args.arch,
            'nodeVersion': inventory['nodeVersion'], 'sourceCommit': inventory['nodeSourceCommit'],
            'verifiedInputCount': len(inventory['inputFiles'])}))
    else:
        build(source, work, output, args.arch, inventory)
