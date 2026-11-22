#!/usr/bin/env python3
"""Apply reviewed complete engine file diffs without the preserved shell frontend."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def apply(source, patch_directory, manifest, receipt, evidence=None):
    document = json.loads(manifest.read_text())
    if document['schema'] != 1:
        raise ValueError('unknown engine patch manifest schema')
    entries = document['patches']
    expected = [row['patch'] for row in entries]
    actual = [p.name for p in sorted(patch_directory.glob('*.patch'))]
    if expected != actual:
        raise ValueError('engine patch set changed; reconcile the complete manifest first')
    prepared = []
    # Validate the complete input set before mutating the source tree.
    for row in entries:
        path = patch_directory / row['patch']
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != row['sha256']:
            raise ValueError('engine patch identity changed: ' + path.name)
        text = data.decode()
        matches = list(re.finditer(r'^--- a/([^\n]+)\n\+\+\+ b/([^\n]+)\n', text, re.M))
        if len(matches) != len(row['sections']):
            raise ValueError('engine patch sections changed: ' + path.name)
        selected = []
        for index, (match, section) in enumerate(zip(matches, row['sections'])):
            name = section['path']
            if match[1] != name or match[2] != name or Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('invalid engine file section: ' + path.name)
            if type(section['include']) is not bool or not section['reason']:
                raise ValueError('missing engine section disposition: ' + path.name)
            if section['include']:
                end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
                selected.append(text[match.start():end])
        prepared.append((row, ''.join(selected).encode()))
    applied = []
    failures = []
    for row, data in prepared:
        names = [s['path'] for s in row['sections'] if s['include']]
        if data and evidence:
            for name in names:
                target = evidence / row['patch'] / 'before' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / name, target)
        diagnostic = ''
        code = 0
        if data:
            result = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(source)],
                                    input=data, capture_output=True)
            diagnostic = (result.stdout + result.stderr).decode()
            code = result.returncode
            print(diagnostic, end='')
            if result.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
                failures.append(row['patch'])
            if evidence:
                for name in names:
                    target = evidence / row['patch'] / 'after' / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source / name, target)
        applied.append({'patch': row['patch'], 'inputSha256': row['sha256'],
                        'engineSections': names, 'exit': code, 'diagnostic': diagnostic,
                        'projectedSha256': hashlib.sha256(data).hexdigest()})
    changed = sorted({name for row in applied for name in row['engineSections']})
    result = {'schema': 1, 'sourceArchiveSha256': document['sourceSha256'],
              'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
              'inputs': applied, 'engineFiles': [
                  {'path': name, 'sha256': hashlib.sha256((source / name).read_bytes()).hexdigest()}
                  for name in changed],
              'functionBodyExtraction': False, 'runtimeQualification': False,
              'failed': failures, 'sourceReady': not failures}
    receipt.write_text(json.dumps(result, indent=2) + '\n')
    if failures:
        raise ValueError('complete engine patch pass failed; source must not be built: ' + ', '.join(failures))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--patch-directory', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--evidence-directory', type=Path)
    args = parser.parse_args()
    apply(args.source.resolve(), args.patch_directory, args.manifest, args.receipt,
          args.evidence_directory)
