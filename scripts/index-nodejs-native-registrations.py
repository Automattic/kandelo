#!/usr/bin/env python3
"""Index authenticated C++ registration syntax without compiling or evaluating it."""
import argparse
import bisect
import hashlib
import json
from pathlib import Path
import re
import tarfile

MACROS = {
    'NODE_BINDING_CONTEXT_AWARE_INTERNAL': 'context-initializer',
    'NODE_BINDING_CONTEXT_AWARE_CPP': 'cpp-initializer',
    'NODE_BINDING_PER_ISOLATE_INIT': 'isolate-initializer',
    'NODE_BINDING_EXTERNAL_REFERENCE': 'external-reference-registration',
}
RAW_STRING = re.compile(r'(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(')


def mask_cpp(text):
    """Hide comments/literals while preserving character offsets and newlines."""
    output = list(text)
    i = 0
    while i < len(text):
        start = i
        if text.startswith('//', i):
            end = text.find('\n', i)
            i = len(text) if end < 0 else end
        elif text.startswith('/*', i):
            end = text.find('*/', i + 2)
            if end < 0:
                raise ValueError('unterminated C++ comment')
            i = end + 2
        else:
            raw = RAW_STRING.match(text, i)
            if raw:
                close = ')' + raw[1] + '"'
                end = text.find(close, raw.end())
                if end < 0:
                    raise ValueError('unterminated C++ raw string')
                i = end + len(close)
            elif text[i] in '\"\'' and not (
                    text[i] == "'" and i > 0 and text[i-1].isalnum()
                    and i+1 < len(text) and text[i+1].isalnum()):
                quote = text[i]
                i += 1
                while i < len(text):
                    if text[i] == '\\':
                        i += 2
                    elif text[i] == quote:
                        i += 1
                        break
                    else:
                        i += 1
                else:
                    raise ValueError('unterminated C++ quoted literal')
            else:
                i += 1
                continue
        for index in range(start, i):
            if output[index] != '\n':
                output[index] = ' '
    return ''.join(output)


def registration_sites(text):
    masked = mask_cpp(text)
    original_lines = text.splitlines(keepends=True)
    lines = masked.splitlines(keepends=True)
    guards = []
    line_guards = {}
    directive_lines = set()
    i = 0
    while i < len(lines):
        line_guards[i+1] = [dict(frame) for frame in guards]
        match = re.match(r'^\s*#\s*(\w+)\b', lines[i])
        if not match:
            i += 1
            continue
        start = i
        while lines[i].rstrip().endswith('\\') and i+1 < len(lines):
            i += 1
        directive_lines.update(range(start+1, i+2))
        directive = ''.join(original_lines[start:i+1]).strip()
        kind = match[1]
        if kind in ('if', 'ifdef', 'ifndef'):
            guards.append({'opening': directive, 'openingLine': start+1,
                           'arm': directive, 'armLine': start+1,
                           'previousArms': []})
        elif kind in ('elif', 'else'):
            if not guards:
                raise ValueError('unmatched preprocessor branch')
            previous = guards[-1]
            guards[-1] = {**previous, 'arm': directive, 'armLine': start+1,
                          'previousArms': [*previous['previousArms'], previous['arm']]}
        elif kind == 'endif':
            if not guards:
                raise ValueError('unmatched preprocessor endif')
            guards.pop()
        i += 1
    if guards:
        raise ValueError('unclosed preprocessor guard')
    starts = [0] + [m.end() for m in re.finditer('\n', text)]
    sites = []
    pattern = r'\b(' + '|'.join(MACROS) + r')\s*\('
    for match in re.finditer(pattern, masked):
        line = bisect.bisect_right(starts, match.start())
        if line in directive_lines:
            continue  # Macro definitions are declarations, not registrations.
        begin = match.end()
        depth, part, arguments = 1, begin, []
        for end in range(begin, len(masked)):
            char = masked[end]
            if char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
                if depth == 0:
                    arguments.append(text[part:end].strip())
                    break
            elif char == ',' and depth == 1:
                arguments.append(text[part:end].strip())
                part = end+1
        else:
            raise ValueError('unclosed native registration macro')
        name = mask_cpp(arguments[0]).strip()
        if not re.fullmatch(r'[A-Za-z_]\w*', name) or len(arguments) != 2:
            raise ValueError('unreviewed native registration arguments: ' + repr(arguments))
        sites.append({'name': name, 'macro': match[1], 'role': MACROS[match[1]],
                      'line': line, 'start': match.start(), 'end': end+1,
                      'initializerExpression': arguments[1],
                      'preprocessorGuards': line_guards[line]})
    return sites


def build_index(archive, manifest_path):
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    if archive_sha != manifest['source']['sha256']:
        raise ValueError('source archive identity mismatch')
    prefix = 'node-v' + manifest['version'] + '/'
    imported = {r['path']: r for r in manifest['files']}
    files, registrations = [], []
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            if not (member.isfile() and member.name.startswith(prefix+'src/')
                    and member.name.endswith(('.cc', '.h'))):
                continue
            path = member.name[len(prefix):]
            data = source.extractfile(member).read()
            identity = {'path': path, 'bytes': len(data),
                        'sha256': hashlib.sha256(data).hexdigest()}
            if path in imported and any(identity[k] != imported[path][k]
                                        for k in ('bytes', 'sha256')):
                raise ValueError('imported native source differs from archive: ' + path)
            try:
                sites = registration_sites(data.decode('utf8'))
            except ValueError as error:
                raise ValueError(path + ': ' + str(error)) from error
            files.append({**identity, 'registrations': len(sites),
                          'importedSource': path in imported})
            registrations.extend({**site, 'source': identity} for site in sites)
    registrations.sort(key=lambda r: (r['name'], r['source']['path'], r['line']))
    names = sorted({r['name'] for r in registrations})
    initializers = {r['name'] for r in registrations
                    if r['role'] in ('context-initializer', 'cpp-initializer')}
    return {
        'schema': 1,
        'scope': 'All src/**/*.cc and src/**/*.h registration syntax in the authenticated archive; macro definitions/comments/literals excluded; not compiled registry availability or API conformance',
        'target': {'version': manifest['version'], 'sourceCommit': manifest['source']['commit']},
        'archiveSha256': archive_sha,
        'sourceManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'sourceOffsetUnits': 'Unicode code points; line numbers are one-based',
        'counts': {'nativeFilesScanned': len(files), 'registrationSites': len(registrations),
                   'bindingNames': len(names), 'initializerNames': len(initializers),
                   'roles': {role: sum(r['role'] == role for r in registrations)
                             for role in MACROS.values()}},
        'files': sorted(files, key=lambda r: r['path']),
        'bindings': [{'name': name, 'hasInitializerSyntax': name in initializers,
                      'registrationIndexes': [i for i, r in enumerate(registrations) if r['name'] == name]}
                     for name in names],
        'registrations': registrations,
        'limits': ['Preprocessor arms are recorded, never evaluated or used as exclusions',
                   'GYP/configuration/build-file selection is not evaluated; a site does not mean the binding is built or usable',
                   'Only the four named registration macros in src C++ source/header files are recognized; custom/generated registration mechanisms need separate review',
                   'External addon and embedder-linked binding domains remain open',
                   'Initializer bodies, exported classes/members/signatures/errors/ownership and scheduling remain separate audit obligations'],
        'nativeContractCatalogComplete': False, 'runtimeEvidenceAdded': False,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = build_index(args.archive, args.manifest)
    args.output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result['counts']))
