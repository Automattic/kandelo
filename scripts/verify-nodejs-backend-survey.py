#!/usr/bin/env python3
"""Verify reproducible source indexes; this never validates guest execution."""
import argparse
from pathlib import Path
import datetime
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile


def identity(path):
    path = Path(path)
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('report', type=Path)
args = parser.parse_args()
work = Path(tempfile.mkdtemp(prefix='node-backend-survey.', dir='.scratch'))
root = Path('tests/nodejs/upstream')
runs = []
commands = [
    ['node', 'scripts/test-nodejs-dependency-graph.mjs', str(work/'javascript-controls.json')],
    [sys.executable, 'scripts/test-nodejs-native-registrations.py', str(work/'native-controls.json')],
    ['node', 'scripts/index-nodejs-dependency-graph.mjs', 'third_party/nodejs/sources.json',
     str(root/'dependency-dynamic-reviews.json'), str(work/'dependency-graph.json')],
    [sys.executable, 'scripts/index-nodejs-native-registrations.py', str(args.archive),
     'third_party/nodejs/sources.json', str(work/'native-registration-index.json')],
    [sys.executable, 'scripts/reconcile-nodejs-backend-survey.py', str(work/'backend-binding-survey.json')],
]
for command in commands:
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    runs.append({'argv': command, 'exitCode': result.returncode,
                 'stdout': result.stdout, 'stderr': result.stderr})
    if result.returncode:
        break
failures = []
if any(r['exitCode'] != 0 for r in runs):
    failures.append('index/control command failed; dependent comparisons not claimed')
else:
    for name in ['dependency-graph.json', 'native-registration-index.json', 'backend-binding-survey.json']:
        if (root/name).read_bytes() != (work/name).read_bytes():
            failures.append('canonical output is not reproducible: '+name)
controls = []
for name in ['javascript-controls.json', 'native-controls.json']:
    if (work/name).exists():
        data = json.loads((work/name).read_bytes())
        controls.extend(data['observations'])
        if data['failures']:
            failures.append('failed source-index controls: '+name)
manifest = json.loads(Path('third_party/nodejs/sources.json').read_bytes())
source_mismatches = []
for row in manifest['files']:
    actual = identity(Path('third_party/nodejs/upstream')/row['path'])
    if any(actual[key] != row[key] for key in ('bytes', 'sha256')):
        source_mismatches.append(row['path'])
if source_mismatches:
    failures.append('imported source identity mismatches: '+repr(source_mismatches))
mutation = {'status': 'not-run'}
if not failures:
    # A changed edge with unchanged totals/source-hash metadata must fail the
    # semantic multiset reconciliation. Mutate only a disposable fixture copy.
    copy = work/'mutated-canonical-inputs'
    shutil.copytree(root, copy)
    graph = json.loads((copy/'dependency-graph.json').read_bytes())
    site = next(s for s in graph['sites'] if s['phase'] == 'loader-call' and s['target'] == 'util')
    original = site['target']
    site['target'] = 'deliberate-unregistered-edge-mutation'
    (copy/'dependency-graph.json').write_text(json.dumps(graph))
    spec = importlib.util.spec_from_file_location('survey', 'scripts/reconcile-nodejs-backend-survey.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = copy
    try:
        module.reconcile()
    except AssertionError:
        mutation = {'status': 'pass', 'siteId': site['id'], 'originalTarget': original,
                    'primaryReferenceCountUnchanged': True,
                    'reason': 'same-count altered dependency rejected by reference-identity multiset'}
    else:
        failures.append('same-count altered dependency was accepted')
        mutation = {'status': 'fail'}
paths = [
    'scripts/index-nodejs-bindings.mjs', 'scripts/index-nodejs-dependency-graph.mjs',
    'scripts/index-nodejs-native-registrations.py', 'scripts/reconcile-nodejs-backend-survey.py',
    'scripts/test-nodejs-dependency-graph.mjs', 'scripts/test-nodejs-native-registrations.py',
    'scripts/verify-nodejs-backend-survey.py',
    'third_party/nodejs/sources.json', 'third_party/nodejs/target.json',
    'packages/registry/spidermonkey/node-upstream/realm.cpp',
    'docs/nodejs-upstream-runtime.md',
    *[p for p in ['package.json', 'package-lock.json', 'flake.nix', 'flake.lock']
      if Path(p).is_file()],
    *[str(root/name) for name in ['binding-index.json', 'backend-binding-reviews.json',
       'dependency-dynamic-reviews.json', 'dependency-graph.json', 'native-registration-index.json',
       'backend-binding-survey.json', 'backend-graph.md', 'implementation-ledger.json',
       'aliased-engine-check.json']],
]
record = {
    'schema': 1, 'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Authenticated source graph/native registration/dispatcher survey only; no new guest runtime, package build, startup or conformance evidence',
    'sourceHeadAtVerification': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'testedInputsWereUncommitted': True, 'work': str(work),
    'inputs': [identity(p) for p in paths], 'runs': runs,
    'controlGroups': len(controls), 'controlFailures': sum(c['status'] != 'pass' for c in controls),
    'sameCountMutationControl': mutation, 'failures': failures,
    'canonicalOutputsByteIdentical': not failures,
    'sourceIdentity': {'importedFiles': len(manifest['files']),
                       'javascriptFiles': sum(bool(row['builtinId']) for row in manifest['files']),
                       'javascriptBytes': sum(row['bytes'] for row in manifest['files'] if row['builtinId']),
                       'mismatches': source_mismatches},
    'sourceGraphCounts': json.loads((root/'dependency-graph.json').read_bytes())['counts'],
    'nativeRegistrationCounts': json.loads((root/'native-registration-index.json').read_bytes())['counts'],
    'surveyCounts': json.loads((root/'backend-binding-survey.json').read_bytes())['counts'],
    'initialFailuresRetained': [
        {'kind': 'indexer syntax error', 'input': '.context/node-backend-graph/index-first-syntax-error.mjs',
         'resolution': 'corrected return-object grouping before first generated graph'},
        {'kind': 'historical audit record schema mismatch', 'input': '.context/node-backend-graph/reconcile-first-schema-error.py',
         'log': '.context/node-backend-graph/reconcile-first.log',
         'resolution': 'normalize both head and headSha; all33actual identities remain required'},
    ],
    'runtimeCodeChanged': False, 'runtimeEvidenceAdded': False, 'startupAccepted': False,
    'completeNativeContractCatalog': False, 'broaderRoadmapExecutionAuthorized': False,
    'pendingArchitectureChoice': 'mksnapshot full native unit combines live APIs and V8 serialization; preserve pending user choice and original-source constraint',
    'remaining': ['genuine startup, empty/simple output/errors/jobs/exit and separate CJS/ESM on four hosts',
                  'full native export/class/member/signature/error/scheduling/ownership/lifecycle/owning-layer catalog',
                  'symbolic/alias/generated/build/native-transfer domains and per-host validation obligations',
                  'complete dependency-ordered implementation/validation roadmap, then explicit user review'],
    'notRun': ['guest runtime tests this source-only phase', 'package builds', 'full products/images',
               'successor ABI builds', 'overall conformance suites'],
}
args.report.write_text(json.dumps(record, indent=2)+'\n')
print(json.dumps({'commands': len(runs), 'controlGroups': len(controls),
                  'sameCountMutationControl': mutation['status'], 'failures': failures}))
raise SystemExit(1 if failures else 0)
