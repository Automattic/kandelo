#!/usr/bin/env python3
"""Build exact Node-vendored SQLite under disjoint resolver-owned roots."""
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
        raise ValueError('SQLite backend and Node target pins differ')
    if recipe['version'] != target['version'] or {key: recipe['source'][key] for key in pin} != pin:
        raise ValueError('SQLite recipe/source pins differ')
    if arch not in recipe['arches']:
        raise ValueError('Unsupported SQLite architecture')
    # The resolver stages node-source beneath work. Only a build root
    # inside source (or equal to it) would overwrite reviewed inputs.
    if source == work or work.is_relative_to(source):
        raise ValueError('SQLite work root must not modify the source tree')
    for a, b in [(source, output), (work, output)]:
        if a == b or a.is_relative_to(b) or b.is_relative_to(a):
            raise ValueError('SQLite source/work/output roots must be disjoint')
    for rel, expected in inventory['inputFiles'].items():
        p = source / rel
        if not p.resolve().is_relative_to(source) or digest(p) != expected:
            raise ValueError('SQLite source identity mismatch: ' + rel)
    return inventory


def build(source, work, output, arch, inventory):
    tools = {name: shutil.which(arch + 'posix-' + name) for name in ['cc', 'ar', 'ranlib']}
    if not all(tools.values()):
        raise ValueError('Activate the repository SDK for target cc/ar/ranlib')
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    obj = work / 'node-sqlite.o'
    command = [tools['cc'], '-O2', '-pthread', *inventory['cflags'],
               *['-D' + flag for flag in inventory['defines']],
               f'-ffile-prefix-map={source}=/usr/src/node',
               '-I' + str(source / 'deps/sqlite'), '-c', str(source / 'deps/sqlite/sqlite3.c'), '-o', str(obj)]
    subprocess.run(command, cwd=work, check=True)
    archive = work / 'libsqlite3.a'
    archive.unlink(missing_ok=True)
    subprocess.run([tools['ar'], 'rcsD', str(archive), str(obj)], cwd=work, check=True)
    subprocess.run([tools['ranlib'], '-D', str(archive)], cwd=work, check=True)
    (output / 'lib').mkdir(exist_ok=True)
    shutil.copyfile(archive, output / 'lib/libsqlite3.a')
    (output / 'include').mkdir(exist_ok=True)
    for name in ['sqlite3.h', 'sqlite3ext.h']:
        shutil.copyfile(source / 'deps/sqlite' / name, output / 'include' / name)
    licenses = output / 'share/licenses/node-sqlite'
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'LICENSE', licenses / 'Node-LICENSE')
    header = (source / 'deps/sqlite/sqlite3.h').read_text()
    (licenses / 'SQLite-public-domain.txt').write_text(header[:header.index('*/') + 2] + '\n')
    evidence = output / 'share/node-sqlite/provenance.json'
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps({**inventory, 'arch': arch, 'compiled': True,
        'outputs': {'lib/libsqlite3.a': digest(output / 'lib/libsqlite3.a')}}, indent=2) + '\n')


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
            'sqliteVersion': inventory['sqliteVersion'], 'defines': inventory['defines'],
            'verifiedInputCount': len(inventory['inputFiles'])}))
    else:
        build(source, work, output, args.arch, inventory)
