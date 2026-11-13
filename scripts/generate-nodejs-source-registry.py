#!/usr/bin/env python3
"""Embed verified, unchanged upstream Node builtin sources for a native backend.

The consumer defines NodeBuiltinSourceEntry(id, sourcePath, offset, length,
diagnosticFilename, kindName, parameters, parameterCount). Source kinds and
arguments come from a host tool compiled against original builtin_info.cc/h;
this generator validates its protocol but never classifies sources itself.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile


_SAFE_NAME = re.compile(r'[A-Za-z0-9_./-]+\Z')
_SHA256 = re.compile(r'[0-9a-f]{64}\Z')
_BUILTIN_INFO = frozenset(('src/builtin_info.cc', 'src/builtin_info.h'))
# Protocol vocabulary only. No source-to-kind or kind-to-arguments mapping.
_KINDS = frozenset(('kBootstrapRealm', 'kBootstrapScript', 'kPerContextScript',
                    'kMainScript', 'kFunction', 'kSourceTextModule'))
_PARAMETERS = frozenset(('process', 'getLinkedBinding', 'getInternalBinding',
                         'primordials', 'require', 'internalBinding', 'exports',
                         'privateSymbols', 'perIsolateSymbols', 'module'))


def safe_relative_name(value, label):
    """Refuse ambiguous spellings as well as paths escaping the import root."""
    if not isinstance(value, str) or not _SAFE_NAME.fullmatch(value):
        raise ValueError(f'invalid {label}: {value!r}')
    path = PurePosixPath(value)
    if (path.is_absolute() or '..' in path.parts or '.' in value.split('/') or
            path.as_posix() != value):
        raise ValueError(f'unsafe {label}: {value!r}')
    return path


def source_bytes(root, relative):
    """Accept only ordinary files reached through ordinary directories."""
    current = root
    if not stat.S_ISDIR(current.lstat().st_mode):
        raise ValueError(f'upstream source root is not a directory: {current}')
    for component in relative.parts[:-1]:
        current = current / component
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise ValueError(f'source ancestor is not a directory: {current}')
    path = root / relative
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f'source is not an ordinary file: {path}')
    # Verify and emit the same immutable byte sequence.
    return path.read_bytes()


def load_sources(manifest):
    manifest_bytes = manifest.read_bytes()
    document = json.loads(manifest_bytes)
    if not isinstance(document, dict) or type(document.get('schema')) is not int or document['schema'] != 1:
        raise ValueError('unsupported Node sources manifest schema')
    records = document.get('files')
    if not isinstance(records, list):
        raise ValueError('manifest files must be an array')
    root = manifest.parent / 'upstream'
    paths = set()
    ids = set()
    sources = []
    builtin_info_hashes = {}
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('manifest file record must be an object')
        relative = safe_relative_name(record.get('path'), 'source path')
        name = relative.as_posix()
        if name in paths:
            raise ValueError(f'duplicate source path: {relative}')
        paths.add(name)
        if 'builtinId' not in record:
            raise ValueError(f'missing builtin ID field: {relative}')
        identifier = record['builtinId']
        if identifier is not None:
            safe_relative_name(identifier, 'builtin ID')
            if identifier in ids:
                raise ValueError(f'duplicate builtin ID: {identifier}')
            ids.add(identifier)
            if relative.suffix not in ('.js', '.mjs'):
                raise ValueError(f'builtin source has no JS/MJS extension: {relative}')
        elif name not in _BUILTIN_INFO:
            continue
        size = record.get('bytes')
        expected = record.get('sha256')
        if type(size) is not int or size < 0:
            raise ValueError(f'invalid source byte length: {relative}')
        if not isinstance(expected, str) or not _SHA256.fullmatch(expected):
            raise ValueError(f'invalid source SHA-256: {relative}')
        data = source_bytes(root, relative)
        if len(data) != size or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f'upstream source hash/length drift: {relative}')
        if name in _BUILTIN_INFO:
            builtin_info_hashes[name] = expected
        if identifier is not None:
            sources.append((identifier, name, data))
    if set(builtin_info_hashes) != _BUILTIN_INFO:
        raise ValueError('manifest must include original src/builtin_info.cc and .h')
    if not sources or not any(data for _, _, data in sources):
        raise ValueError('manifest contains no nonempty builtin sources')
    sources.sort(key=lambda entry: entry[0])
    return sources, hashlib.sha256(manifest_bytes).hexdigest(), builtin_info_hashes


def load_metadata(sources, metadata_tool):
    metadata_tool = Path(metadata_tool).absolute()
    if not stat.S_ISREG(metadata_tool.lstat().st_mode):
        raise ValueError('metadata tool must be an ordinary executable file')
    tool_hash = hashlib.sha256(metadata_tool.read_bytes()).hexdigest()
    request = ''.join(f'{identifier}\t{path}\n' for identifier, path, _ in sources).encode('ascii')
    try:
        result = subprocess.run([str(metadata_tool)], input=request, capture_output=True,
                                check=False, timeout=30)
    except subprocess.TimeoutExpired as error:
        raise ValueError('metadata tool timed out') from error
    if result.returncode != 0:
        raise ValueError(f'metadata tool failed with exit status {result.returncode}')
    if hashlib.sha256(metadata_tool.read_bytes()).hexdigest() != tool_hash:
        raise ValueError('metadata tool changed during generation')
    try:
        output = result.stdout.decode('ascii')
    except UnicodeDecodeError as error:
        raise ValueError('metadata tool returned non-ASCII protocol data') from error
    if not output.endswith('\n'):
        raise ValueError('metadata tool output must end with a newline')
    rows = output[:-1].split('\n')
    if len(rows) != len(sources):
        raise ValueError('metadata tool output count differs from source count')
    metadata = []
    for source, row in zip(sources, rows):
        fields = row.split('\t')
        if len(fields) != 4 or fields[:2] != list(source[:2]):
            raise ValueError('metadata tool changed source identity/order or field count')
        kind = fields[2]
        if kind not in _KINDS:
            raise ValueError(f'metadata tool returned unknown source kind: {kind!r}')
        parameters = tuple(fields[3].split(',')) if fields[3] else ()
        if any(parameter not in _PARAMETERS for parameter in parameters):
            raise ValueError('metadata tool returned an unknown/unsafe parameter name')
        if len(set(parameters)) != len(parameters):
            raise ValueError('metadata tool returned duplicate parameters')
        if kind == 'kSourceTextModule' and parameters:
            raise ValueError('source-text module metadata must have no function parameters')
        metadata.append((kind, parameters))
    return metadata, tool_hash


def generate(manifest, output, metadata_tool):
    manifest = Path(manifest).absolute()
    output = Path(output).absolute()
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside the Node source import directory')
    if output.resolve() == Path(metadata_tool).resolve():
        raise ValueError('output must not replace the metadata tool')
    if output.is_symlink():
        raise ValueError('output must not be a symlink')
    sources, manifest_hash, builtin_info_hashes = load_sources(manifest)
    metadata, tool_hash = load_metadata(sources, metadata_tool)
    argument_arrays = {}
    for _, parameters in metadata:
        if parameters and parameters not in argument_arrays:
            argument_arrays[parameters] = f'kNodeBuiltinParameters{len(argument_arrays)}'
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='ascii', newline='\n',
                                         prefix='.' + output.name + '.', suffix='.tmp',
                                         dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write('// Generated by scripts/generate-nodejs-source-registry.py.\n')
            stream.write('// Unchanged upstream source bytes; do not edit.\n')
            stream.write(f'// sources.json SHA-256: {manifest_hash}\n')
            stream.write(f'// Metadata tool SHA-256: {tool_hash}\n')
            for path, digest in sorted(builtin_info_hashes.items()):
                stream.write(f'// {path} SHA-256: {digest}\n')
            stream.write('\nstatic constexpr unsigned char kNodeBuiltinBytes[] = {\n')
            for _, _, data in sources:
                for start in range(0, len(data), 16):
                    stream.write('  ' + ', '.join(f'0x{value:02x}' for value in data[start:start + 16]) + ',\n')
            stream.write('};\n\n')
            for parameters, name in argument_arrays.items():
                values = ', '.join(json.dumps(parameter) for parameter in parameters)
                stream.write(f'static constexpr const char* const {name}[] = {{{values}}};\n')
            stream.write('\nstatic constexpr NodeBuiltinSourceEntry kNodeBuiltinEntries[] = {\n')
            offset = 0
            for (identifier, source_path, data), (kind, parameters) in zip(sources, metadata):
                name = argument_arrays[parameters] if parameters else 'nullptr'
                stream.write(f'  {{{json.dumps(identifier)}, {json.dumps(source_path)}, {offset}, {len(data)}, '
                             f'{json.dumps("node:" + identifier)}, {json.dumps(kind)}, {name}, {len(parameters)}}},\n')
                offset += len(data)
            stream.write('};\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, output)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {'builtinSources': len(sources), 'sourceBytes': offset,
            'manifestSha256': manifest_hash, 'metadataToolSha256': tool_hash,
            'builtinInfoSha256': builtin_info_hashes, 'output': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path,
                        default=Path(__file__).resolve().parents[1] / 'third_party/nodejs/sources.json')
    parser.add_argument('--metadata-tool', required=True, type=Path,
                        help='host executable built with original Node builtin_info.cc/h')
    parser.add_argument('--output', required=True, type=Path,
                        help='generated C++ include outside the source import, in a build/work directory')
    args = parser.parse_args()
    try:
        result = generate(args.manifest, args.output, args.metadata_tool)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Node builtin source registry: {error}\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
