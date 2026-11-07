#!/usr/bin/env python3
"""Embed unchanged pinned CA validation/configuration over actual SSL_CTX state."""
from pathlib import Path
import argparse
import hashlib
import json
import runpy


def generate(root):
    identity = json.loads((root / 'tls-context-sources.json').read_text())
    core = json.loads((root / 'sources.json').read_text())
    if (identity['version'], identity['commit']) != (core['version'], core['commit']):
        raise ValueError('TLS trust must retain the exact Node target')
    sources = {}
    for name, item in identity['sources'].items():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('TLS trust reference mismatch: ' + name)
        sources[name] = raw.decode()
    adapter = (root / 'tls-context-adapter.js').read_text()
    markers = {'validation': '/* NODE_TLS_CA_VALIDATION */', 'addCA': '/* NODE_TLS_ADD_CA_CERTS */',
               'configureCA': '/* NODE_TLS_CONFIGURE_CA */', 'partial': '/* NODE_TLS_PARTIAL_CHAIN */',
               'setCerts': '/* NODE_TLS_SET_CERTS */', 'setKey': '/* NODE_TLS_SET_KEY */',
               'configureCert': '/* NODE_TLS_CONFIGURE_CERT */', 'configureKey': '/* NODE_TLS_CONFIGURE_KEY */',
               'configurePFX': '/* NODE_TLS_CONFIGURE_PFX */',
               'protocolVersion': '/* NODE_TLS_PROTOCOL_VERSION */',
               'getDefaultCiphers': '/* NODE_TLS_GET_DEFAULT_CIPHERS */',
               'getDefaultEcdhCurve': '/* NODE_TLS_GET_DEFAULT_ECDH */',
               'processCiphers': '/* NODE_TLS_PROCESS_CIPHERS */',
               'optionInputs': '/* NODE_TLS_OPTION_INPUTS */',
               'configureCiphers': '/* NODE_TLS_CONFIGURE_CIPHERS */'}
    for name, selector in identity['selections'].items():
        source = sources[selector['source']]
        if source.count(selector['start']) != 1:
            raise ValueError('Ambiguous TLS trust selection: ' + name)
        start = source.index(selector['start'])
        text = source[start:start + selector['length']]
        if hashlib.sha256(text.encode()).hexdigest() != selector['sha256']:
            raise ValueError('TLS trust selection mismatch: ' + name)
        marker = markers[name]
        if adapter.count(marker) != 1:
            raise ValueError('TLS trust adapter marker mismatch: ' + marker)
        adapter = adapter.replace(marker, text)
    marker = '/* NODE_TLS_TO_BUF */'
    if adapter.count(marker) != 1: raise ValueError('TLS credential toBuf marker')
    adapter = adapter.replace(marker, runpy.run_path(str(root / 'generate-tls-credentials.py'))['to_buf']())
    return adapter


def generate_header(root):
    # generate() verifies every complete pinned reference first.
    generate(root)
    identity = json.loads((root / 'tls-context-sources.json').read_text())
    selector = identity['errorReason']
    raw = (root / identity['sources'][selector['source']]['path']).read_text()
    start = raw.index(selector['start'])
    text = raw[start:start + selector['length']]
    if hashlib.sha256(text.encode()).hexdigest() != selector['sha256']:
        raise ValueError('TLS verification reason selection mismatch')
    replacements = [
        ('MaybeLocal<Value> GetValidationErrorReason(Environment* env, int err)',
         'inline std::string TrustVerificationReason(int err, bool useSystemCa = false)'),
        ('X509Pointer::ErrorReason(err).value_or("")', 'X509_verify_cert_error_string(err)'),
        ('return Undefined(env->isolate());', 'return {};'),
        ('!env->options()->use_system_ca', '!useSystemCa'),
        ('return OneByteString(env->isolate(), reason);', 'return reason;'),
    ]
    for old, new in replacements:
        if text.count(old) != 1:
            raise ValueError('Review verification reason boundary: ' + old)
        text = text.replace(old, new)
    header = (root / 'tls-context-trust.h').read_text()
    marker = '// NODE_TLS_VERIFICATION_REASON'
    if header.count(marker) != 1:
        raise ValueError('Review TLS verification reason marker')
    return header.replace(marker, text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    parser.add_argument('--header', type=Path)
    args = parser.parse_args()
    if not args.output and not args.header:
        parser.error('at least one output is required')
    if args.output:
        args.output.write_text(generate(Path(__file__).resolve().parent))
    if args.header:
        args.header.write_text(generate_header(Path(__file__).resolve().parent))
