"""Check the audited native reference; this does not test Kandelo execution."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import sys


def identity(path):
    path = Path(path)
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path.resolve()), 'bytes': path.stat().st_size,
            'sha256': digest}


if len(sys.argv) != 3:
    raise SystemExit('usage: run-nodejs-constructor-name-reference.py <native-node> <new-report-directory>')
native = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
# Each run retains its own fixture, raw output and verdict, including failures.
out.mkdir(parents=True, exist_ok=False)
fixture = Path('tests/nodejs/upstream/constructor-name-reference-controls.js')
expectations = Path('tests/nodejs/upstream/constructor-name-reference-expectations.json')
prelude = """const print=console.log;
const __constructorName=require('internal/test/binding').internalBinding('util').getConstructorName;
const __foreignInstance=()=>require('node:vm').runInNewContext('new(class Foreign{})()');
const __collectConstructorGarbage=()=>gc();
"""
composed = out / 'native-fixture.cjs'
composed.write_text(prelude + fixture.read_text())
args = [str(native), '--no-node-snapshot', '--no-warnings',
        '--expose-internals', '--expose-gc', str(composed)]
record = {
    'schema': 1,
    'scope': 'Pinned native-reference contract only; no Kandelo runtime validation',
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'fixture': identity(fixture), 'expectations': identity(expectations),
    'runner': identity(Path(__file__)),
    'composedFixture': identity(composed), 'argv': args,
    'nativeIdentityVerifiedImmediatelyBeforeChild': False,
    'failures': [],
}
try:
    # This exact executable was authenticated against the recorded official
    # darwin-arm64 archive. Never execute a merely version-matching binary.
    actual = identity(native)
    record['candidateProgram'] = actual
    if actual['bytes'] != 147346864 or actual['sha256'] != '533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4':
        raise ValueError('native-reference identity does not match audited pin')
    record['program'] = actual
    record['nativeIdentityVerifiedImmediatelyBeforeChild'] = True
    result = subprocess.run(args, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'TZ': 'UTC'},
                            capture_output=True, text=True, timeout=45)
    record.update(exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr)
    if result.returncode != 0 or result.stderr:
        raise ValueError('native reference failed; raw output retained')
    detail = json.loads(result.stdout)
    want = json.loads(expectations.read_text())
    if detail['kind'] != want['kind'] or detail['cases'] != want['cases'] or want['cases'] != 40:
        raise ValueError('reference inventory mismatch')
    observed = [{'name': row['name'], 'result': row['result']}
                for row in detail['observations']]
    if observed != want['observations']:
        raise ValueError('reference result or case order changed')
    if any(row['calls'] != 0 or row['afterGC'] != row['result']
           for row in detail['observations']):
        raise ValueError('user code invoked or constructor identity changed after GC')
    record.update(detail=detail, groups=40, nameObservations=80,
                  kandeloRuntimeValidated=False, compactingCollectionProven=False)
except subprocess.TimeoutExpired as error:
    def decoded(value):
        return value.decode(errors='replace') if isinstance(value, bytes) else value
    record.update(exitCode=None, timedOut=True, timeoutSeconds=45,
                  stdout=decoded(error.stdout), stderr=decoded(error.stderr))
    record['failures'].append({'type': type(error).__name__, 'message': str(error)})
except Exception as error:
    record['failures'].append({'type': type(error).__name__, 'message': str(error)})
finally:
    (out / 'report.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'groups': record.get('groups'), 'failures': len(record['failures']),
                  'report': str(out / 'report.json')}))
if record['failures']:
    raise SystemExit(1)
