#!/usr/bin/env python3
"""Read pinned native enum/macro declarations; generate no JS or runtime state."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def enum_names(text, name):
    match = re.search(r'\benum\s+' + re.escape(name) + r'\s*\{([^}]+)\}', text)
    if not match:
        raise ValueError('missing native enum: ' + name)
    body = re.sub(r'/\*.*?\*/|//[^\n]*', '', match[1], flags=re.S)
    names = [name.strip() for name in body.split(',') if name.strip()]
    if not names or not all(re.fullmatch(r'k[A-Za-z0-9_]+', name) for name in names):
        raise ValueError('unreviewed enum grammar: ' + name)
    if len(set(names)) != len(names):
        raise ValueError('duplicate enum names')
    return names


def providers(text, name):
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith('#define ' + name + '(V)'))
    if not lines[start].rstrip().endswith('\\'):
        raise ValueError('unreviewed provider macro header')
    names = []
    for line in lines[start + 1:]:
        match = re.fullmatch(r'\s*V\(([A-Z0-9_]+)\)\s*(\\)?', line)
        if not match:
            raise ValueError('unreviewed provider macro grammar: ' + line)
        names.append(match[1])
        if not match[2]:
            return names
    raise ValueError('unterminated provider macro')


def generate(manifest, output):
    document = json.loads(manifest.read_text())
    sources = {}
    identities = {}
    for name in ['src/env.h', 'src/async_wrap.h', 'src/async_wrap.cc']:
        record = next(record for record in document['files'] if record['path'] == name)
        data = (manifest.parent / 'upstream' / name).read_bytes()
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('native source identity mismatch: ' + name)
        sources[name] = data.decode('utf8')
        identities[name] = record['sha256']
    env = sources['src/env.h'].split('class AsyncHooks :', 1)[1]
    fields, ids = enum_names(env, 'Fields'), enum_names(env, 'UidFields')
    exported = re.findall(r'\bSET_HOOKS_CONSTANT\((k[A-Za-z0-9_]+)\)', sources['src/async_wrap.cc'])
    if len(set(exported)) != len(exported) or set(exported) != set(fields[:-1] + ids[:-1]):
        raise ValueError('native exported field set changed')
    common = providers(sources['src/async_wrap.h'], 'NODE_ASYNC_NON_CRYPTO_PROVIDER_TYPES')
    crypto = providers(sources['src/async_wrap.h'], 'NODE_ASYNC_CRYPTO_PROVIDER_TYPES')
    if len(set(common + crypto)) != len(common + crypto):
        raise ValueError('duplicate native providers')
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside the imported sources')
    lines = ['// Generated from complete verified native Node declarations. Do not edit.',
             '// Only API enum indices/names, not target layouts, live IDs or capability claims.',
             '#ifndef KANDELO_NODE_ASYNC_METADATA_H', '#define KANDELO_NODE_ASYNC_METADATA_H',
             'namespace kandelo::node::asyncmeta {',
             'enum Field { ' + ', '.join(fields) + ' };',
             'enum UidField { ' + ', '.join(ids) + ' };',
             'struct NamedValue { const char* name; int value; };',
             'inline constexpr NamedValue kConstants[] = {']
    lines += [f'  {{"{name}", {name}}},' for name in exported]
    lines += ['};', 'enum Provider {']
    lines += ['  PROVIDER_' + name + ',' for name in common]
    lines += ['#ifdef OPENSSL_VERSION_NUMBER']
    lines += ['  PROVIDER_' + name + ',' for name in crypto]
    lines += ['#endif', '  PROVIDERS_LENGTH', '};', 'inline constexpr NamedValue kProviders[] = {']
    lines += [f'  {{"{name}", PROVIDER_{name}}},' for name in common]
    lines += ['#ifdef OPENSSL_VERSION_NUMBER']
    lines += [f'  {{"{name}", PROVIDER_{name}}},' for name in crypto]
    lines += ['#endif', '};', '}  // namespace kandelo::node::asyncmeta', '#endif', '']
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(lines))
    return {'nativeSourceHashes': identities, 'fields': len(fields)-1, 'idFields': len(ids)-1,
            'exportedConstants': len(exported), 'nonCryptoProviders': len(common), 'cryptoProviders': len(crypto),
            'runtimeStateGenerated': False, 'javascriptGenerated': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(generate(args.manifest, args.output)))
