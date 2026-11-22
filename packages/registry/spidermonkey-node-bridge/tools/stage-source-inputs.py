#!/usr/bin/env python3
"""Stage verified Node inputs inside a package work directory, never the checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tomllib


def stage(source, manifest, output):
    source = source.resolve(strict=True)
    output = output.resolve()
    if output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('source and output must be disjoint')
    work = os.environ.get('WASM_POSIX_DEP_WORK_DIR')
    if work and not output.is_relative_to(Path(work).resolve(strict=True)):
        raise ValueError('output must be inside the package work directory')
    document = json.loads(manifest.read_bytes())
    package = tomllib.loads(manifest.with_name('package.toml').read_text())
    if (document['version'] != package['version'] or
            document['source']['sha256'] != package['source']['sha256'] or
            document['source']['url'] != package['source']['url']):
        raise ValueError('source metadata does not match the declared archive')
    files = []
    seen = set()
    for row in document['files']:
        relative = PurePosixPath(row['path'])
        if (relative.is_absolute() or '..' in relative.parts or
                relative.as_posix() != row['path'] or row['path'] in seen):
            raise ValueError('unsafe or duplicate source path: ' + row['path'])
        seen.add(row['path'])
        path = source
        for component in relative.parts:
            path = path / component
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ValueError('source inputs must be ordinary files/directories')
        if not stat.S_ISREG(mode) or path.stat().st_size != row['bytes']:
            raise ValueError('source size/type mismatch: ' + row['path'])
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != row['sha256']:
            raise ValueError('source digest mismatch: ' + row['path'])
        files.append((path, relative))
    # Retain the strict ordinary-file layout expected by the existing generators.
    # All copies are transient recipe inputs; upstream source is never vendored.
    output.mkdir(parents=True, exist_ok=False)
    for path, relative in files:
        target = output / 'upstream' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    for name in ['sources.json', 'target.json']:
        shutil.copyfile(manifest.with_name(name), output / name)
    shutil.copytree(Path(__file__).resolve().parents[1] / 'native-registry',
                    output / 'native')
    return {'version': document['version'], 'files': len(files),
            'archiveSha256': document['source']['sha256'], 'output': str(output)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.source, args.manifest, args.output)))
