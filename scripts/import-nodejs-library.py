#!/usr/bin/env python3
"""Import pinned upstream Node JS sources unchanged; never build or execute them."""
import argparse
import ast
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def select_sources(members, prefix):
    """Use upstream build lists as data, without running configure or GYP."""
    def read(name):
        return members[prefix + name]

    gyp = ast.literal_eval(read('node.gyp').decode())
    configure = ast.parse(read('configure.py').decode())
    shareable = None
    for stmt in configure.body:
        if isinstance(stmt, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == 'shareable_builtins'
            for t in stmt.targets
        ):
            shareable = ast.literal_eval(stmt.value)
            break
    if not isinstance(shareable, dict):
        raise ValueError('upstream shareable builtin definition changed')
    dependencies = []
    for name in gyp['variables']['deps_files']:
        if name == '<@(node_builtin_shareable_builtins)':
            dependencies.extend(shareable.values())
        elif '<' in name:
            raise ValueError('unreviewed GYP expansion: ' + name)
        else:
            dependencies.append(name)
    library = sorted(name[len(prefix):] for name in members
                     if name.startswith(prefix + 'lib/'))
    # Preserve all library files, even non-runtime documentation. Import optional
    # JS dependencies too; presence does not advertise the corresponding feature.
    selection = {name: ('library' if name.endswith(('.js', '.mjs')) else 'library-support')
                 for name in library}
    selection.update({name: 'dependency' for name in dependencies})
    selection.update({name: 'provenance' for name in
                      ['LICENSE', 'README.md', 'node.gyp', 'configure.py',
                       'tools/js2c.cc', 'src/node_builtins.cc', 'src/node_builtins.h',
                       'src/node_realm.cc', 'src/node_realm.h',
                       'src/builtin_info.cc', 'src/builtin_info.h',
                       'src/env_properties.h', 'src/node_exit_code.h',
                       'src/env.h', 'src/async_wrap.h', 'src/async_wrap.cc',
                       'src/node_types.cc',
                       'src/string_decoder.cc', 'src/string_decoder.h',
                       'src/string_decoder-inl.h', 'src/string_bytes.cc',
                       'src/string_bytes.h', 'src/node_buffer.h', 'src/node_buffer.cc',
                       'src/node_errors.h',
                       'src/node_i18n.cc', 'src/node_i18n.h',
                       'src/api/encoding.cc', 'src/util-inl.h',
                       'src/node_internals.h',
                       'src/node_trace_events.cc',
                       'src/async_context_frame.cc', 'src/async_context_frame.h',
                       'src/tracing/agent.h',
                       'src/tracing/agent.cc',
                       'src/tracing/agent_legacy.h',
                       'src/tracing/agent_legacy.cc',
                       'src/tracing/node_trace_buffer.h',
                       'src/tracing/node_trace_buffer.cc',
                       'src/tracing/node_trace_writer.h',
                       'src/tracing/node_trace_writer.cc',
                       'src/tracing/traced_value.h',
                       'src/tracing/traced_value.cc',
                       'src/tracing/trace_event_helper.h',
                       'src/tracing/trace_event_helper.cc',
                       'src/tracing/trace_event.h',
                       'src/tracing/trace_event_legacy_inl.h',
                       'deps/v8/src/builtins/builtins-trace.cc',
                       'deps/v8/src/common/message-template.h',
                       'deps/v8/src/strings/unicode.h',
                       'deps/v8/src/strings/unicode-inl.h',
                       'deps/v8/third_party/utf8-decoder/utf8-decoder.h',
                       'src/node_version.h', 'src/node_metadata.h',
                       'src/node_metadata.cc', 'src/node_process_object.cc',
                       'src/node_options.cc', 'src/node_options.h',
                       'src/node_options-inl.h', 'src/node_mutex.h',
                       'src/quic/guard.h', 'deps/ncrypto/ncrypto.h',
                       'src/node_constants.cc', 'src/node_constants.h',
                       'src/node_zlib.cc', 'src/node.h', 'src/util.h',
                       'src/tracing/trace_event_legacy.h',
                       'deps/brotli/LICENSE',
                       'deps/brotli/c/include/brotli/decode.h',
                       'deps/brotli/c/include/brotli/encode.h',
                       'deps/brotli/c/include/brotli/port.h',
                       'deps/brotli/c/include/brotli/shared_dictionary.h',
                       'deps/brotli/c/include/brotli/types.h']})
    dependency_roots = {str(PurePosixPath(name).parents[len(PurePosixPath(name).parts)-3])
                        for name in dependencies}
    # Include dependency licensing at original paths. Node's top-level LICENSE
    # also contains notices for bundled components.
    for name in members:
        rel = name[len(prefix):] if name.startswith(prefix) else ''
        if any(rel.startswith(root + '/') for root in dependency_roots):
            if PurePosixPath(rel).name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE')):
                selection[rel] = 'license'
    selection['deps/v8/AUTHORS'] = 'license'
    return selection, dependencies, shareable


