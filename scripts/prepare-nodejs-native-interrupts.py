#!/usr/bin/env python3
"""Stage complete pinned sources and apply the native interrupt source patch."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def prepare(manifest, output, patch):
    document = json.loads(manifest.read_text())
    records = {row['path']: row for row in document['files']}
    if output.resolve().is_relative_to(manifest.parent.resolve()):
        raise ValueError('output must be outside the immutable Node import')
    sources = []
    for name in ['deps/v8/src/execution/isolate.cc', 'src/env.cc']:
        row = records[name]
        data = (manifest.parent / 'upstream' / name).read_bytes()
        if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
            raise ValueError('native interrupt source identity mismatch: ' + name)
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        sources.append({'path': name, 'sha256': row['sha256']})
    staged = output / 'deps/v8/src/execution/kandelo-native-interrupts.inc'
    # A previous work directory must not make an empty/broken patch appear to
    # have produced the required source output.
    staged.unlink(missing_ok=True)
    result = subprocess.run(
        ['patch', '--batch', '-p1', '-F0', '-d', str(output.resolve())],
        input=patch.read_bytes(), capture_output=True)
    diagnostic = (result.stdout + result.stderr).decode()
    if result.returncode or re.search(r'fuzz|offset', diagnostic, re.IGNORECASE):
        raise ValueError('native interrupt source patch failed: ' + diagnostic)
    if not staged.is_file():
        raise ValueError('native interrupt source patch did not produce its declared output')
    return {'sources': sources, 'maintainedSourcePatch': str(patch),
            'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
            'stagedQueueSha256': hashlib.sha256(staged.read_bytes()).hexdigest(),
            'wholeSourceInputs': True, 'functionBodyExtraction': False,
            'runtimeQualification': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--patch', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.output, args.patch)))
