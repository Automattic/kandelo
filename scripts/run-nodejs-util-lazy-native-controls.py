"""Observe native lazy-data-property behavior; this is not a guest backend."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

if len(sys.argv) != 3:
    raise SystemExit('usage: run-nodejs-util-lazy-native-controls.py <authenticated-native-node> <report.json>')
program = Path(sys.argv[1]).resolve()
fixture = Path('tests/nodejs/upstream/util-lazy-properties-native-controls.cjs')
def identity(path):
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
native = identity(program)
assert native['bytes'] == 147346864 and native['sha256'] == '533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
flags = ['--no-warnings', '--no-node-snapshot', '--expose-internals']
environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'TZ': 'UTC'}
result = subprocess.run([str(program), *flags, str(fixture)], env=environment, capture_output=True, text=True, timeout=30)
report = {'scope': 'Native reference controls only; no guest lazy-property implementation or startup acceptance',
          'native': native, 'fixture': identity(fixture), 'flags': flags, 'environment': environment,
          'result': {'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}}
if result.returncode == 0:
    report['detail'] = json.loads(result.stdout)
Path(sys.argv[2]).write_text(json.dumps(report, indent=2) + '\n')
assert result.returncode == 0 and result.stderr == '' and report['detail']['cases'] == 7 and report['detail']['failures'] == 0
print(json.dumps({'nativeControls': 7, 'failures': 0, 'guestImplementationAdded': False}))
