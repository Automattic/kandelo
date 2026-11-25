#!/usr/bin/env python3
"""Apply the complete production engine patch chains and record build provenance."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tomllib


def apply(source, package, receipt):
    metadata = tomllib.loads((package / 'package.toml').read_text())
    patches = [p for directory in ['base-patches', 'patches']
               for p in sorted((package / directory).glob('*.patch'))]
    applied, failures, changed = [], [], set()
    for patch in patches:
        data = patch.read_bytes()
        names = re.findall(r'^\+\+\+ b/([^\n]+)$', data.decode(), re.M)
        if not names or any(Path(n).is_absolute() or '..' in Path(n).parts for n in names):
            raise ValueError('invalid production engine patch: ' + str(patch))
        result = subprocess.run(['patch', '--batch', '-p1', '-F0', '-d', str(source)],
                                input=data, capture_output=True)
        diagnostic = (result.stdout + result.stderr).decode()
        print(diagnostic, end='')
        if result.returncode or re.search(r'fuzz|offset', diagnostic, re.I):
            failures.append(str(patch.relative_to(package)))
        changed.update(names)
        applied.append({'patch': str(patch.relative_to(package)),
                        'sha256': hashlib.sha256(data).hexdigest(),
                        'files': names, 'exit': result.returncode})
    document = {'schema': 1, 'sourceArchiveSha256': metadata['source']['sha256'],
                'inputs': applied, 'failed': failures, 'sourceReady': not failures,
                'engineFiles': [{'path': name,
                                 'sha256': hashlib.sha256((source / name).read_bytes()).hexdigest()}
                                for name in sorted(changed)]}
    receipt.write_text(json.dumps(document, indent=2) + '\n')
    if failures:
        raise ValueError('engine patches failed; source must not be built: ' + ', '.join(failures))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'package', 'receipt']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    apply(args.source.resolve(), args.package.resolve(), args.receipt)
