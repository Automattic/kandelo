#!/usr/bin/env python3
"""Build the exact Node-vendored c-ares with real target feature link checks."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, tomllib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def prepare(source, work, output, arch):
    recipe = tomllib.loads((HERE / 'package.toml').read_text())
    inventory = json.loads((HERE / 'sources.json').read_text())
    target = json.loads((REPO / 'packages/registry/node-compat/target.json').read_text())
    pin = {k: target['source'][k] for k in ['url', 'sha256']}
    if (inventory['nodeVersion'], inventory['nodeSourceCommit'], inventory['source']) != (target['version'], target['source']['commit'], pin):
        raise ValueError('c-ares backend and Node target pins differ')
    if recipe['version'] != target['version'] or {k: recipe['source'][k] for k in pin} != pin:
        raise ValueError('c-ares recipe/source pins differ')
    if arch not in recipe['arches']:
        raise ValueError('Unsupported c-ares architecture')
    # Staging sources beneath the resolver work root is normal. Compilation
    # must not write inside that staged source; installation stays disjoint.
    build_dir = work / 'cares-build'
    for a, b in [(source, build_dir), (source, output), (work, output)]:
        if a == b or a.is_relative_to(b) or b.is_relative_to(a):
            raise ValueError('c-ares source/build/output roots overlap')
    actual = {str(p.relative_to(source)) for p in (source / 'deps/cares').rglob('*') if p.is_file()}
    if actual != set(inventory['inputFiles']):
        raise ValueError('c-ares component file set differs from the pinned source')
    for rel, expected in inventory['inputFiles'].items():
        p = source / rel
        if not p.resolve().is_relative_to(source) or digest(p) != expected:
            raise ValueError('c-ares source identity mismatch: ' + rel)
    return inventory

def build(source, work, output, arch, inventory):
    tools = {name: shutil.which(arch + 'posix-' + name) for name in ['cc', 'ar', 'ranlib']}
    if not all(tools.values()):
        raise ValueError('Activate the repository SDK')
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    toolchain = work / 'cares-toolchain.cmake'
    sysroot = Path(os.environ.get('WASM_POSIX_SYSROOT') or
                   str(REPO / ('sysroot64' if arch == 'wasm64' else 'sysroot'))).resolve()
    # The generic SDK toolchain uses static try-compiles. That cannot check
    # symbol availability: an archive may retain any unresolved function.
    # This feature-heavy library needs real SDK executable link probes.
    toolchain.write_text('\n'.join([
        'set(CMAKE_SYSTEM_NAME Kandelo)', 'set(CMAKE_SYSTEM_PROCESSOR ' + arch + ')',
        'list(PREPEND CMAKE_MODULE_PATH "' + str(REPO / 'sdk/cmake') + '")',
        'set(CMAKE_C_COMPILER "' + tools['cc'] + '")',
        'set(CMAKE_AR "' + tools['ar'] + '")',
        'set(CMAKE_RANLIB "' + tools['ranlib'] + '")',
        'set(CMAKE_SYSROOT "' + str(sysroot) + '")',
        'set(CMAKE_FIND_ROOT_PATH "' + str(sysroot) + '")',
        'set(CMAKE_TRY_COMPILE_TARGET_TYPE EXECUTABLE)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)',
    ]) + '\n')
    args = ['cmake', '-S', str(source / 'deps/cares'), '-B', str(work / 'cares-build'),
            '-DCMAKE_TOOLCHAIN_FILE=' + str(toolchain), '-DCMAKE_BUILD_TYPE=Release',
            '-DCMAKE_INSTALL_PREFIX=' + str(output), '-DCMAKE_INSTALL_LIBDIR=lib',
            '-DCARES_STATIC=ON', '-DCARES_SHARED=OFF', '-DCARES_THREADS=ON',
            '-DCARES_BUILD_TESTS=OFF', '-DCARES_BUILD_TOOLS=OFF', '-DCARES_INSTALL=ON']
    subprocess.run(args, check=True)
    subprocess.run(['cmake', '--build', str(work / 'cares-build'), '--parallel', '4'], check=True)
    subprocess.run(['cmake', '--install', str(work / 'cares-build')], check=True)
    if not (output / 'lib/libcares.a').is_file():
        raise ValueError('c-ares archive was not installed')
    licenses = output / 'share/licenses/node-cares'
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'deps/cares/LICENSE.md', licenses / 'LICENSE.md')
    receipt = output / 'share/node-cares/provenance.json'
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({**inventory, 'compiled': True, 'arch': arch,
        'featureChecks': 'SDK executable link probes, no execution or Linux identity',
        'outputs': {'lib/libcares.a': digest(output / 'lib/libcares.a')}}, indent=2) + '\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['source', 'work', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--arch', choices=['wasm32', 'wasm64'], required=True)
    parser.add_argument('--plan-only', action='store_true')
    args = parser.parse_args()
    source, work, output = [getattr(args, k).resolve() for k in ['source', 'work', 'output']]
    inventory = prepare(source, work, output, args.arch)
    if args.plan_only:
        print(json.dumps({'kind': 'Source-only plan; no compiler/configure invoked', 'arch': args.arch,
            'caresVersion': inventory['caresVersion'], 'verifiedInputCount': len(inventory['inputFiles'])}))
    else:
        build(source, work, output, args.arch, inventory)
