#!/usr/bin/env python3
"""Build the real engine interface library, without claiming a complete Node SDK."""
import argparse
import concurrent.futures
import hashlib
import json
import re
from pathlib import Path
import shlex
import shutil
import subprocess


# Upstream Node includes these public source-interface names independently.
# Each forwards to the same actual SpiderMonkey-backed declarations; none
# imports V8's inline heap layout or adds declarations to conceal missing APIs.
# The portable platform/configuration headers come from the declared tracing
# provider. This still does not install or advertise a complete engine SDK.
SOURCE_INTERFACE_HEADERS = {
    'v8-maybe.h': 'engine-maybe-api.h',
    **{name: 'engine-native-api.h' for name in (
        'v8.h', 'v8-context.h', 'v8-cppgc.h', 'v8-exception.h',
        'v8-external-memory-accounter.h', 'v8-fast-api-calls.h',
        'v8-function-callback.h', 'v8-isolate.h', 'v8-local-handle.h', 'v8-locker.h',
        'v8-primitive.h', 'v8-profiler.h', 'v8-value-serializer.h', 'v8-sandbox.h', 'v8-script.h',
        'v8-template.h', 'v8-typed-array.h', 'v8-value.h', 'v8-external.h', 'v8-regexp.h',
    )},
    **{f'cppgc/{name}.h': '../engine-gc-api.h' for name in (
        'allocation', 'garbage-collected', 'name-provider', 'persistent',
    )},
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build(args):
    root, work, core, output = args.repository, args.work, args.core, args.output
    identity_path = core / 'share/kandelo/spidermonkey-core.json'
    identity = json.loads(identity_path.read_text())
    for key, value in {'engineVersion': '153.7.0esr', 'programAbi': 56,
                       'target': 'wasm32-unknown-kandelo', 'shellIncluded': False,
                       'sourceArchiveSha256': '7f8715ee7de2cf36a156216a9b1c7f26d1653010e65793bb2fce66e12edb6ea0'}.items():
        if type(identity.get(key)) is not type(value) or identity.get(key) != value:
            raise ValueError('engine identity mismatch: ' + key)
    private_path = core / identity['privateHeaderManifest']
    if digest(private_path) != identity['privateHeaderManifestSha256']:
        raise ValueError('private engine header manifest changed')
    private = json.loads(private_path.read_text())
    if private['engineLibraries'] != identity['libraries']:
        raise ValueError('private engine headers do not identify the actual archives')
    private_include = core / private['includeDirectory']
    for row in private['headers']:
        relative = Path(row['path'])
        if relative.is_absolute() or '..' in relative.parts or digest(private_include / relative) != row['sha256']:
            raise ValueError('private engine header mismatch: ' + str(relative))
    for row in identity['libraries']:
        if digest(core / row['path']) != row['sha256']:
            raise ValueError('engine archive changed: ' + row['path'])

    sources = root / 'packages/registry/spidermonkey-node/bridge/src'
    staged = work / 'include/kandelo-node'
    staged.mkdir(parents=True)
    names = [
        'native-engine.cpp', 'codecs.cpp', 'engine-native-api.h', 'engine-state.h',
        'error-stack.cpp', 'error-stack.h', 'native-source-location.h',
        'engine-maybe-api.h', 'engine-wire-codec.h', 'engine-value-wire-codecs-inl.h', 'engine-serialization-codecs-inl.h',
        'fast-call-metadata.cpp', 'metadata-values-codecs-inl.h', 'data-array-codecs-inl.h', 'engine-script-api.h', 'engine-script-codecs-inl.h',
        'node-stencil-cache-format.h', 'engine-code-cache-codecs-inl.h',
        'engine-gc-api.h', 'engine-gc-codecs-inl.h', 'engine-isolate-codecs-inl.h',
        'engine-extras-runtime.h', 'engine-extras-runtime-undef.h', 'engine-extras-codecs-inl.h',
        'engine-cpu-profiler-data.h', 'engine-cpu-profiler-codecs-inl.h', 'engine-profiler-stream-support.h',
        'engine-heap-profiler-data.h', 'engine-heap-profiler-codecs-inl.h',
        'engine-heap-snapshot-data.h', 'engine-heap-snapshot-codecs-inl.h',
        'engine-heap-snapshot-capture-inl.h', 'engine-shared-conveyor-data.h',
        'engine-heap-allocation-data.h', 'engine-heap-allocation-codecs-inl.h',
        'engine-memory-services-inl.h', 'engine-memory-measurement-inl.h',
        'engine-checks.h', 'engine-process.h', 'engine-process.cpp', 'engine-lifetime-codecs-inl.h', 'buffer-codecs-inl.h',
        'continuation-codecs-inl.h', 'context-codecs-inl.h', 'promise-codecs-inl.h',
        'engine-finalization-codecs-inl.h',
        'engine-codegen-codecs-inl.h',
        'internal-field-codecs-inl.h', 'message-codecs-inl.h',
        'collection-codecs-inl.h', 'native-object-codecs-inl.h', 'heap-statistics-codecs-inl.h', 'value-services-inl.h', 'regexp-property-codecs-inl.h', 'value-property-codecs-inl.h',
        'property-codecs-inl.h', 'stack-codecs-inl.h', 'inspection-codecs-inl.h', 'template-codecs-inl.h',
        'property-descriptor-codecs-inl.h', 'property-interceptor-native-api.h', 'property-interceptor-codecs-inl.h',
        'trace-codecs-inl.h', 'trace-utf8-native.cpp', 'trace-utf8-native.h',
        'trace-unicode-native-api.h', 'buffer-memory.cpp', 'buffer-memory.h',
    ]
    inputs = []
    for name in names:
        shutil.copy2(sources / name, staged / name)
        inputs.append({'path': name, 'sha256': digest(staged / name)})
    # Cache identity follows actual engine bytes/configuration and every native
    # bridge input. No hand-maintained engine version string can admit a cache
    # produced by different compiled inputs.
    source_tree = [{'path': str(path.relative_to(sources)), 'sha256': digest(path)}
                   for path in sorted(sources.rglob('*')) if path.is_file()]
    preparation = ['packages/registry/spidermonkey-node/bridge/build-bridge.py',
                   'packages/registry/spidermonkey-node/bridge/tools/stage-source-inputs.py',
                   'packages/registry/node-core-source/package.toml',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-string-metadata.py',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-maybe-api.py',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-fast-call-metadata.py',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-profiler-metadata.py',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-regexp-property-api.py',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-value-wire-api.py',
                   'packages/registry/spidermonkey-node/bridge/native-source-patches/0010-native-value-wire-safety.patch',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-native-interrupts.py',
                   'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-tracing.py']
    source_tree_hash = hashlib.sha256(json.dumps(source_tree, sort_keys=True,
                                                separators=(',', ':')).encode()).hexdigest()
    cache_contract = {'schema': 1, 'engineIdentitySha256': digest(identity_path),
                      'nodeSourceSha256': '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191',
                      'target': identity['target'], 'programAbi': identity['programAbi'],
                      'bridgeSources': inputs, 'nativeSourceTreeSha256': source_tree_hash,
                      'preparationSources': [{'path': path, 'sha256': digest(root / path)}
                                             for path in preparation]}
    cache_identity = hashlib.sha256(json.dumps(cache_contract, sort_keys=True,
                                              separators=(',', ':')).encode()).hexdigest()
    cache_version = int(cache_identity[:8], 16)
    cache_header = staged / 'engine-build-identity.h'
    cache_header.write_text(
        '#pragma once\n#include <cstdint>\n'
        'namespace kandelo::node::cache {\n'
        f'inline constexpr char kIdentity[] = "{cache_identity}";\n'
        f'inline constexpr char kBuildId[] = "kandelo-node-stencil/1/{cache_identity}";\n'
        f'inline constexpr uint32_t kVersionTag = {cache_version}u;\n'
        '}\n')
    shutil.copytree(sources / 'v8-source-api', staged / 'v8-source-api')
    # Whole portable upstream value type; no V8 allocator or collector code.
    cppgc_statistics = args.node_source / 'deps/v8/include/cppgc/heap-statistics.h'
    shutil.copy2(cppgc_statistics, staged / 'v8-source-api/cppgc-heap-statistics.h')
    memory_path = 'deps/v8/src/heap/memory-measurement.cc'
    memory_source = args.node_source / memory_path
    if digest(memory_source) != '049dd1c0dd70f3cc7bbea80317634bd77225c24563d5265c8d744847819c0a4f':
        raise ValueError('pinned whole memory-measurement source changed')
    memory_root = staged / 'memory-measurement-upstream'
    memory_target = memory_root / memory_path
    memory_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(memory_source, memory_target)
    memory_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0002-native-memory-measurement.patch'
    patched = subprocess.run(['patch','--batch','-p1','-F0','-d',str(memory_root)],
                             input=memory_patch.read_bytes(),capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset',diagnostic,re.I):
        raise ValueError('whole native memory-measurement patch failed: '+diagnostic)
    extras_path = 'deps/v8/src/builtins/builtins-trace.cc'
    extras_source = args.node_source / extras_path
    if digest(extras_source) != '13b02d7ba55ae3b504a8f85c2b740ae026a354f0ee87837568103eede1c28802':
        raise ValueError('pinned whole extras-tracing source changed')
    extras_root = staged / 'extras-tracing-upstream'
    extras_target = extras_root / extras_path
    extras_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(extras_source, extras_target)
    extras_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0003-native-extras-tracing.patch'
    patched = subprocess.run(['patch','--batch','-p1','-F0','-d',str(extras_root)],
                             input=extras_patch.read_bytes(),capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset',diagnostic,re.I):
        raise ValueError('whole native extras-tracing patch failed: '+diagnostic)
    cpu_sources = {
        'deps/v8/src/profiler/profile-generator.h': 'ab17dd6d263f3de134a456b3cfe87851c549a302cef5e4dc296acfeb37c424ec',
        'deps/v8/src/profiler/profile-generator.cc': 'c5e593999a52e5724f73ab5632a823345f4fa20bfc14abb5115db3d541b5ceb3',
        'deps/v8/src/profiler/output-stream-writer.h': '4789684c59cc248e2e9c6d62ab58a55fb7052cff1484624e8f8d9e919f8b9e30',
        'deps/v8/src/profiler/profile-generator-inl.h': 'c545e4a02d94092a492daa136be44268e3268aaefe9ea60a2c5868845db09ae4',
    }
    cpu_root = staged / 'cpu-profiler-upstream'
    for name, expected in cpu_sources.items():
        source = args.node_source / name
        if digest(source) != expected:
            raise ValueError('pinned whole CPU profiler source changed: ' + name)
        target = cpu_root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    cpu_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0004-native-cpu-profile-json.patch'
    patched = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(cpu_root)],
                             input=cpu_patch.read_bytes(), capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
        raise ValueError('whole native CPU profiler patch failed: ' + diagnostic)
    heap_path = 'deps/v8/src/profiler/heap-profiler.cc'
    heap_source = args.node_source / heap_path
    if digest(heap_source) != '171e38a5d52fc53953ff8bbb6089351169a340f7d10bdfd5b6438861b95c8e2a':
        raise ValueError('pinned whole heap profiler source changed')
    heap_root = staged / 'heap-profiler-upstream'
    heap_target = heap_root / heap_path
    heap_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(heap_source, heap_target)
    heap_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0005-native-heap-profiler-registry.patch'
    patched = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(heap_root)],
                             input=heap_patch.read_bytes(), capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
        raise ValueError('whole native heap registry patch failed: ' + diagnostic)
    snapshot_sources = {
        'deps/v8/src/profiler/heap-snapshot-generator.h': '415a74de6d3220ce7139985edc3c67f650edd7c1d05a46dbb9ea93ae8829baec',
        'deps/v8/src/profiler/heap-snapshot-generator.cc': 'a25748ff037dd2857716bb2602b298cf24216b35a348026902e8dd0ec3ebe337',
        'deps/v8/src/profiler/heap-snapshot-generator-inl.h': '11ef5e58f2d89bdb08d22fce2e8e295e8a07851850d6343e031cb87983f239ff',
    }
    snapshot_root = staged / 'heap-snapshot-upstream'
    for name, expected in snapshot_sources.items():
        source = args.node_source / name
        if digest(source) != expected:
            raise ValueError('pinned whole heap snapshot source changed: ' + name)
        target = snapshot_root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    snapshot_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0006-native-heap-snapshot-json.patch'
    patched = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(snapshot_root)],
                             input=snapshot_patch.read_bytes(), capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
        raise ValueError('whole native heap snapshot patch failed: ' + diagnostic)
    conveyor_path = 'deps/v8/src/api/api.cc'
    conveyor_source = args.node_source / conveyor_path
    if digest(conveyor_source) != '147e419129137728659555cdb7866823e0ee7bc005e81ff5206c9f064e094f86':
        raise ValueError('pinned whole conveyor source changed')
    conveyor_root = staged / 'shared-conveyor-upstream'
    conveyor_target = conveyor_root / conveyor_path
    conveyor_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(conveyor_source, conveyor_target)
    conveyor_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0007-native-shared-conveyor-lifetime.patch'
    patched = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(conveyor_root)],
                             input=conveyor_patch.read_bytes(), capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
        raise ValueError('whole conveyor lifetime patch failed: ' + diagnostic)
    sampling_path = 'deps/v8/src/profiler/sampling-heap-profiler.cc'
    sampling_source = args.node_source / sampling_path
    if digest(sampling_source) != 'acbd4be45a8b5681202806f63d48569bf14429e0a77b116e38b5031802610f66':
        raise ValueError('pinned whole heap sampling source changed')
    sampling_root = staged / 'heap-sampling-upstream'
    sampling_target = sampling_root / sampling_path
    sampling_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(sampling_source, sampling_target)
    sampling_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0008-native-heap-sampling-math.patch'
    patched = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(sampling_root)],
                             input=sampling_patch.read_bytes(), capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
        raise ValueError('whole heap sampling math patch failed: ' + diagnostic)
    unicode_path = 'deps/v8/src/strings/unicode.cc'
    unicode_source = args.node_source / unicode_path
    if digest(unicode_source) != 'eda4ae8a71226ebb5d4ee36c1b9babb9891b7017a3a397640b0fbd1bf85f8497':
        raise ValueError('pinned whole Unicode decoder source changed')
    unicode_root = staged / 'unicode-decoder-upstream'
    unicode_target = unicode_root / unicode_path
    unicode_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(unicode_source, unicode_target)
    unicode_patch = root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0009-native-utf8-scalar-decoder.patch'
    patched = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(unicode_root)],
                             input=unicode_patch.read_bytes(), capture_output=True)
    diagnostic = (patched.stdout + patched.stderr).decode()
    if patched.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
        raise ValueError('whole Unicode decoder patch failed: ' + diagnostic)
    source_inputs = work / 'node-source-inputs'
    subprocess.run([
        'python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools/stage-source-inputs.py'),
        '--source', str(args.node_source),
        '--package', str(root / 'packages/registry/node-core-source/package.toml'),
        '--output', str(source_inputs),
    ], check=True)
    manifest = source_inputs / 'sources.json'
    string_metadata = json.loads(subprocess.check_output([
        'python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-string-metadata.py'),
        '--manifest', str(manifest), '--output', str(staged)], text=True))
    maybe_metadata = json.loads(subprocess.check_output([
        'python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-maybe-api.py'),
        '--manifest', str(manifest), '--output', str(staged)], text=True))
    fast_metadata = json.loads(subprocess.check_output([
        'python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-fast-call-metadata.py'),
        '--manifest', str(manifest), '--output', str(staged)], text=True))
    profiler_metadata = json.loads(subprocess.check_output([
        'python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-profiler-metadata.py'),
        '--manifest', str(manifest), '--output', str(staged)], text=True))
    regexp_property_metadata = json.loads(subprocess.check_output([
        'python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-regexp-property-api.py'),
        '--manifest', str(manifest), '--output', str(staged)], text=True))
    value_wire_metadata = json.loads(subprocess.check_output([
        'python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools/prepare-nodejs-value-wire-api.py'),
        '--manifest', str(manifest), '--output', str(staged),
        '--patch', str(root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0010-native-value-wire-safety.patch')], text=True))
    for script, destination, extra in [
        ('prepare-nodejs-native-interrupts.py', 'native-interrupt-upstream',
         ['--patch', str(root / 'packages/registry/spidermonkey-node/bridge/native-source-patches/0001-native-interrupt-transport.patch')]),
        ('prepare-nodejs-tracing.py', 'tracing-upstream', []),
    ]:
        subprocess.run(['python3', str(root / 'packages/registry/spidermonkey-node/bridge/tools' / script), '--manifest',
                        str(manifest), '--output', str(staged / destination), *extra], check=True)

    cflags = shlex.split(subprocess.check_output(
        ['pkg-config', '--cflags', str(core / 'lib/pkgconfig/mozjs-153.pc')], text=True))
    # Exact library define in pinned js/src/build/moz.build. Together with the
    # actual generated configuration, it enables the already linked jsrust API.
    common = ['wasm32posix-c++', '-std=c++20', '-c', '-O2', '-fexceptions',
              '-fno-rtti', '-ferror-limit=0', '-DMOZ_HAS_MOZGLUE=1',
              '-nostdinc++', '-isystem', str(args.libcxx / 'include/c++/v1'),
              *cflags, '-I' + str(args.tracing / 'include'),
              '-I' + str(args.libuv / 'include'), '-I' + str(private_include),
              '-I' + str(work / 'include'), '-I' + str(staged / 'trace-builtins-upstream'),
              '-I' + str(args.node_source / 'deps/v8/third_party/simdutf'),
              '-include', str(private_include / private['configurationHeader'])]

    def compile_one(name):
        obj = work / (Path(name).stem + '.o')
        dep = work / (Path(name).stem + '.d')
        command = [*common, '-MD', '-MF', str(dep), str(staged / name), '-o', str(obj)]
        result = subprocess.run(command, capture_output=True, text=True)
        (work / (Path(name).stem + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            print(result.stdout + result.stderr, flush=True)
        return {'source': name, 'exit': result.returncode, 'command': command, 'object': obj}

    # Compile the complete engine cohort and collect all diagnostics before
    # stopping. This is not a reduced Node binding inventory.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        compiled = list(executor.map(compile_one, [
            'native-engine.cpp', 'buffer-memory.cpp', 'trace-utf8-native.cpp',
            'engine-process.cpp', 'fast-call-metadata.cpp']))
    if any(row['exit'] for row in compiled):
        raise ValueError('native bridge compile failed; complete logs in ' + str(work))
    forbidden = ['kandelo_node_codec_impl::', 'kandelo::node::CreateCodecState(',
                 'kandelo::node::GetRealmRuntime(', 'js::shell::GetShellContext(']
    for row in compiled:
        symbols = subprocess.check_output(['wasm32posix-nm', '--demangle',
                                          str(row['object'])], text=True)
        if any(name in symbols for name in forbidden):
            raise ValueError('preserved frontend symbol in native object: ' + row['source'])
        deps = (work / (Path(row['source']).stem + '.d')).read_text()
        if any(name in deps for name in ['codec-native-api.h', 'shell/jsshell.h',
                                        'process-native-api.h', 'native-owner-probe-inl.h']):
            raise ValueError('preserved frontend header in native object: ' + row['source'])

    library = output / 'lib/libkandelo-node-bridge.a'
    library.parent.mkdir(parents=True)
    subprocess.run(['wasm32posix-ar', 'rcs', str(library),
                    *[str(row['object']) for row in compiled]], check=True)
    include = output / 'include/kandelo-node-engine'
    include.mkdir(parents=True)
    shutil.copy2(staged / 'engine-native-api.h', include)
    shutil.copy2(staged / 'engine-maybe-api.h', include)
    shutil.copy2(staged / 'engine-string-flags.h', include)
    shutil.copy2(staged / 'engine-wire-codec.h', include)
    shutil.copy2(staged / 'engine-fast-call-config.h', include)
    shutil.copy2(staged / 'engine-gc-callback-api.h', include)
    shutil.copy2(staged / 'engine-property-enum-api.h', include)
    shutil.copy2(staged / 'engine-script-api.h', include)
    shutil.copy2(cache_header, include)
    shutil.copy2(staged / 'engine-gc-api.h', include)
    shutil.copy2(staged / 'property-interceptor-native-api.h', include)
    shutil.copytree(staged / 'v8-source-api', include / 'v8-source-api')
    source_headers = [{'path': 'v8-source-api/cppgc-heap-statistics.h',
                       'sha256': digest(cppgc_statistics),
                       'wholeOriginalSource': 'deps/v8/include/cppgc/heap-statistics.h'}]
    for name, implementation in sorted(SOURCE_INTERFACE_HEADERS.items()):
        header = include / name
        header.parent.mkdir(parents=True, exist_ok=True)
        header.write_text(
            '#pragma once\n'
            '// Node source interface; declarations use real SpiderMonkey storage.\n'
            '#include "v8config.h"\n'
            f'#include "{implementation}"\n')
        source_headers.append({'path': name, 'sha256': digest(header),
                               'implementation': implementation})
    # Node's util.h consumes StringView even in its inspector-disabled profile.
    # Keep the complete original portable declaration headers, not an excerpt
    # or a replacement Inspector implementation. All inline engine types resolve
    # through the actual source bridge above; unavailable operations stay missing.
    for name in ('v8-inspector.h', 'libplatform/libplatform.h'):
        original = args.node_source / 'deps/v8/include' / name
        header = include / name
        header.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, header)
        source_headers.append({'path': name, 'sha256': digest(header),
                               'wholeOriginalSource': 'deps/v8/include/' + name})
    pc = output / 'lib/pkgconfig/kandelo-node-bridge.pc'
    pc.parent.mkdir(parents=True)
    pc.write_text('''prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include/kandelo-node-engine
Name: Kandelo Node engine source bridge
Description: Native source interfaces; not a complete Node runtime SDK
Version: 26.13.0
Requires: mozjs-153
Requires.private: libuv v8-tracing
Libs: -L${libdir} -lkandelo-node-bridge
Cflags: -I${includedir}
''')
    docs = output / 'share/doc/spidermonkey-node/bridge'
    docs.mkdir(parents=True)
    for src, name in [
        (root / 'COPYING', 'COPYING'),
        (root / 'packages/registry/spidermonkey-node/bridge/README.md', 'README.md'),
        (args.node_source / 'LICENSE', 'LICENSE-node'),
        (args.node_source / 'deps/v8/LICENSE', 'LICENSE-v8'),
        (core / 'share/doc/spidermonkey-core/LICENSE', 'LICENSE-mozilla'),
    ]:
        shutil.copy2(src, docs / name)
    metadata = output / 'share/kandelo/node-engine-bridge.json'
    metadata.parent.mkdir(parents=True)
    metadata.write_text(json.dumps({
        'schema': 1, 'engine': 'SpiderMonkey', 'engineVersion': '153.7.0esr',
        'nodeVersion': '26.13.0', 'programAbi': 56,
        'target': 'wasm32-unknown-kandelo', 'legacyFrontendIncluded': False,
        'engineIdentitySha256': digest(identity_path),
        'privateHeaderManifestSha256': identity['privateHeaderManifestSha256'],
        'nodeSourceSha256': '986ead18ef18256831bae3e57d94aef680a7b84cfd4044f3e8471f833fbd7191',
        'library': {'path': 'lib/libkandelo-node-bridge.a', 'sha256': digest(library)},
        'sources': inputs, 'compiledSourceGroups': [row['source'] for row in compiled],
        'stringSourceContracts': string_metadata,
        'portableMaybeSourceContracts': maybe_metadata,
        'portableFastCallMetadata': fast_metadata,
        'portableProfilerMetadata': profiler_metadata,
        'regexpPropertySourceContracts': regexp_property_metadata,
        'valueWireSourceContracts': value_wire_metadata,
        'codeCacheIdentity': {'identity': cache_identity, 'versionTag': cache_version,
                              'contract': cache_contract,
                              'generatedHeader': 'include/kandelo-node-engine/engine-build-identity.h',
                              'generatedHeaderSha256': digest(cache_header)},
        'sourceInterfaceHeaders': source_headers,
        'nodeSDKComplete': False, 'runtimeQualified': False,
        'remaining': ['native cold entry and all consumed API implementations',
                      'original Node runtime owners and native providers',
                      'GC/resource/producer retirement and four-host qualification'],
    }, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['repository', 'work', 'node-source', 'core', 'libcxx', 'libuv', 'tracing', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    build(parser.parse_args())
