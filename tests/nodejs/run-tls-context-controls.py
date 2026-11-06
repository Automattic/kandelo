#!/usr/bin/env python3
"""Focused host OpenSSL/NAPI/TCP trust controls; no product or global setup."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import runpy
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'third_party/node-core'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['native', 'node-source', 'openssl', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    include = output / 'include'
    include.mkdir(exist_ok=True)
    identity = json.loads((CORE / 'tls-context-sources.json').read_text())
    for name, item in identity['sources'].items():
        source = (CORE / item['path']).read_bytes()
        assert source == (args.node_source / name).read_bytes(), name
        assert hashlib.sha256(source).hexdigest() == item['sha256']
    generate = runpy.run_path(str(CORE / 'generate-tls-context.py'))
    (output / 'tls-context.generated.js').write_text(generate['generate'](CORE))
    (include / 'kandelo-node-tls-context-trust.h').write_text(generate['generate_header'](CORE))
    state = runpy.run_path(str(CORE / 'generate-tls-state.py'))
    (include / 'kandelo-node-tls-state.h').write_text(state['render'](CORE))
    empty = output / 'empty-cert-dir'
    empty.mkdir(exist_ok=True)
    environment = {**os.environ, 'TLS_TRUST_ADDON': str(output / 'trust.node'),
                   'TLS_TRUST_KEYS': str(args.node_source / 'test/fixtures/keys'),
                   'TLS_TRUST_OUT': str(output),
                   'SSL_CERT_FILE': str(args.node_source / 'test/fixtures/keys/ca1-cert.pem'),
                   'SSL_CERT_DIR': str(empty)}
    results = []

    def run(label, command, timeout=60):
        try:
            p = subprocess.run([str(x) for x in command], cwd=ROOT, env=environment,
                               capture_output=True, text=True, timeout=timeout)
            (output / (label + '.stdout')).write_text(p.stdout)
            (output / (label + '.stderr')).write_text(p.stderr)
            row = {'name': label, 'command': [str(x) for x in command],
                   'exit': p.returncode, 'status': 'pass' if p.returncode == 0 else 'nonpass'}
        except subprocess.TimeoutExpired as error:
            row = {'name': label, 'status': 'timeout', 'command': [str(x) for x in command]}
            for stream in ['stdout', 'stderr']:
                value = getattr(error, stream)
                (output / (label + '.' + stream)).write_bytes(value if isinstance(value, bytes) else (value or '').encode())
        results.append(row)
        return row

    run('native-version', [args.native, '-e', "if(process.version!=='v26.13.0')process.exit(1)"])
    run('bundle-check', [sys.executable, CORE / 'build.py', '--check'])
    run('build-inputs', [sys.executable, CORE / 'check-build-inputs.py'])
    for name in ['third_party/node-core/node-core.js', 'packages/registry/node-compat/bootstrap.js']:
        run('syntax-' + Path(name).stem, [args.native, '--check', ROOT / name])
    flags = ['clang++', '-std=c++20', '-O1', '-I', include,
             '-I', args.openssl / 'include']
    libraries = [args.openssl / 'libssl.a', args.openssl / 'libcrypto.a', '-pthread']
    addon = run('build-napi-fixture', [*flags, '-fPIC', '-shared', '-undefined', 'dynamic_lookup',
                '-fvisibility=hidden', '-I', args.node_source / 'src',
                ROOT / 'host/test/fixtures/node-tls-context-addon.cpp', *libraries,
                '-o', output / 'trust.node'])
    allocations = run('build-allocation-fixture', [*flags,
                      ROOT / 'host/test/fixtures/node-tls-context-allocations.cpp',
                      *libraries, '-o', output / 'allocations'])
    if addon['status'] == 'pass':
        run('tcp-trust-controls', [args.native, '--use-openssl-ca', '--expose-internals',
                                  ROOT / 'host/test/fixtures/node-tls-context-controls.cjs'], 60)
    fault_rows = []
    if allocations['status'] == 'pass':
        # The thirteen allocation sites were observed in selected OpenSSL3.3.2.
        # Later indices are controls proving they were not actually reached.
        for number in [-1, *range(16)]:
            row = run('allocation-' + str(number), [output / 'allocations', number], 10)
            if row['status'] == 'pass':
                data = json.loads((output / (row['name'] + '.stdout')).read_text())
                assert data['liveAllocationsAfterCleanup'] == data['liveBytesAfterCleanup'] == 0
                if 0 <= number < 13:
                    assert data['faultInjected'] and data['sslNewFailed']
                fault_rows.append(data)
    inputs = [args.native, args.openssl / 'libssl.a', args.openssl / 'libcrypto.a',
              args.openssl / 'include/openssl/opensslv.h', ROOT / 'third_party/node-core/node-core.js',
              ROOT / 'packages/registry/node-compat/bootstrap.js',
              ROOT / 'third_party/node-core/native-tls-context.cpp',
              ROOT / 'host/test/fixtures/node-tls-context-addon.cpp',
              ROOT / 'host/test/fixtures/node-tls-context-controls.cjs',
              ROOT / 'host/test/fixtures/node-tls-context-allocations.cpp']
    report = {'scope': 'Pinned CA source; real selected OpenSSL3.3.2 via NAPI fixture, TCP and allocator controls; not production JSAPI/GC/watch execution',
              'source': identity, 'commands': results, 'allocatorControls': fault_rows,
              'identities': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs},
              'notRun': ['engine/package/product build', 'Vitest global setup', 'overall suite',
                         'production SpiderMonkey GC/realm/watch/fatal/OOM/worker/TLS cancellation',
                         'four-host conformance', 'public default/SecureContext API parity'],
              'defaultMode': 'Explicit native --use-openssl-ca plus actual SSL_CERT_FILE; not default native bundled CA store parity',
              'partialChainMode': 'CA-only peers explicitly disable hostname checking on both sides, as in the pinned upstream partial-chain test; not identity conformance'}
    (output / 'runner-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'groups': len(results), 'pass': sum(x['status'] == 'pass' for x in results),
                      'actualInjectedAllocationFailures': sum(x['faultInjected'] for x in fault_rows),
                      'output': str(output)}))
    return int(any(row['status'] != 'pass' for row in results))


if __name__ == '__main__':
    raise SystemExit(main())
