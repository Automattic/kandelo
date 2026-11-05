#!/usr/bin/env python3
"""Compile unchanged Node-vendored codec sources with the target SDK only."""
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


def member(root, relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError(f'Invalid source/output member: {relative}')
    result = root / path
    if not result.resolve().is_relative_to(root):
        raise ValueError(f'Member escapes its root: {relative}')
    return result


def prepare(source, work, output, arch):
    recipe = tomllib.loads((HERE / 'package.toml').read_text())
    inventory = json.loads((HERE / 'sources.json').read_text())
    if inventory['schema'] != 1 or inventory['nodeVersion'] != recipe['version'] or inventory['source'] != recipe['source']:
        raise ValueError('Node codec recipe/source inventory pin mismatch')
    if arch not in recipe['arches']:
        raise ValueError('Unsupported target architecture')
    if work == source or work.is_relative_to(source):
        raise ValueError('Codec work root must not modify the source tree')
    if work == output or work.is_relative_to(output) or output.is_relative_to(work):
        raise ValueError('Codec work/output roots must be disjoint')
    if source == output or source.is_relative_to(output) or output.is_relative_to(source):
        raise ValueError('Codec source/output roots must be disjoint')
    inputs = {**inventory['selectionInputs'], **inventory['inputFiles']}
    for family in inventory['families']:
        inputs.update({item['path']: item['sha256'] for item in family['sources']})
    inputs.update({item['source']: item['sha256'] for item in inventory['copies']})
    for relative, expected in inputs.items():
        path = member(source, relative)
        if digest(path) != expected:
            raise ValueError(f'Node codec input hash mismatch: {relative}')
    archives = ['lib/' + family['archive'] for family in inventory['families']]
    if set(archives) != set(recipe['outputs']['libs']):
        raise ValueError('Codec archive outputs differ from the recipe')
    # Plans contain relative source/object names and declared flags only. They
    # never run compilers or target-layout helpers, and cannot count as builds.
    return inventory, {
        'kind': 'Static codec compilation plan; not a build or conformance result',
        'nodeVersion': inventory['nodeVersion'], 'sourceCommit': inventory['nodeSourceCommit'],
        'source': inventory['source'], 'arch': arch, 'compiled': False,
        'verifiedInputCount': len(inputs),
        'families': [{'id': f['id'], 'version': f['version'], 'sourceCount': len(f['sources']),
                      'flags': f['flags'], 'archive': 'lib/' + f['archive']}
                     for f in inventory['families']],
    }


def build(source, work, output, arch, inventory):
    # The shell entry point activates this worktree's SDK before invoking us.
    tools = {name: shutil.which(arch + 'posix-' + name) for name in ['cc', 'ar', 'ranlib']}
    if not all(tools.values()):
        raise ValueError('Target cc/ar/ranlib must come from sdk/activate.sh')
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    archives = {}
    for family in inventory['families']:
        build_root = work / 'objects' / family['id']
        build_root.mkdir(parents=True, exist_ok=True)
        objects = []
        for index, item in enumerate(family['sources']):
            # Brotli has multiple static_init.c files. Distinct member names
            # prevent an archiver from replacing one with the other.
            obj = build_root / f"{index:03d}-{Path(item['path']).stem}.o"
            command = [tools['cc'], '-O2', f'-ffile-prefix-map={work}=/usr/src/node-codecs',
                       *family['flags'], *['-I' + str(member(source, inc)) for inc in family['includeDirs']],
                       '-c', str(member(source, item['path'])), '-o', str(obj)]
            subprocess.run(command, cwd=work, check=True)
            objects.append(str(obj))
        archive = build_root / family['archive']
        archive.unlink(missing_ok=True)
        subprocess.run([tools['ar'], 'rcsD', str(archive), *objects], cwd=work, check=True)
        subprocess.run([tools['ranlib'], '-D', str(archive)], cwd=work, check=True)
        destination = member(output, 'lib/' + family['archive'])
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(archive, destination)
        archives[str(destination.relative_to(output))] = {'sha256': digest(destination), 'size': destination.stat().st_size}
    for item in inventory['copies']:
        destination = member(output, item['destination'])
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(member(source, item['source']), destination)
    provenance = {
        'schema': 1, 'nodeVersion': inventory['nodeVersion'],
        'nodeSourceCommit': inventory['nodeSourceCommit'], 'source': inventory['source'],
        'arch': arch, 'compiled': True,
        'sourceInventorySha256': digest(HERE / 'sources.json'),
        'codecs': {f['id']: f['version'] for f in inventory['families']}, 'archives': archives,
        'conformance': 'Not established by compilation or archive identity',
    }
    destination = output / 'share/node-codecs/provenance.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(provenance, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--arch', choices=['wasm32', 'wasm64'], required=True)
    parser.add_argument('--plan-only', action='store_true')
    parser.add_argument('--plan-output', type=Path)
    args = parser.parse_args()
    src, scratch, out = [p.resolve() for p in [args.source, args.work, args.output]]
    manifest, plan = prepare(src, scratch, out, args.arch)
    if args.plan_output:
        args.plan_output.write_text(json.dumps(plan, indent=2) + '\n')
    if args.plan_only:
        print(f"Verified {plan['verifiedInputCount']} source inputs for {args.arch}; no compiler invoked.")
    else:
        build(src, scratch, out, args.arch, manifest)
        print('Codec archives and provenance written to ' + str(out))
