#!/usr/bin/env python3
"""Focused pinned-source and real-TCP OutgoingMessage dependency controls.

Use scripts/dev-shell.sh. No Vitest global setup, product build, guest process,
or full-suite runner is invoked. Native stream/parser/async/clock/socket owners
are explicit test boundaries, not evidence for guest or browser conformance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'third_party/node-core'


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--native', type=Path, required=True)
    args.add_argument('--node-source', type=Path, required=True)
    args.add_argument('--output', type=Path, required=True)
    options = args.parse_args()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    identity = json.loads((CORE / 'http-outgoing-sources.json').read_text())
    target = json.loads((ROOT / 'packages/registry/node-compat/target.json').read_text())
    assert identity['version'] == target['version'] == '26.13.0'
    assert identity['commit'] == target['source']['commit']
    for name, item in identity['sources'].items():
        actual = (CORE / item['path']).read_bytes()
        assert actual == (options.node_source / name).read_bytes(), name
        assert hashlib.sha256(actual).hexdigest() == item['sha256'], name
    generated = runpy.run_path(str(CORE / 'generate-http-outgoing.py'))['generate'](CORE)
    full = (CORE / identity['sources']['lib/_http_outgoing.js']['path']).read_text()
    assert full in generated
    (output / 'http-outgoing.generated.js').write_text(generated)
    results = []
    environment = {**os.environ, 'HTTP_OUTGOING_OUT': str(output)}

    def run(label, command, report=False, timeout=30):
        try:
            result = subprocess.run([str(x) for x in command], cwd=ROOT,
                                    env=environment, capture_output=True,
                                    text=True, timeout=timeout)
            (output / (label + '.stdout')).write_text(result.stdout)
            (output / (label + '.stderr')).write_text(result.stderr)
            row = {'name': label, 'command': [str(x) for x in command],
                   'exitCode': result.returncode, 'status': 'pass' if result.returncode == 0 else 'fail'}
            if report and result.returncode == 0:
                try:
                    data = json.loads(result.stdout)
                    if label.startswith('affected-'):
                        assert data['case'] == label.removeprefix('affected-') and data['passed'] is True
                    else:
                        assert data['guest'] == 'not built/executed'
                        assert data.get('outgoingComponentCases', data.get('requestFramingCases')) > 0
                    row['report'] = data
                except Exception as error:
                    row.update(status='fail', diagnostic='missing/invalid completion report: ' + str(error))
        except subprocess.TimeoutExpired as error:
            row = {'name': label, 'status': 'timeout', 'command': [str(x) for x in command]}
            for stream in ['stdout', 'stderr']:
                data = getattr(error, stream)
                (output / (label + '.' + stream)).write_bytes(data if isinstance(data, bytes) else (data or '').encode())
        results.append(row)

    run('native-version', [options.native, '-e', "if(process.version!=='v26.13.0')process.exit(1)"])
    run('bundle-check', [sys.executable, CORE / 'build.py', '--check'])
    for name in ['third_party/node-core/node-core.js', 'packages/registry/node-compat/bootstrap.js']:
        run('syntax-' + Path(name).stem, [options.native, '--check', ROOT / name])
    for label, script in [('outgoing-component', 'node-http-outgoing-controls.cjs'),
                          ('request-framing', 'node-http-request-framing-controls.cjs')]:
        run(label, [options.native, '--expose-internals', ROOT / 'host/test/fixtures' / script], True)
    for name in ['constructorAndDescriptors', 'headerAndTrailerState', 'readTimeoutAndAbort',
                 'fragmentedWireHeadersAndTrailers', 'parserCompletionRetainsUnreadResponse',
                 'earlyResponseRetainsPendingWrite', 'informationalBeforeFinalResponse',
                 'headResponseHasNoBody', 'upgradeAndConnectTransferHead', 'malformedFramingAndHeaderLimits',
                 'parserOptionErrors', 'headerCountIsAppliedBeforeIncomingHeaders',
                 'unsolicitedResponseBytesAreNotReused', 'pooledFailureDoesNotReplayPost']:
        run('affected-' + name, [options.native, '--expose-internals',
                                ROOT / 'host/test/fixtures/node-http-incoming-control.cjs', name], True, 15)
    report = {'source': identity, 'workdir': str(ROOT), 'results': results,
              'boundaries': ['actual native Node26.13 stream/Buffer allocation/task queues/async/clock/URL',
                             'actual native response-parser binding in candidate frontend fixture',
                             'real native TCP peers in new framing controls; existing affected cases retain their own explicit dependency boundaries'],
              'notRun': ['production SpiderMonkey JSAPI', 'guest HTTP socket/stream integration',
                         'TLS framing', 'four-host conformance', 'unchanged upstream suite',
                         'product build', 'overall suite']}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'groups': len(results), 'passing': sum(x['status'] == 'pass' for x in results),
                      'output': str(output), 'scope': 'focused source/native dependency controls only'}))
    return int(any(x['status'] != 'pass' for x in results))


if __name__ == '__main__':
    raise SystemExit(main())