def module_id(name):
    if name.startswith('lib/') and name.endswith(('.js', '.mjs')):
        if name == 'lib/eslint.config_partial.mjs':
            return None
        return name[4:].rsplit('.', 1)[0]
    if name.startswith('deps/') and name.endswith(('.js', '.mjs')):
        return 'internal/deps/' + name[5:].rsplit('.', 1)[0]
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path,
                        help='new destination directory; existing paths are refused')
    args = parser.parse_args()
    target_bytes = args.target.read_bytes()
    target = json.loads(target_bytes)
    archive = args.archive.read_bytes()
    if digest(archive) != target['source']['sha256']:
        raise ValueError('source archive does not match pinned SHA-256')
    prefix = f"node-v{target['version']}/"
    members = {}
    with tarfile.open(args.archive, 'r:gz') as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('unsafe archive path: ' + member.name)
            if member.isfile():
                if member.name in members:
                    raise ValueError('duplicate archive file: ' + member.name)
                members[member.name] = tar.extractfile(member).read()
    selected, deps, shareable = select_sources(members, prefix)
    records = []
    ids = {}
    for name, role in sorted(selected.items()):
        data = members[prefix + name]
        builtin_id = module_id(name)
        if builtin_id:
            if builtin_id in ids:
                raise ValueError('duplicate builtin id: ' + builtin_id)
            ids[builtin_id] = name
        records.append({'path': name, 'role': role, 'bytes': len(data),
                        'sha256': digest(data), 'builtinId': builtin_id})
    manifest = {
        'schema': 1, 'version': target['version'],
        'source': target['source'], 'targetFileSha256': digest(target_bytes),
        'selection': {
            'library': 'entire lib/ tree, including non-runtime support files',
            'dependencies': 'node.gyp deps_files plus all configure.py shareable_builtins',
            'optionalDependenciesImported': True,
            'runtimeFeatureConfiguration': 'not selected; source availability is not support',
            'moduleIdRule': 'tools/js2c.cc GetFileId; source extensions removed, deps/ -> internal/deps/',
            'linkedExternalModules': 'none; these are embedder additions, not upstream core',
            'generatedConfig': 'config.gypi is runtime-build state; not copied or fabricated from the native reference',
        },
        'dependencyPaths': deps, 'shareableBuiltins': shareable,
        'unchangedUpstreamBytes': True, 'runtimeActivated': False,
        'runtimeConformance': 'not established', 'files': records,
    }
    args.output.mkdir(parents=True, exist_ok=False)
    for record in records:
        path = args.output / 'upstream' / record['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(members[prefix + record['path']])
    (args.output / 'target.json').write_bytes(target_bytes)
    (args.output / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for record in records:
        if digest((args.output / 'upstream' / record['path']).read_bytes()) != record['sha256']:
            raise ValueError('written source changed: ' + record['path'])
    print(json.dumps({'importedFiles': len(records), 'builtinSources': len(ids),
                      'sourceBytes': sum(r['bytes'] for r in records),
                      'output': str(args.output), 'runtimeActivated': False}))


if __name__ == '__main__':
    main()
